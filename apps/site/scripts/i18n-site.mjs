#!/usr/bin/env node
/*
 * Traductions du site vitrine (LAST-1658) : les pages anglaises (public/en/) servent de source, chaque langue de l'app
 * (apps/web/src/i18n/locales.ts) qui a un catalogue i18n/<code>.json obtient sa copie sous public/<code>/.
 * Le français (public/) et l'anglais (public/en/) restent écrits à la main.
 *
 *   node scripts/i18n-site.mjs extract   relève les textes des pages anglaises → i18n/messages.json
 *   node scripts/i18n-site.mjs build     écrit public/<code>/ pour chaque catalogue, met à jour le sélecteur de langue,
 *                                        les liens hreflang de toutes les pages et sitemap.xml
 *   node scripts/i18n-site.mjs check     catalogues : textes manquants, balises ou entités différentes
 *
 * Un texte (« segment ») est une suite de texte et de balises en ligne (a, strong, em, code…) entre deux balises de bloc,
 * sans les balises qui l'entourent entièrement. Les attributs alt, title, aria-label, placeholder, data-open, data-close et
 * le contenu des balises meta de description et de partage sont des segments à part. Scripts, styles, SVG et
 * commentaires ne sont pas traduits. Un texte absent du catalogue reste en anglais.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SITE = new URL('..', import.meta.url).pathname;
const PUB = join(SITE, 'public');
const I18N = join(SITE, 'i18n');
const ORIGIN = 'https://laststream.app';
const LOCALES_TS = join(SITE, '..', 'web', 'src', 'i18n', 'locales.ts');

/** Textes de public/app.js (téléchargements, visionneuse) : repris tels quels de son dictionnaire anglais. */
const APP_STRINGS = {
  mb: 'MB',
  others: 'The other platforms are just below.',
  label: {
    windows: ['Download for Windows', 'Detected: Windows'],
    android: ['Download the Android APK', 'Detected: Android'],
    ios: ['Install the web version', 'Detected: iPhone or iPad'],
    mac: ['Download for Mac', 'Detected: macOS'],
    linux: ['Download for Linux', 'Detected: Linux'],
    web: ['Open in browser', 'Your platform was not recognized'],
  },
  close: 'Close',
  dialog: 'Enlarged screenshot',
  badge: 'For your device',
};

/** Langues de l'app (même liste que l'interface). Le site ne prend que celles qui ont leur propre catalogue. */
function locales() {
  const src = readFileSync(LOCALES_TS, 'utf8');
  return [...src.matchAll(/\{ code: '([^']+)', name: '([^']+)'([^}]*)\}/g)].map((m) => ({
    code: m[1], name: m[2], rtl: /rtl: true/.test(m[3]), base: (m[3].match(/base: '([^']+)'/) || [])[1],
  }));
}

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : f === 'index.html' ? [p] : [];
});
/** Pages anglaises, chemin public (« /en/guides/add-a-source/ »). */
const enPages = () => walk(join(PUB, 'en')).map((f) => '/' + relative(PUB, dirname(f)).split('\\').join('/') + '/');
const fileOf = (path) => join(PUB, path, 'index.html');

/* ---------- Découpage ---------- */

/** Jamais traduits : commentaires, scripts, styles, SVG, blocs préformatés et le sélecteur de langue. */
const PROTECTED = /<!--[\s\S]*?-->|<(script|style|svg|pre|template)\b[\s\S]*?<\/\1\s*>|<nav class="lang"[\s\S]*?<\/nav>/gi;
/** Noms de langue (liens vers les autres versions) : gardés tels quels. */
const SKIP = new Set(['Français', 'English']);
const INLINE = new Set(['a', 'strong', 'em', 'b', 'i', 'span', 'code', 'br', 'small', 'kbd', 'abbr', 'sup', 'sub', 'mark', 'time', 'img', 'wbr', 's', 'u', 'q', 'cite', 'bdi']);
const VOID = new Set(['br', 'img', 'wbr', 'meta', 'link', 'input', 'source', 'hr', 'area', 'base', 'col', 'embed', 'track']);
const TRANSLATED_ATTRS = new Set(['alt', 'title', 'aria-label', 'placeholder', 'data-open', 'data-close']);
const META_KEYS = /^(description|og:title|og:description|og:image:alt|twitter:title|twitter:description|twitter:image:alt)$/;

/** Jetons : { kind: 'text'|'tag'|'raw', s, start, end, name?, close? }. */
function tokenize(html) {
  const out = [];
  let i = 0;
  const raw = [];
  for (const m of html.matchAll(PROTECTED)) raw.push([m.index, m.index + m[0].length]);
  let r = 0;
  while (i < html.length) {
    if (r < raw.length && raw[r][0] === i) { out.push({ kind: 'raw', s: html.slice(i, raw[r][1]), start: i, end: raw[r][1] }); i = raw[r][1]; r++; continue; }
    const nextRaw = r < raw.length ? raw[r][0] : html.length;
    if (html[i] === '<' && /[a-zA-Z/!]/.test(html[i + 1] || '')) {
      const end = html.indexOf('>', i);
      const s = html.slice(i, end + 1);
      const m = s.match(/^<(\/?)([a-zA-Z][\w-]*)/);
      out.push({ kind: 'tag', s, start: i, end: end + 1, name: m ? m[2].toLowerCase() : '!', close: !!(m && m[1]) });
      i = end + 1;
      continue;
    }
    let j = html.indexOf('<', i + 1);
    while (j !== -1 && j < nextRaw && !/[a-zA-Z/!]/.test(html[j + 1] || '')) j = html.indexOf('<', j + 1);
    const end = Math.min(j === -1 ? html.length : j, nextRaw);
    out.push({ kind: 'text', s: html.slice(i, end), start: i, end });
    i = end;
  }
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const hasWords = (s) => !SKIP.has(s) && hasLetters(s);
const hasLetters = (s) => /\p{L}{2,}/u.test(s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/gi, ''));
const isInline = (t) => t.kind === 'tag' && INLINE.has(t.name);

/** Segments de texte d'une page : [{ start, end, key }] (positions dans le HTML source). */
function segments(html) {
  const toks = tokenize(html);
  const out = [];
  let run = [];
  const blank = (t) => (t.kind === 'text' && !t.s.trim()) || (t.kind === 'tag' && t.name === 'br');
  /** Segment run[a, b) : rogné, sans balise englobante ; coupé aux balises orphelines ; éclaté s'il n'a que des éléments. */
  const emit = (a, b) => {
    for (;;) {
      while (a < b && blank(run[a])) a++;
      while (b > a && blank(run[b - 1])) b--;
      if (b - a < 2) break;
      const first = run[a];
      const last = run[b - 1];
      if (first.kind === 'tag' && !first.close && !VOID.has(first.name) && last.kind === 'tag' && last.close && last.name === first.name && matches(run, a, b - 1)) { a++; b--; continue; }
      break;
    }
    if (a >= b) return;
    const bad = unmatched(run, a, b);
    if (bad.size) {
      let s = a;
      for (let k = a; k < b; k++) if (bad.has(k)) { emit(s, k); s = k + 1; }
      emit(s, b);
      return;
    }
    // Plusieurs liens côte à côte sans texte entre eux (boutons, précédent/suivant) : un segment chacun.
    const tops = [];
    let depth = 0;
    let textTop = false;
    for (let k = a; k < b; k++) {
      const t = run[k];
      if (t.kind === 'text') { if (depth === 0 && t.s.trim()) textTop = true; continue; }
      if (VOID.has(t.name)) { if (depth === 0 && t.name !== 'br') tops.push([k, k + 1]); continue; }
      if (!t.close) { if (depth === 0) tops.push([k, -1]); depth++; } else { depth--; if (depth === 0) tops[tops.length - 1][1] = k + 1; }
    }
    if (!textTop && tops.length > 1 && tops.every(([x]) => run[x].name === 'a' || run[x].name === 'img')) { for (const [x, y] of tops) emit(x, y); return; }
    let start = run[a].start;
    let end = run[b - 1].end;
    const text = html.slice(start, end);
    start += text.length - text.trimStart().length;
    end -= text.length - text.trimEnd().length;
    const key = norm(html.slice(start, end));
    if (key && hasWords(key)) out.push({ start, end, key });
  };
  const flush = () => {
    emit(0, run.length);
    run = [];
  };
  for (const t of toks) {
    if (t.kind === 'text' || isInline(t)) run.push(t);
    else flush();
  }
  flush();
  return out;
}

/** La balise ouvrante run[a] se ferme-t-elle en run[b] (et pas avant) ? */
function matches(run, a, b) {
  let depth = 0;
  for (let k = a; k <= b; k++) {
    const t = run[k];
    if (t.kind !== 'tag' || t.name !== run[a].name || VOID.has(t.name)) continue;
    depth += t.close ? -1 : 1;
    if (depth === 0) return k === b;
  }
  return false;
}

/** Indices des balises en ligne sans partenaire dans run[a, b). */
function unmatched(run, a, b) {
  const stack = [];
  const bad = new Set();
  for (let k = a; k < b; k++) {
    const t = run[k];
    if (t.kind !== 'tag' || VOID.has(t.name)) continue;
    if (!t.close) stack.push(k);
    else {
      const top = stack.length ? stack[stack.length - 1] : -1;
      if (top >= 0 && run[top].name === t.name) stack.pop(); else bad.add(k);
    }
  }
  for (const k of stack) bad.add(k);
  return bad;
}

/** Attributs traduisibles d'une balise : [{ start, end, key }] (positions de la valeur). */
function attrSegments(html) {
  const out = [];
  for (const t of tokenize(html)) {
    if (t.kind !== 'tag' || t.close) continue;
    const isMeta = t.name === 'meta';
    const metaKey = isMeta ? ((t.s.match(/\s(?:name|property)="([^"]+)"/) || [])[1] || '') : '';
    for (const m of t.s.matchAll(/\s([a-zA-Z-:]+)="([^"]*)"/g)) {
      const name = m[1].toLowerCase();
      const ok = TRANSLATED_ATTRS.has(name) || (isMeta && name === 'content' && META_KEYS.test(metaKey));
      if (!ok || !hasWords(m[2])) continue;
      const start = t.start + m.index + m[0].length - 1 - m[2].length;
      out.push({ start, end: start + m[2].length, key: norm(m[2]) });
    }
  }
  return out;
}

/* ---------- Commandes ---------- */

const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const appKeys = () => {
  const out = [];
  const visit = (v) => (typeof v === 'string' ? out.push(v) : Object.values(v).forEach(visit));
  visit(APP_STRINGS);
  return out;
};

function extract() {
  const keys = new Map();
  const add = (k, where) => { if (!keys.has(k)) keys.set(k, new Set()); keys.get(k).add(where); };
  for (const path of enPages()) {
    const html = readFileSync(fileOf(path), 'utf8');
    for (const s of [...segments(html), ...attrSegments(html)]) add(s.key, path);
  }
  for (const k of appKeys()) add(k, 'app.js');
  const out = {};
  for (const k of [...keys.keys()].sort()) out[k] = [...keys.get(k)].sort();
  mkdirSync(I18N, { recursive: true });
  writeFileSync(join(I18N, 'messages.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(Object.keys(out).length + ' textes → i18n/messages.json');
}

const tagsOf = (s) => [...String(s).matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*>/g)].map((m) => m[0].replace(/\s(alt|title|aria-label)="[^"]*"/g, '')).sort().join('|');
const entityOf = (s) => [...String(s).matchAll(/&(lt|gt|amp|quot);/g)].length;

function check() {
  const messages = readJson(join(I18N, 'messages.json'), {});
  const keys = Object.keys(messages);
  let failed = false;
  for (const l of siteLocales()) {
    const cat = readJson(join(I18N, l.code + '.json'), {});
    const missing = keys.filter((k) => !cat[k]);
    const errors = [];
    for (const k of keys) {
      const v = cat[k];
      if (!v) continue;
      if (tagsOf(v) !== tagsOf(k)) errors.push('balises différentes : ' + JSON.stringify(k));
      if (/"/.test(v) && !/"/.test(k)) errors.push('guillemet droit ajouté : ' + JSON.stringify(k));
      if (/<(script|style|iframe)|\son\w+=|javascript:/i.test(v)) errors.push('contenu interdit : ' + JSON.stringify(k));
    }
    console.log(l.code + ' : ' + (keys.length - missing.length) + '/' + keys.length + (errors.length ? ', ' + errors.length + ' erreurs' : ''));
    for (const e of errors.slice(0, 20)) console.error('  ' + l.code + ' : ' + e);
    if (errors.length) failed = true;
  }
  if (failed) process.exit(1);
}

/** Langues du site en plus du français et de l'anglais : celles qui ont un catalogue i18n/<code>.json. */
function siteLocales() {
  return locales().filter((l) => l.code !== 'fr' && l.code !== 'en' && existsSync(join(I18N, l.code + '.json')));
}

/** Correspondance des pages : chemin anglais → chemin français (lien hreflang="fr" de la page anglaise). */
function pageGroups() {
  return enPages().map((en) => {
    const html = readFileSync(fileOf(en), 'utf8');
    const fr = (html.match(/<link rel="alternate" hreflang="fr" href="https:\/\/laststream\.app([^"]*)">/) || [])[1] || null;
    return { en, fr };
  });
}

const ogLocale = (code) => (code.includes('-') ? code.replace('-', '_') : code);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Liens hreflang de la page d'un groupe (en tête de page). */
function alternates(group, langs) {
  const lines = [];
  if (group.fr) lines.push('<link rel="alternate" hreflang="fr" href="' + ORIGIN + group.fr + '">');
  lines.push('<link rel="alternate" hreflang="en" href="' + ORIGIN + group.en + '">');
  for (const l of langs) lines.push('<link rel="alternate" hreflang="' + l.code + '" href="' + ORIGIN + localized(group.en, l.code) + '">');
  lines.push('<link rel="alternate" hreflang="x-default" href="' + ORIGIN + (group.fr || group.en) + '">');
  return lines.join('\n');
}
const localized = (enPath, code) => '/' + code + enPath.slice(3);

/** Menu des autres langues, inséré dans le sélecteur FR/EN de chaque page. */
function langMenu(group, langs, current, all) {
  if (!langs.length) return '';
  const items = langs.map((l) => '<li><a href="' + localized(group.en, l.code) + '" hreflang="' + l.code + '" lang="' + l.code + '"' +
    (l.code === current ? ' aria-current="page"' : '') + '>' + esc(all.find((x) => x.code === l.code).name) + '</a></li>').join('');
  const label = current && current !== 'fr' && current !== 'en' ? current.toUpperCase() : '+';
  return '<!-- langues:début (scripts/i18n-site.mjs) --><details class="lang-more"><summary' + (label !== '+' ? ' aria-current="page"' : '') +
    '><span aria-hidden="true">' + esc(label) + '</span><span class="sr-only">Languages</span></summary><ul>' + items + '</ul></details><!-- langues:fin -->';
}

function applyShared(html, group, langs, current, all) {
  html = html.replace(/(<link rel="alternate" hreflang="[^"]+" href="[^"]*">\n?)+/, alternates(group, langs) + '\n');
  html = html.replace(/<!-- langues:début[\s\S]*?<!-- langues:fin -->/g, '');
  html = html.replace(/(<nav class="lang"[^>]*>[\s\S]*?)(\s*<\/nav>)/, (m, a, b) => a + langMenu(group, langs, current, all) + b);
  return html;
}

function build() {
  const all = locales();
  const langs = siteLocales();
  const groups = pageGroups();
  // Pages générées par un build précédent pour une langue qui n'a plus de catalogue : retirées.
  const keep = new Set(['en', 'fr', ...langs.map((l) => l.code)]);
  const known = new Set(all.map((l) => l.code));
  for (const d of readdirSync(PUB)) if (known.has(d) && !keep.has(d)) rmSync(join(PUB, d), { recursive: true });

  const appJson = (cat) => {
    const tr = (v) => (typeof v === 'string' ? cat[v] || v : Array.isArray(v) ? v.map(tr) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tr(x)])));
    return JSON.stringify(tr(APP_STRINGS)).replace(/</g, '\\u003c');
  };

  for (const g of groups) {
    const src = readFileSync(fileOf(g.en), 'utf8');
    for (const l of langs) {
      const cat = readJson(join(I18N, l.code + '.json'), {});
      const edits = [...segments(src), ...attrSegments(src)].filter((s) => cat[s.key]).sort((a, b) => b.start - a.start);
      let html = src;
      for (const s of edits) html = html.slice(0, s.start) + cat[s.key] + html.slice(s.end);
      html = html.replace(/<html lang="en"[^>]*>/, '<html lang="' + l.code + '"' + (l.rtl ? ' dir="rtl"' : '') + '>');
      html = html.replace(/<meta property="og:locale" content="[^"]*">/, '<meta property="og:locale" content="' + ogLocale(l.code) + '">');
      html = html.replace(/<meta property="og:locale:alternate" content="[^"]*">\n?/g, '');
      // Liens internes vers la même langue (le sélecteur garde ses liens vers le français et l'anglais).
      const navs = [];
      html = html.replace(/<nav class="lang"[\s\S]*?<\/nav>/g, (m) => { navs.push(m); return '\u0000nav' + (navs.length - 1) + '\u0000'; });
      html = html.split(ORIGIN + '/en/').join(ORIGIN + '/' + l.code + '/').replace(/(href|src|action)="\/en\//g, '$1="/' + l.code + '/');
      html = html.replace(/\u0000nav(\d+)\u0000/g, (m, i) => navs[Number(i)]);
      // Ressources relatives des guides (captures, extrait vidéo) : celles de la page anglaise.
      html = html.replace(/(src|href|poster)="\.\/([^"]+)"/g, (m, a, p) => a + '="' + g.en + p + '"');
      // Le sélecteur FR/EN n'indique plus l'anglais comme page courante.
      html = html.replace(/(<nav class="lang"[\s\S]*?)<\/nav>/, (m) => m.replace(/ aria-current="page"/g, ''));
      html = html.replace('</body>', '<script type="application/json" id="ls-i18n">' + appJson(cat) + '</script>\n</body>');
      html = applyShared(html, g, langs, l.code, all);
      const out = fileOf(localized(g.en, l.code));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, html);
    }
    for (const [path, cur] of [[g.en, 'en'], [g.fr, 'fr']]) {
      if (!path || !existsSync(fileOf(path))) continue;
      const before = readFileSync(fileOf(path), 'utf8');
      const after = applyShared(before, g, langs, cur, all);
      if (after !== before) writeFileSync(fileOf(path), after);
    }
  }
  writeSitemap(groups, langs);
  console.log(langs.length + ' langues, ' + groups.length + ' pages chacune');
}

function writeSitemap(groups, langs) {
  const p = join(PUB, 'sitemap.xml');
  const old = readFileSync(p, 'utf8');
  const lastmod = new Map([...old.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((m) => [m[1], m[2]]));
  // Pages hors groupes (sans version anglaise) : gardées telles quelles.
  const grouped = new Set(groups.flatMap((g) => [g.en, g.fr].filter(Boolean).map((x) => ORIGIN + x)));
  const kept = [...old.matchAll(/ {2}<url>[\s\S]*?<\/url>\n/g)].map((m) => m[0]).filter((u) => {
    const loc = (u.match(/<loc>([^<]+)<\/loc>/) || [])[1] || '';
    return !grouped.has(loc) && !langs.some((l) => loc.startsWith(ORIGIN + '/' + l.code + '/'));
  });
  const urls = [];
  // Ordre du sitemap existant (pages nouvelles à la fin).
  const pos = (g) => { const i = old.indexOf('<loc>' + ORIGIN + (g.fr || g.en) + '</loc>'); return i < 0 ? Infinity : i; };
  for (const g of [...groups].sort((a, b) => pos(a) - pos(b))) {
    const alts = [];
    if (g.fr) alts.push(['fr', g.fr]);
    alts.push(['en', g.en]);
    for (const l of langs) alts.push([l.code, localized(g.en, l.code)]);
    alts.push(['x-default', g.fr || g.en]);
    const links = alts.map(([h, u]) => '    <xhtml:link rel="alternate" hreflang="' + h + '" href="' + ORIGIN + u + '"/>').join('\n');
    const mod = lastmod.get(ORIGIN + (g.fr || g.en)) || lastmod.get(ORIGIN + g.en);
    for (const [, u] of alts.slice(0, -1)) {
      urls.push('  <url>\n    <loc>' + ORIGIN + u + '</loc>\n' + (mod ? '    <lastmod>' + (lastmod.get(ORIGIN + u) || mod) + '</lastmod>\n' : '') + links + '\n  </url>\n');
    }
  }
  const head = old.slice(0, old.indexOf('<url>') - 2);
  writeFileSync(p, head + urls.join('') + kept.join('') + '</urlset>\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'extract') extract();
  else if (cmd === 'build') build();
  else if (cmd === 'check') check();
  else { console.error('usage : node scripts/i18n-site.mjs extract | build | check'); process.exit(2); }
}

export { segments, attrSegments };
