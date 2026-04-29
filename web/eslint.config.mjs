import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const systemInvokerImportMessage =
  "systemInvoker.server may only be imported from web/lib/cortex/**, web/lib/jobs/**, or web/__tests__/**. " +
  "Use authorizedHandler for user-facing routes. Keep this rule in sync with scripts/check-system-invoker-callers.mjs.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Honor `_`-prefixed identifiers as intentionally unused.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // roost wave 5.10 — dev-time guard against logging auth tokens.
      // AST-based check flags `console.*(...)` calls whose arguments
      // include an identifier whose name matches common token/credential
      // shapes. The repo-wide scanner at `scripts/check-no-token-logs.mjs`
      // is the authoritative CI gate (catches python + template-literal
      // interpolation across files); this rule catches obvious cases in
      // the editor so they never reach CI. Exempt a line by appending
      // `// no-token-logs-allow` where a false positive is unavoidable.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='console'] Identifier[name=/^(token|tokens|bearer|authorization|accessToken|refreshToken|idToken|access_token|refresh_token|id_token|apiKey|api_key|clientSecret|client_secret|authCode|auth_code)$/i]",
          message:
            "Do not log auth tokens or credentials. Use a stable non-sensitive identifier (user id, site id, request id) instead. See `scripts/check-no-token-logs.mjs`.",
        },
      ],
    },
  },
  // security-boundary-migration wave 2.3 — editor-time import boundary
  // for system actors. The CI-time gate is
  // `scripts/check-system-invoker-callers.mjs`; update both together.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/systemInvoker.server",
              message: systemInvokerImportMessage,
            },
            {
              name: "@/lib/systemInvoker.server.ts",
              message: systemInvokerImportMessage,
            },
          ],
          patterns: [
            {
              group: [
                "**/lib/systemInvoker.server",
                "**/lib/systemInvoker.server.ts",
              ],
              message: systemInvokerImportMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "lib/cortex/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "lib/jobs/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "__tests__/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "lib/systemInvoker.server.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "coverage/**",
    "e2e/.output/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
