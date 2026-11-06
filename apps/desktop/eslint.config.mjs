// @ts-check
import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 与仓库其它包一致：禁用显式 any（含测试）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // 界面文案一律走 i18n 字典（src/shared/i18n），renderer 代码里不许再写中文字面量（注释不受影响）
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['JSXText', 'Literal', 'TemplateElement'].map((node) => ({
          selector: `${node}[${node === 'TemplateElement' ? 'value.raw' : 'value'}=/[\\u3400-\\u9fff]/]`,
          message: '界面文案放进 src/shared/i18n 字典，用 t() 取（给模型看的文字除外，需就地注明）',
        })),
      ],
    },
  },
  {
    // 原样拷自 apps/frontend 的聊天 / MCP 组件：保持与 Web 逐行一致便于同步，lint 口径跟随 Web
    // （eslint-config-next/typescript，不开 type-checked 规则）。no-explicit-any 仍然是 error。
    files: [
      'src/renderer/src/features/chat/lib/thread.ts',
      'src/renderer/src/components/mcp/mcp-app-card.tsx',
    ],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
