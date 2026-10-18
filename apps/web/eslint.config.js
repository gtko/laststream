import globals from 'globals';

export default [
  {
    files: ['src/ui/**/*.js', 'src/player/**/*.js', 'src/sources/**/*.js', 'src/main.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-redeclare': 'error' },
  },
];
