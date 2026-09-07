const browserGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  Bun: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  document: "readonly",
  fetch: "readonly",
  localStorage: "readonly",
  MediaSource: "readonly",
  performance: "readonly",
  process: "readonly",
  requestAnimationFrame: "readonly",
  Response: "readonly",
  sessionStorage: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  TextDecoder: "readonly",
  URL: "readonly",
  window: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/b/**",
      "services/**/target/**",
      "src/b/**",
      "vendor/**",
      "filter-check/.local/**",
      "filter-check/runs/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
];
