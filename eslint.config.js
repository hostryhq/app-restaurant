import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
    },
  },
  {
    // Node scripts (bundle check).
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly" } },
    rules: { "no-console": "off" },
  },
  {
    // Solid's `let el!: T; <div ref={el}>` ref idiom is assigned by the compiler.
    files: ["**/*.tsx"],
    rules: { "no-unassigned-vars": "off" },
  },
);
