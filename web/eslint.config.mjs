import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
