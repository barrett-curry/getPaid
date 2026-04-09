import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DynamoDB ───
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: mockSend })) },
  GetCommand: vi.fn((params) => ({ ...params, _type: "Get" })),
  PutCommand: vi.fn((params) => ({ ...params, _type: "Put" })),
  QueryCommand: vi.fn((params) => ({ ...params, _type: "Query" })),
  UpdateCommand: vi.fn((params) => ({ ...params, _type: "Update" })),
  ScanCommand: vi.fn((params) => ({ ...params, _type: "Scan" })),
}));

const { handler } = await import("../index.mjs");

// ─── Helpers ───
function makeEvent({ path = "/transaction", method = "POST", body = {}, headers = {} }) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers,
    body: JSON.stringify(body),
  };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

// ─── CORS ───
describe("CORS preflight", () => {
  it("returns 200 OK for OPTIONS requests", async () => {
    const event = makeEvent({ method: "OPTIONS" });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});

// ─── Request Validation ───
describe("Request validation", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns 400 for malformed JSON body", async () => {
    const event = {
      rawPath: "/transaction",
      requestContext: { http: { method: "POST" } },
      headers: { "x-api-key": "test-key" },
      body: "not json",
    };
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("malformed JSON");
  });

  it("returns 400 when required fields are missing", async () => {
    const event = makeEvent({
      body: { clearinghouse_id: "ch-1" },
      headers: {},
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("missing required field");
  });

  it("returns 400 when amount is negative", async () => {
    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: -50,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("positive number");
  });

  it("returns 400 when amount is zero", async () => {
    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 0,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid transaction_type", async () => {
    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 100,
        transaction_type: "refund",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("transaction_type");
  });
});

// ─── Authentication ───
describe("Authentication", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns 401 when clearinghouse is not found", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-unknown",
        card_number: "4111111111111111",
        amount: 100,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "bad-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
    expect(parseBody(res).message).toContain("clearinghouse not found");
  });

  it("returns 401 when api key is invalid", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "correct-key", Status: "Active" },
    });

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 100,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "wrong-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
    expect(parseBody(res).message).toContain("invalid api key");
  });

  it("returns 401 when clearinghouse is revoked", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Revoked" },
    });

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 100,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
    expect(parseBody(res).message).toContain("revoked");
  });
});

// ─── Account Lookup ───
describe("Account lookup", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns 404 when card number is not found", async () => {
    // auth passes
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    // account not found
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "0000000000000000",
        amount: 100,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).message).toContain("card number does not match");
  });

  it("returns 403 when account is frozen", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: { CardNumber: "4111111111111111", Status: "frozen", AccountType: "debit" },
    });
    // logTransaction
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 100,
        transaction_type: "withdrawal",
        merchant_name: "Test Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).message).toContain("ACCOUNT_FROZEN");
  });
});

// ─── Withdrawals ───
describe("Debit withdrawals", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("approves a valid debit withdrawal", async () => {
    // auth
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    // getAccount
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "4111111111111111",
        Status: "active",
        AccountType: "debit",
        AvailableBalance: 1000,
        DailyTransactionLimit: 5000,
      },
    });
    // getDailyTotal query
    mockSend.mockResolvedValueOnce({ Items: [] });
    // updateBalance
    mockSend.mockResolvedValueOnce({});
    // logTransaction
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 200,
        transaction_type: "withdrawal",
        merchant_name: "Coffee Shop",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.message).toBe("APPROVED");
    expect(body.new_balance).toBe(800);
    expect(body.transaction_id).toBeDefined();
  });

  it("declines when insufficient funds", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "4111111111111111",
        Status: "active",
        AccountType: "debit",
        AvailableBalance: 50,
        DailyTransactionLimit: 5000,
      },
    });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 200,
        transaction_type: "withdrawal",
        merchant_name: "Coffee Shop",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).message).toContain("INSUFFICIENT_FUNDS");
  });

  it("declines when daily limit exceeded", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "4111111111111111",
        Status: "active",
        AccountType: "debit",
        AvailableBalance: 10000,
        DailyTransactionLimit: 1000,
      },
    });
    // daily total already at 900
    mockSend.mockResolvedValueOnce({ Items: [{ Amount: 900 }] });
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 200,
        transaction_type: "withdrawal",
        merchant_name: "Coffee Shop",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).message).toContain("DAILY_LIMIT_EXCEEDED");
  });
});

// ─── Credit Withdrawals ───
describe("Credit withdrawals", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("approves a valid credit withdrawal", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "5111111111111111",
        Status: "active",
        AccountType: "credit",
        CurrentBalance: 200,
        CreditLimit: 5000,
        DailyTransactionLimit: 5000,
      },
    });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "5111111111111111",
        amount: 300,
        transaction_type: "withdrawal",
        merchant_name: "Electronics Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.message).toBe("APPROVED");
    expect(body.new_balance).toBe(500);
  });

  it("declines when credit limit exceeded", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "5111111111111111",
        Status: "active",
        AccountType: "credit",
        CurrentBalance: 4900,
        CreditLimit: 5000,
        DailyTransactionLimit: 5000,
      },
    });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "5111111111111111",
        amount: 200,
        transaction_type: "withdrawal",
        merchant_name: "Electronics Store",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).message).toContain("CREDIT_LIMIT_EXCEEDED");
  });
});

// ─── Deposits ───
describe("Deposits", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("approves a debit deposit and increases balance", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "4111111111111111",
        Status: "active",
        AccountType: "debit",
        AvailableBalance: 500,
        DailyTransactionLimit: 5000,
      },
    });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "4111111111111111",
        amount: 300,
        transaction_type: "deposit",
        merchant_name: "Payroll",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.message).toBe("APPROVED");
    expect(body.new_balance).toBe(800);
  });

  it("approves a credit deposit and reduces owed balance", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "5111111111111111",
        Status: "active",
        AccountType: "credit",
        CurrentBalance: 1000,
        CreditLimit: 5000,
        DailyTransactionLimit: 5000,
      },
    });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "5111111111111111",
        amount: 400,
        transaction_type: "deposit",
        merchant_name: "Payment",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.message).toBe("APPROVED");
    expect(body.new_balance).toBe(600);
  });

  it("does not let credit balance go below zero on overpayment", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ClearinghouseId: "ch-1", ApiKey: "test-key", Status: "Active" },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        CardNumber: "5111111111111111",
        Status: "active",
        AccountType: "credit",
        CurrentBalance: 100,
        CreditLimit: 5000,
        DailyTransactionLimit: 5000,
      },
    });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      body: {
        clearinghouse_id: "ch-1",
        card_number: "5111111111111111",
        amount: 500,
        transaction_type: "deposit",
        merchant_name: "Overpayment",
      },
      headers: { "x-api-key": "test-key" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).new_balance).toBe(0);
  });
});

// ─── Audit Endpoint ───
describe("Audit endpoint", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns 400 for malformed JSON on /audit", async () => {
    const event = {
      rawPath: "/audit",
      requestContext: { http: { method: "POST" } },
      headers: {},
      body: "not json",
    };
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("malformed JSON");
  });

  it("returns 400 when url or audit_id is missing", async () => {
    const event = makeEvent({
      path: "/audit",
      body: { url: "https://example.com" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("missing url or audit_id");
  });
});

// ─── Routing ───
describe("Routing", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("routes /audit paths to audit handler", async () => {
    const event = makeEvent({
      path: "/audit",
      body: { audit_id: "aud-1" },
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toContain("missing url or audit_id");
  });

  it("routes /transaction paths to transaction handler", async () => {
    const event = makeEvent({
      path: "/transaction",
      body: {},
      headers: {},
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });
});
