import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'];
const cliTuiFiles = ['src/cli/**/*.{ts,tsx}'];
const runtimeFiles = ['src/runtime/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: ['node_modules', 'dist', 'coverage'],
  },
  {
    extends: [js.configs.recommended],
  },
  {
    files: typescriptFiles,
    extends: [...tseslint.configs.recommended],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.json', './tests/tsconfig.json'],
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
        },
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
    rules: {
      ...importPlugin.configs.recommended.rules,
      ...importPlugin.configs.typescript.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Allow Bun built-in modules (bun:test, bun:sqlite, etc.)
      'import/no-unresolved': [
        'error',
        {
          ignore: ['^bun:'],
        },
      ],
    },
  },
  {
    files: cliTuiFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/shared/imports/paths.js', '**/shared/imports/paths'],
              message: 'Use shared/imports/index.js instead - paths.js is @internal',
            },
            {
              group: ['**/shared/imports/registry.js', '**/shared/imports/registry'],
              message: 'Use shared/imports/index.js instead - registry.js is @internal',
            },
            {
              group: ['**/shared/imports/manifest.js', '**/shared/imports/manifest'],
              message: 'Use shared/imports/index.js instead - manifest.js is @internal',
            },
            {
              group: ['**/shared/imports/resolver.js', '**/shared/imports/resolver'],
              message: 'Use shared/imports/index.js instead - resolver.js is @internal',
            },
            {
              group: ['**/shared/imports/installer.js', '**/shared/imports/installer'],
              message: 'Use shared/imports/index.js instead - installer.js is @internal',
            },
            {
              group: ['**/shared/imports/auto-import.js', '**/shared/imports/auto-import'],
              message: 'Use shared/imports/index.js instead - auto-import.js is @internal',
            },
            {
              group: ['**/shared/imports/resolve.js', '**/shared/imports/resolve'],
              message: 'Use shared/imports/index.js instead - resolve.js is @internal',
            },
            {
              group: ['**/shared/imports/defaults.js', '**/shared/imports/defaults'],
              message: 'Use shared/imports/index.js instead - defaults.js is @internal',
            },
            {
              group: ['**/shared/imports/services/**'],
              message: 'Use shared/imports/index.js instead - services are @internal',
            },
          ],
        },
      ],
    },
  },
  {
    files: runtimeFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/shared/imports/paths.js', '**/shared/imports/paths'],
              message: 'Use shared/imports/index.js instead - paths.js is @internal',
            },
            {
              group: ['**/shared/imports/registry.js', '**/shared/imports/registry'],
              message: 'Use shared/imports/index.js instead - registry.js is @internal',
            },
            {
              group: ['**/shared/imports/manifest.js', '**/shared/imports/manifest'],
              message: 'Use shared/imports/index.js instead - manifest.js is @internal',
            },
            {
              group: ['**/shared/imports/resolver.js', '**/shared/imports/resolver'],
              message: 'Use shared/imports/index.js instead - resolver.js is @internal',
            },
            {
              group: ['**/shared/imports/installer.js', '**/shared/imports/installer'],
              message: 'Use shared/imports/index.js instead - installer.js is @internal',
            },
            {
              group: ['**/shared/imports/auto-import.js', '**/shared/imports/auto-import'],
              message: 'Use shared/imports/index.js instead - auto-import.js is @internal',
            },
            {
              group: ['**/shared/imports/resolve.js', '**/shared/imports/resolve'],
              message: 'Use shared/imports/index.js instead - resolve.js is @internal',
            },
            {
              group: ['**/shared/imports/defaults.js', '**/shared/imports/defaults'],
              message: 'Use shared/imports/index.js instead - defaults.js is @internal',
            },
            {
              group: ['**/shared/imports/services/**'],
              message: 'Use shared/imports/index.js instead - services are @internal',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
