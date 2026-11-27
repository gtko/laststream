#!/usr/bin/env node
/*
 * Catalogues de traduction de l'interface (LAST-1658). Voir src/i18n/index.ts et docs/i18n.md.
 *
 *   node scripts/i18n.mjs extract          relève les textes de src/ (appels t, tc, tn à argument littéral) et de index.html,
 *                                          écrit src/i18n/messages.json (clé → fichiers) ; signale les appels non littéraux
 *   node scripts/i18n.mjs check [codes…]   compare chaque catalogue src/i18n/locales/<code>.json aux clés relevées :
 *                                          manquantes, obsolètes, {paramètres} différents, balises HTML ajoutées.
 *                                          Échoue (code 1) sur une erreur, ou sur une clé manquante dans un catalogue
 *                                          listé dans REQUIRED (complet obligatoire).
 *   node scripts/i18n.mjs prune [codes…]   retire des catalogues les clés obsolètes.
 *   node scripts/i18n.mjs todo <code>      écrit sur la sortie les clés manquantes de <code> ({ clé: "" }), à traduire.
 *
 * Clés : texte français ; contexte tc(ctx, src) → « ctx\u0004src » ; pluriel tn(n, one, other) → « one\u0005other »,
 * dont la valeur est un objet { one, few, many, other… }.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const LOCALES_DIR = join(SRC, 'i18n', 'locales');
const MESSAGES = join(SRC, 'i18n', 'messages.json');
const CTX = '\u0004';
const PLURAL = '\u0005';
/** Catalogues qui doivent couvrir toutes les clés (la CI échoue sinon). */
const REQUIRED = ['en'];
/** Attributs traduits dans index.html (voir src/i18n/dom.ts). */
const HTML_ATTRS = ['aria-label', 'data-tip', 'title', 'placeholder', 'alt', 'content'];

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === 'locales' ? [] : walk(p);
  return /\.(js|ts)$/.test(f) && !/\.(test|spec)\.[jt]s$/.test(f) && !f.endsWith('.d.ts') ? [p] : [];
});

const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

function extract() {
  const keys = new Map();
  const warnings = [];
  const add = (key, file) => {
    if (!keys.has(key)) keys.set(key, new Set());
    keys.get(key).add(file);
  };
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    if (!/\b(t|tc|tn)\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'tc', 'tn'].includes(node.expression.text)) {
        const name = node.expression.text;
        const a = node.arguments;
        const where = rel + ':' + (sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
        if (name === 't' && a.length >= 1) {
          const k = literal(a[0]);
          if (k !== null) add(k, rel); else warnings.push(where + ' : t() sans texte littéral');
        } else if (name === 'tc' && a.length >= 2) {
          const c = literal(a[0]);
          const k = literal(a[1]);
          if (c !== null && k !== null) add(c + CTX + k, rel); else warnings.push(where + ' : tc() sans texte littéral');
        } else if (name === 'tn' && a.length >= 3) {
          const one = literal(a[1]);
          const other = literal(a[2]);
          if (one !== null && other !== null) add(one + PLURAL + other, rel); else warnings.push(where + ' : tn() sans texte littéral');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const k of htmlKeys()) add(k, 'index.html');
  const out = {};
  for (const k of [...keys.keys()].sort()) out[k] = [...keys.get(k)].sort();
  writeFileSync(MESSAGES, JSON.stringify(out, null, 1) + '\n');
  for (const w of warnings) console.warn('attention : ' + w);
  console.log(Object.keys(out).length + ' clés → ' + relative(ROOT, MESSAGES));
}

/** Textes de index.html traduits au démarrage par src/i18n/dom.ts : nœuds de texte et attributs HTML_ATTRS. */
function htmlKeys() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  const out = new Set();
  const decode = (s) => s.replace(/&rsquo;/g, '’').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&times;/g, '×');
  const keep = (s) => /\p{L}{2,}/u.test(s);
  for (const m of html.matchAll(/>([^<]+)</g)) {
    const s = decode(m[1]).trim().replace(/\s+/g, ' ');
    if (s && keep(s)) out.add(s);
  }
  for (const m of html.matchAll(/\s([a-z-]+)="([^"]*)"/g)) {
    if (!HTML_ATTRS.includes(m[1])) continue;
    if (m[1] === 'content' && !/name="description"/.test(html.slice(Math.max(0, m.index - 60), m.index))) continue;
    const s = decode(m[2]).trim();
    if (s && keep(s)) out.add(s);
  }
  return out;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const params = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...String(s).matchAll(/<\/?[a-z][^>]*>/gi)].length;
const codesOf = (args) => (args.length ? args : readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));

function check(args) {
  const messages = readJson(MESSAGES);
  const keys = Object.keys(messages);
  let failed = false;
  for (const code of codesOf(args)) {
    const p = join(LOCALES_DIR, code + '.json');
    if (!existsSync(p)) { console.error(code + ' : catalogue absent'); failed = true; continue; }
    const cat = readJson(p);
    const missing = keys.filter((k) => cat[k] === undefined || cat[k] === '');
    const obsolete = Object.keys(cat).filter((k) => !(k in messages));
    const errors = [];
    for (const k of keys) {
      const v = cat[k];
      if (v === undefined || v === '') continue;
      const isPlural = k.includes(PLURAL);
      const src = isPlural ? k.split(PLURAL)[1] : k.split(CTX).pop();
      if (isPlural !== (typeof v === 'object')) { errors.push('forme ' + (isPlural ? 'plurielle attendue' : 'simple attendue') + ' : ' + JSON.stringify(k)); continue; }
      const forms = typeof v === 'object' ? Object.values(v) : [v];
      if (typeof v === 'object' && !v.other) errors.push('pluriel sans « other » : ' + JSON.stringify(k));
      const want = params(src);
      for (const f of forms) {
        const got = params(f);
        // Un pluriel peut omettre {n} à la forme « one » (« un titre »).
        if (got !== want && !(isPlural && want.split(',').filter((x) => x !== 'n').join(',') === got.split(',').filter((x) => x !== 'n').join(',')))
          errors.push('paramètres {' + want + '} ≠ {' + got + '} : ' + JSON.stringify(k));
        if (tags(f) > tags(src)) errors.push('balise HTML ajoutée : ' + JSON.stringify(k));
      }
    }
    const required = REQUIRED.includes(code);
    console.log(code + ' : ' + (keys.length - missing.length) + '/' + keys.length + ' traduites' +
      (missing.length ? ', ' + missing.length + ' manquantes' : '') + (obsolete.length ? ', ' + obsolete.length + ' obsolètes' : '') +
      (errors.length ? ', ' + errors.length + ' erreurs' : ''));
    for (const e of errors.slice(0, 50)) console.error('  ' + code + ' : ' + e);
    if (required && missing.length) for (const k of missing.slice(0, 30)) console.error('  manquante : ' + JSON.stringify(k));
    if (errors.length || (required && missing.length)) failed = true;
  }
  if (failed) process.exit(1);
}

function prune(args) {
  const messages = readJson(MESSAGES);
  for (const code of codesOf(args)) {
    const p = join(LOCALES_DIR, code + '.json');
    const cat = readJson(p);
    const out = {};
    for (const k of Object.keys(cat).sort()) if (k in messages) out[k] = cat[k];
    writeFileSync(p, JSON.stringify(out, null, 1) + '\n');
  }
}

function todo([code]) {
  const messages = readJson(MESSAGES);
  const p = join(LOCALES_DIR, code + '.json');
  const cat = existsSync(p) ? readJson(p) : {};
  const out = {};
  for (const k of Object.keys(messages)) if (cat[k] === undefined || cat[k] === '') out[k] = '';
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'extract') extract();
else if (cmd === 'check') check(rest);
else if (cmd === 'prune') prune(rest);
else if (cmd === 'todo') todo(rest);
else { console.error('usage : node scripts/i18n.mjs extract | check [codes…] | prune [codes…] | todo <code>'); process.exit(2); }
