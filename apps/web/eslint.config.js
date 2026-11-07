import globals from 'globals';

// LAST-120 : aucun contenu non littéral ne doit atteindre innerHTML / outerHTML / insertAdjacentHTML sans échappement.
// Règle active partout ; sites hérités gelés par fichier dans eslint-suppressions.json ; tout nouveau site échoue en CI ; le compte ne peut que baisser.
// Gel initial : `npx eslint src --suppress-rule no-restricted-syntax`. Après des corrections, réduire le gel : `npx eslint src --prune-suppressions`.
// Une exception ponctuelle se justifie par un commentaire `// eslint-disable-next-line no-restricted-syntax -- échappé par escapeHtml` (src/data/format.ts).

const NO_HTML_SINK = [
  {
    selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]:not([right.type='Literal'])",
    message: 'Affectation HTML non littérale : utiliser textContent ou l’API DOM, ou échapper avec escapeHtml (src/data/format.ts) et justifier par un eslint-disable.',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'insertAdjacentHTML : utiliser l’API DOM, ou échapper avec escapeHtml (src/data/format.ts) et justifier par un eslint-disable.',
  },
];

export default [
  { ignores: ['archive/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-redeclare': 'error' },
  },
  {
    files: ['src/**/*.js'],
    rules: { 'no-restricted-syntax': ['error', ...NO_HTML_SINK] },
  },
];
