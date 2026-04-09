export default [
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off",
      "no-constant-condition": "warn",
      eqeqeq: "warn",
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
];
