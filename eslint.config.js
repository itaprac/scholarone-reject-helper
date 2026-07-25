export default [
  {
    files: ["src/**/*.js", "test/**/*.js", "scripts/**/*.js", "bin/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly" },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "off",
      "prefer-const": "warn",
      "no-var": "error",
      eqeqeq: ["warn", "smart"],
    },
  },
  {
    files: ["ui/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { document: "readonly", window: "readonly", fetch: "readonly", setInterval: "readonly", clearInterval: "readonly", alert: "readonly", confirm: "readonly", localStorage: "readonly", EventSource: "readonly" },
    },
    rules: { "no-var": "error", "prefer-const": "warn" },
  },
];
