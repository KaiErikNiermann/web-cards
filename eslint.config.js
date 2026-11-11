import css from "@eslint/css";
import js from "@eslint/js";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig } from "eslint/config";
import globals from "globals";
import { tailwind4 } from "tailwind-csstree";
import tseslint from "typescript-eslint";

const TS_FILES = ["**/*.ts"];

export default defineConfig([
  { ignores: ["dist/**", "node_modules/**", ".lint/**", ".scratch/**"] },
  {
    files: TS_FILES,
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      sonarjs.configs.recommended,
      unicorn.configs.recommended,
      security.configs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Short physics names (p, dx, vx) mirror the equations they implement.
      "unicorn/name-replacements": "off",
      // TSDoc keeps `/** one line */` and leading asterisks; these two unicorn rules undo both.
      "unicorn/single-line-block-comment-style": "off",
      "unicorn/no-asterisk-prefix-in-documentation-comments": "off",
      // Private helpers sit next to the public method they serve, not in a block above it.
      "unicorn/consistent-class-member-order": "off",
      // Card ids index plain records built from static data, never user input.
      "security/detect-object-injection": "off",
    },
  },
  {
    files: ["**/*.css"],
    language: "css/css",
    plugins: { css },
    extends: ["css/recommended"],
    languageOptions: { customSyntax: tailwind4 },
    rules: {
      "css/use-baseline": [
        "error",
        {
          available: "newly",
          // Both degrade harmlessly: Safari ignores unprefixed user-select (mouse drags already
          // preventDefault), and the suits carry U+FE0E to ask for text presentation anyway.
          allowProperties: ["user-select", "font-variant-emoji"],
        },
      ],
      "css/no-important": "error",
      "css/prefer-logical-properties": "error",
      "css/use-layers": ["error", { requireImportLayers: false }],
      "css/selector-complexity": ["error", { maxCompounds: 2, maxTypes: 1 }],
      "css/no-invalid-properties": ["error", { allowUnknownVariables: true }],
      "css/no-duplicate-imports": "error",
      "css/relative-font-units": ["error", { allowUnits: ["rem"] }],
      "css/font-family-fallbacks": "error",
    },
  },
]);
