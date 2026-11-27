import globals from 'globals';

// LAST-120 : aucun contenu non littéral ne doit atteindre innerHTML / outerHTML / insertAdjacentHTML sans échappement.
// Règle active partout ; sites hérités gelés par fichier dans eslint-suppressions.json (règle laststream/no-html-sink) ; tout nouveau site échoue en CI ; le compte ne peut que baisser.
// Gel initial : `npx eslint src --suppress-rule laststream/no-html-sink`. Après des corrections, réduire le gel : `npx eslint src --prune-suppressions`.
// Une exception ponctuelle se justifie par un commentaire `// eslint-disable-next-line laststream/no-html-sink -- échappé par escapeHtml` (src/data/format.ts).

/** Valeur sûre pour un puits HTML : littéraux, textes traduits t()/tc()/tn() sans paramètres (catalogues du dépôt, sans balise
 * ajoutée : vérifié par scripts/i18n.mjs check), leurs concaténations et alternatives. Tout le reste reste signalé. */
const T_CALLEES = /^(t|tr|tx|tc|tn|tnx)$/;
function isStaticHtml(n) {
  if (!n) return false;
  switch (n.type) {
    case 'Literal': return true;
    case 'TemplateLiteral': return n.expressions.length === 0;
    case 'BinaryExpression': return n.operator === '+' && isStaticHtml(n.left) && isStaticHtml(n.right);
    case 'ConditionalExpression': return isStaticHtml(n.consequent) && isStaticHtml(n.alternate);
    case 'CallExpression':
      return n.callee.type === 'Identifier' && T_CALLEES.test(n.callee.name) && n.callee.name !== 'tn' && n.callee.name !== 'tnx' &&
        n.arguments.length >= 1 && n.arguments.every((a) => a.type === 'Literal');
    default: return false;
  }
}

// LAST-120 + LAST-1658 : même contrôle que l'ancien no-restricted-syntax, en acceptant les textes traduits statiques.
const htmlSinkRule = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    return {
      AssignmentExpression(node) {
        const prop = node.left.type === 'MemberExpression' && !node.left.computed ? node.left.property.name : '';
        if ((prop === 'innerHTML' || prop === 'outerHTML') && !isStaticHtml(node.right)) {
          context.report({ node, message: 'Affectation HTML non littérale : utiliser textContent ou l’API DOM, ou échapper avec escapeHtml (src/data/format.ts) et justifier par un eslint-disable.' });
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'insertAdjacentHTML') {
          context.report({ node, message: 'insertAdjacentHTML : utiliser l’API DOM, ou échapper avec escapeHtml (src/data/format.ts) et justifier par un eslint-disable.' });
        }
      },
    };
  },
};

export default [
  { ignores: ['archive/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-redeclare': 'error' },
  },
  {
    files: ['src/**/*.js'],
    plugins: { laststream: { rules: { 'no-html-sink': htmlSinkRule } } },
    rules: { 'laststream/no-html-sink': 'error' },
  },
];
