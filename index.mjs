import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// ─── Table Names (match what you created in DynamoDB) ───
const CLEARINGHOUSES_TABLE = "clearinghouses";
const ACCOUNTS_TABLE = "accounts";
const TRANSACTIONS_TABLE = "transactions";

// ─── Helper: format response ───
function respond(statusCode, message, data = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    },
    body: JSON.stringify({ message, ...data }),
  };
}

// ─── Auth: verify clearinghouse credentials ───
async function authenticateClearinghouse(clearinghouse_id, api_key) {
  if (!clearinghouse_id || !api_key) {
    return { authenticated: false, reason: "missing credentials" };
  }

  try {
    const resp = await docClient.send(
      new GetCommand({
        TableName: CLEARINGHOUSES_TABLE,
        Key: { ClearinghouseId: clearinghouse_id },
      })
    );

    if (!resp.Item) {
      return { authenticated: false, reason: "clearinghouse not found" };
    }
    if (resp.Item.ApiKey !== api_key) {
      return { authenticated: false, reason: "invalid api key" };
    }
    if (resp.Item.Status !== "Active") {
      return { authenticated: false, reason: "clearinghouse access has been revoked" };
    }

    return { authenticated: true, clearinghouse: resp.Item };
  } catch (err) {
    console.error("Auth error:", err);
    return { authenticated: false, reason: "authentication service error" };
  }
}

// ─── Look up account by card number ───
async function getAccount(card_number) {
  const resp = await docClient.send(
    new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { CardNumber: card_number },
    })
  );
  return resp.Item || null;
}

// ─── Get today's approved transaction total for a card ───
async function getDailyTotal(card_number) {
  const today = new Date().toISOString().split("T")[0];
  const startOfDay = `${today}T00:00:00Z`;
  const endOfDay = `${today}T23:59:59Z`;

  const resp = await docClient.send(
    new QueryCommand({
      TableName: TRANSACTIONS_TABLE,
      KeyConditionExpression:
        "CardNumber = :cn AND TransactionTimestamp BETWEEN :start AND :end",
      FilterExpression: "Decision = :approved AND TransactionType = :withdrawal",
      ExpressionAttributeValues: {
        ":cn": card_number,
        ":start": startOfDay,
        ":end": endOfDay,
        ":approved": "APPROVED",
        ":withdrawal": "withdrawal",
      },
    })
  );

  let total = 0;
  if (resp.Items) {
    for (const txn of resp.Items) {
      total += txn.Amount;
    }
  }
  return total;
}

// ─── Log transaction to Transactions table ───
async function logTransaction({
  transaction_id,
  card_number,
  amount,
  transaction_type,
  decision,
  reason,
  merchant_name,
  clearinghouse_id,
  api_key,
}) {
  const timestamp = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: TRANSACTIONS_TABLE,
      Item: {
        CardNumber: card_number,
        TransactionTimestamp: timestamp,
        TransactionId: transaction_id,
        Amount: amount,
        TransactionType: transaction_type,
        Decision: decision,
        Reason: reason || "",
        MerchantName: merchant_name,
        ClearinghouseId: clearinghouse_id,
        AuthToken: api_key,
      },
    })
  );

  return timestamp;
}

// ─── Process a withdrawal ───
async function processWithdrawal(account, body, api_key, clearinghouse_id) {
  const { card_number, amount, transaction_type, merchant_name } = body;
  const transaction_id = crypto.randomUUID();
  const logParams = {
    transaction_id,
    card_number,
    amount,
    transaction_type,
    merchant_name,
    clearinghouse_id,
    api_key,
  };

  // check daily limit
  const dailyTotal = await getDailyTotal(card_number);
  if (dailyTotal + amount > account.DailyTransactionLimit) {
    await logTransaction({ ...logParams, decision: "DECLINED", reason: "DAILY_LIMIT_EXCEEDED" });
    return respond(403, "DECLINED - DAILY_LIMIT_EXCEEDED", {
      card_number,
      amount,
      transaction_type,
    });
  }

  if (account.AccountType === "debit") {
    // check sufficient funds
    if (amount > account.AvailableBalance) {
      await logTransaction({ ...logParams, decision: "DECLINED", reason: "INSUFFICIENT_FUNDS" });
      return respond(403, "DECLINED - INSUFFICIENT_FUNDS", {
        card_number,
        amount,
        transaction_type,
      });
    }

    // deduct from balance
    const new_balance = account.AvailableBalance - amount;
    await docClient.send(
      new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { CardNumber: card_number },
        UpdateExpression: "SET AvailableBalance = :bal",
        ExpressionAttributeValues: { ":bal": new_balance },
      })
    );

    await logTransaction({ ...logParams, decision: "APPROVED", reason: "" });
    return respond(200, "APPROVED", {
      transaction_id,
      card_number,
      amount,
      transaction_type,
      new_balance,
    });
  } else {
    // credit account — check credit limit
    const newOwed = account.CurrentBalance + amount;
    if (newOwed > account.CreditLimit) {
      await logTransaction({
        ...logParams,
        decision: "DECLINED",
        reason: "CREDIT_LIMIT_EXCEEDED",
      });
      return respond(403, "DECLINED - CREDIT_LIMIT_EXCEEDED", {
        card_number,
        amount,
        transaction_type,
      });
    }

    // add to owed balance
    await docClient.send(
      new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { CardNumber: card_number },
        UpdateExpression: "SET CurrentBalance = :bal",
        ExpressionAttributeValues: { ":bal": newOwed },
      })
    );

    await logTransaction({ ...logParams, decision: "APPROVED", reason: "" });
    return respond(200, "APPROVED", {
      transaction_id,
      card_number,
      amount,
      transaction_type,
      new_balance: newOwed,
    });
  }
}

// ─── Process a deposit ───
async function processDeposit(account, body, api_key, clearinghouse_id) {
  const { card_number, amount, transaction_type, merchant_name } = body;
  const transaction_id = crypto.randomUUID();
  const logParams = {
    transaction_id,
    card_number,
    amount,
    transaction_type,
    merchant_name,
    clearinghouse_id,
    api_key,
    decision: "APPROVED",
    reason: "",
  };

  if (account.AccountType === "debit") {
    // add to available balance
    const new_balance = account.AvailableBalance + amount;
    await docClient.send(
      new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { CardNumber: card_number },
        UpdateExpression: "SET AvailableBalance = :bal",
        ExpressionAttributeValues: { ":bal": new_balance },
      })
    );

    await logTransaction(logParams);
    return respond(200, "APPROVED", {
      transaction_id,
      card_number,
      amount,
      transaction_type,
      new_balance,
    });
  } else {
    // credit account — deposit reduces what's owed (like a payment)
    const new_balance = Math.max(0, account.CurrentBalance - amount);
    await docClient.send(
      new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { CardNumber: card_number },
        UpdateExpression: "SET CurrentBalance = :bal",
        ExpressionAttributeValues: { ":bal": new_balance },
      })
    );

    await logTransaction(logParams);
    return respond(200, "APPROVED", {
      transaction_id,
      card_number,
      amount,
      transaction_type,
      new_balance,
    });
  }
}

// ─── Fetch with timeout helper ───
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Handle Audit Request ───
async function handleAudit(event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, "Bad Request - malformed JSON body");
  }

  const { url, audit_id, audit_fields, contact_info } = body;

  if (!url || !audit_id) {
    return respond(400, "Bad Request - missing url or audit_id");
  }

  console.log("sending to Audit url", url);

  // ─── Gather audit data from DynamoDB ───
  try {
    // Scan accounts table
    const accountsResp = await docClient.send(
      new ScanCommand({ TableName: ACCOUNTS_TABLE })
    );
    const accounts = accountsResp.Items || [];

    // Scan transactions table
    const transactionsResp = await docClient.send(
      new ScanCommand({ TableName: TRANSACTIONS_TABLE })
    );
    const transactions = transactionsResp.Items || [];

    // Compute audit fields
    const num_accounts = accounts.length;
    const total_balance = accounts.reduce((sum, a) => {
      if (a.AccountType === "debit") return sum + (parseFloat(a.AvailableBalance) || 0);
      return sum + (parseFloat(a.CurrentBalance) || 0);
    }, 0);
    const num_transactions = transactions.length;
    const num_deposits = transactions.filter(t => t.TransactionType === "deposit").length;
    const num_withdrawals = transactions.filter(t => t.TransactionType === "withdrawal").length;
    const num_credit_txns = transactions.filter(t => {
      const acct = accounts.find(a => a.CardNumber === t.CardNumber);
      return acct && acct.AccountType === "credit";
    }).length;

    // Build the audit payload
    const auditPayload = {
      audit_id,
      bank_name: "CaliBear Credit Union",
      num_accounts,
      total_balance: total_balance.toFixed(2),
      num_transactions,
      num_deposits,
      num_withdrawals,
      num_credit_txns,
      contact_info: contact_info || "barrett@calibear.credit",
    };

    console.log(JSON.stringify(auditPayload, null, 2));

    // ─── Send with exponential backoff: 4 attempts, waits of 2s, 4s, 8s ───
    const maxAttempts = 4;
    const baseWait = 2000; // 2 seconds
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Audit attempt ${attempt} of ${maxAttempts}`);
        const resp = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(auditPayload),
          },
          10000 // 10 second timeout per request
        );

        const respText = await resp.text();
        console.log(`response: status:${resp.status} - ${respText}`);

        if (resp.ok) {
          return respond(200, `Audit successfully sent - Received: ${resp.status} OK - ${respText} - CaliBear Credit Union`);
        }

        lastError = `HTTP ${resp.status}: ${respText}`;
        console.log(`Attempt ${attempt} failed: ${lastError}`);
      } catch (err) {
        lastError = err.name === "AbortError" ? "Request timed out" : err.message;
        console.log(`Attempt ${attempt} failed: ${lastError}`);
      }

      // Wait with exponential backoff before next attempt (skip wait after last attempt)
      if (attempt < maxAttempts) {
        const waitMs = baseWait * Math.pow(2, attempt - 1); // 2s, 4s, 8s
        console.log(`Waiting ${waitMs / 1000} seconds before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    return respond(502, `Audit failed after ${maxAttempts} attempts - last error: ${lastError}`);
  } catch (err) {
    console.error("Audit error:", err);
    return respond(500, "Internal Server Error - audit could not be processed");
  }
}

// ─── Handle Transaction Request ───
async function handleTransaction(event) {
  // 1. parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, "Bad Request - malformed JSON body");
  }

  // 2. extract api key from header, everything else from body
  const api_key = event.headers?.["x-api-key"] || event.headers?.["X-Api-Key"];
  const { clearinghouse_id, card_number, amount, transaction_type, merchant_name } = body;

  // 3. validate required fields
  const missing = [];
  if (!api_key) missing.push("x-api-key (header)");
  if (!clearinghouse_id) missing.push("clearinghouse_id");
  if (!card_number) missing.push("card_number");
  if (amount === undefined || amount === null) missing.push("amount");
  if (!transaction_type) missing.push("transaction_type");
  if (!merchant_name) missing.push("merchant_name");

  if (missing.length > 0) {
    return respond(400, `Bad Request - missing required field(s): ${missing.join(", ")}`);
  }

  // 4. validate amount
  if (typeof amount !== "number" || amount <= 0) {
    return respond(400, "Bad Request - amount must be a positive number greater than 0");
  }

  // 5. validate transaction_type
  if (!["withdrawal", "deposit"].includes(transaction_type)) {
    return respond(400, 'Bad Request - transaction_type must be "withdrawal" or "deposit"');
  }

  // 6. authenticate clearinghouse
  const auth = await authenticateClearinghouse(clearinghouse_id, api_key);
  if (!auth.authenticated) {
    return respond(401, `Unauthorized - ${auth.reason}`);
  }

  // 7. look up account
  let account;
  try {
    account = await getAccount(card_number);
  } catch (err) {
    console.error("Account lookup error:", err);
    return respond(500, "Internal Server Error - could not look up account");
  }

  if (!account) {
    return respond(404, "Not Found - card number does not match any account");
  }

  // 8. check account status
  if (account.Status !== "active") {
    const reason = `ACCOUNT_${account.Status.toUpperCase()}`;
    await logTransaction({
      transaction_id: crypto.randomUUID(),
      card_number,
      amount,
      transaction_type,
      decision: "DECLINED",
      reason,
      merchant_name,
      clearinghouse_id,
      api_key,
    });
    return respond(403, `DECLINED - ${reason}`, {
      card_number,
      amount,
      transaction_type,
    });
  }

  // 9. route to withdrawal or deposit logic
  try {
    if (transaction_type === "withdrawal") {
      return await processWithdrawal(account, body, api_key, clearinghouse_id);
    } else {
      return await processDeposit(account, body, api_key, clearinghouse_id);
    }
  } catch (err) {
    console.error("Transaction processing error:", err);
    return respond(500, "Internal Server Error - transaction could not be processed");
  }
}

// ═══════════════════════════════════════════════
//  MAIN HANDLER — routes by path
// ═══════════════════════════════════════════════
export const handler = async (event) => {
  const path = event.rawPath || event.path || "";
  const method = event.requestContext?.http?.method || event.httpMethod || "";

  console.log("PATH:", path);
  console.log("METHOD:", method);

  // handle CORS preflight
  if (method === "OPTIONS") {
    return respond(200, "OK");
  }

  // Route: /audit
  if (path.includes("/audit")) {
    return await handleAudit(event);
  }

  // Route: /transaction (default)
  return await handleTransaction(event);
};