// @ts-check
// 共享包的 lint 口径：与 apps/frontend（eslint-config-next/typescript）同级的 TS 规则 + react-hooks v7 推荐规则
// （含 set-state-in-effect / refs 等 error 级规则），不依赖 Next。
import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["eslint.config.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 界面文案一律走 src/i18n/messages.ts 字典（useCanvasT），组件里不许再写中文字面量（注释不受影响）
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/i18n/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["JSXText", "Literal", "TemplateElement"].map((node) => ({
          selector: `${node}[${node === "TemplateElement" ? "value.raw" : "value"}=/[\\u3400-\\u9fff]/]`,
          message: "界面文案放进 src/i18n/messages.ts 字典，用 useCanvasT() 取",
        })),
      ],
    },
  },
);
