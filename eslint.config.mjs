import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    // Production code must not log plaintext bodies or key material.
    files: ['frontend/**/*.{ts,tsx}', 'backend/src/**/*.ts', 'packages/*/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['**/tests/**', 'tests/**', '**/scripts/**', '**/*.config.*'],
    rules: { 'no-console': 'off' },
  },
);
