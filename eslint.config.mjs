import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import eslintConfigPrettier from 'eslint-config-prettier'

export default defineConfig(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  eslintConfigPrettier,
  {
    files: ['**/*.ts'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-undef': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-order': ['error', { order: ['template', 'script', 'style'] }],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'interface', format: ['PascalCase'], prefix: ['I'] },
        { selector: 'enum', format: ['PascalCase'], prefix: ['E'] },
        { selector: 'typeAlias', format: ['PascalCase'], prefix: ['T'] },
      ],
    },
  },
  {
    // The whole server is async over a driver abstraction; a missed await is
    // a silent bug (a Promise serialized as {}). Enforce mechanically.
    files: ['server/**/*.ts', 'importers/**/*.ts', 'shared/**/*.ts'],
    ignores: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
    },
  },
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      'docs/.vitepress/**',
      'data/',
      '*.js',
      '*.mjs',
    ],
  },
)
