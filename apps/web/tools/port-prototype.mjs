// Outil de portage ponctuel : découpe app.js du prototype en modules ES (src/ui/*.js).
// Usage : node tools/port-prototype.mjs <chemin du app.js du prototype>
// Le résultat est ensuite maintenu à la main ; ce script documente l'origine de chaque module.
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = path.resolve('src/ui');
const lines = fs.readFileSync(SRC, 'utf8').replace(/\r/g, '').split('\n');
const range = (a, b) => lines.slice(a - 1, b);
const dedent = (arr) => arr.map((l) => (l.startsWith('  ') ? l.slice(2) : l));

/** module -> { ranges, pre (code ajouté en tête), post, rules } */
const M = {};
const mod = (name, ranges, o = {}) => { M[name] = { ranges, pre: o.pre || '', post: o.post || '', rules: [] }; };
const rule = (name, from, to, all = false) => M[name].rules.push({ from, to, all });

mod('icons', [[34, 55]]);
mod('constants', [[11, 33], [56, 59], [437, 443]]);
mod('dom', [[62, 68], [143, 149]], { pre: 'let toastTimer = null;\n' });
mod('state', [[71, 89]]);
mod('util', [[99, 119], [130, 139], [151, 157]], { post: "\nexport const getSeen = () => userStore.getSeen();\n" });
mod('dates', [[444, 462]]);
mod('catalog', [[90, 90], [120, 120], [160, 269]]);
mod('home', [[272, 349], [661, 834]]);
mod('fragments', [[351, 364], [414, 433], [1153, 1163], [1755, 1758]]);
mod('ratings', [[366, 412], [2706, 2713]]);
mod('tiles', [[464, 659]]);
mod('preview', [[836, 946]], { pre: 'let dwellIO = null;\n' });
mod('ficheModel', [[949, 1044]], { pre: 'const fullCache = new Map();\n' });
mod('fiche', [[1046, 1152], [1164, 1287], [1542, 1610]], { pre: 'let ficheIO = null;\n' });
mod('providers', [[1289, 1338]]);
mod('ficheSections', [[1340, 1453]]);
mod('heroVideo', [[1455, 1540]], { pre: 'let fv = null;\n', post: '\nexport function clearAmbient() {\n  clearTimeout(ambTimer);\n  ambTimer = null;\n}\n' });
mod('services', [[1612, 1754], [1759, 1808]]);
mod('router', [[1810, 1829], [2691, 2697], [2867, 2930]]);
mod('rows', [[1831, 1904]]);
mod('library', [[1937, 1976]], { pre: "// Bibliothèque : toutes les lectures/écritures passent par userStore (adaptateur local aujourd'hui, API lastAddon ensuite).\nconst inLib = (key) => userStore.inLibrary(key);\nfunction toggleLib(it) {\n  const known = state.byKey.get(it.type + ':' + it.id);\n  return userStore.toggleLibrary({\n    id: it.id, type: it.type, title: it.name, poster: it.posterPath || '', year: (known && known.year) || it.year || '',\n  });\n}\nfunction libItems() {\n  return userStore.getLibrary().map((x) => {\n    const raw = { id: x.id, poster_path: x.poster };\n    raw[x.type === 'tv' ? 'name' : 'title'] = x.title;\n    const it = register(toItem(raw, x.type));\n    it.added = x.addedAt || 0;\n    return it;\n  });\n}\n" });
rule('library', 'getLib().length', 'userStore.getLibrary().length');
mod('ctxmenu', [[1978, 2025]]);
mod('tv', [[2028, 2328]]);
mod('player', [[2330, 2464]]);
mod('person', [[2467, 2689]]);
mod('hover', [[2700, 2705], [2714, 2865]]);
mod('modal', [[2933, 2947], [2957, 2982]]);
mod('events', [[2985, 3405]]);

const FR = "x.iso_3166_1 === 'FR'";
const REG = 'x.iso_3166_1 === getRegion().code';

// ---------- Règles de réécriture ----------
rule('state', 'upcoming: null,', 'upcoming: null,\n  svcIO: null, // observateur des rangées de la page service\n  ctxMenu: null, // menu contextuel ouvert\n  dragRow: null, // rangée en cours de glisser\n  suppressClick: false,');

rule('catalog', FR, REG, true);
rule('catalog', "{ append_to_response: append, include_image_language: 'fr,en,null', include_video_language: 'fr,en,null' }", "{ append_to_response: append, include_image_language: 'fr,en,null' }");
rule('catalog', 'trailer: pickTrailer(raw.videos && raw.videos.results),', 'trailer: pickTrailer(await videosOf(raw, item.type, item.id)),');
rule('catalog', 'function getDetail(item) {', `/** Bandes-annonces : la liste blanche du serveur n'accepte pas include_video_language, repli en-US si rien en français. */
async function videosOf(raw, type, id) {
  const list = (raw.videos && raw.videos.results) || [];
  if (pickTrailer(list)) return list;
  try {
    const en = await tmdb(type + '/' + id + '/videos', { language: 'en-US' });
    return list.concat(en.results || []);
  } catch (_) {
    return list;
  }
}

function getDetail(item) {`);

rule('home', `    const res = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ history: DEMO_HISTORY, liked: DEMO_LIKED }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();`, `    const seed = recoSeed();
    const json = await recommend(seed.history, seed.liked);`);
rule('home', "state.ai = { status: 'ready', items };", "state.ai = { status: 'ready', items, demo: seed.demo };");
rule('home', "with_release_type: '2|3' ", '');
rule('home', "sort_by: 'popularity.desc', }", "sort_by: 'popularity.desc' }");
rule('home', `Recommandé pour toi par l’IA <span class="demo-tag">démo</span></h2>' +`, `Recommandé pour toi par l’IA' + (ai.demo ? ' <span class="demo-tag">démo</span>' : '') + '</h2>' +`);
rule('home', "section('reprendre', 'Reprendre la lecture', cut(r.continue, 4), (l) => row(l.map((it, i) => continueCard(it, DEMO_PROGRESS[i])).join('')), 'démo') +", 'continueSection(r) +');
rule('home', `'<button type="button" class="avatar" aria-label="Profil Greg">G</button></div></header>';`, `'<button type="button" class="avatar" data-settings aria-label="Profil ' + esc(userStore.currentProfile().name) + ' et réglages">' + esc(initialOf()) + '</button></div></header>';`);
rule('home', `aria-label="Disponible en streaming en France">'`, `aria-label="Disponible en streaming ' + getRegion().where + '">'`);
rule('home', `'<a href="' + (label === 'Bibliothèque' ? '#/library' : '#/') + '"' + (label === 'Bibliothèque' ? ' data-libnav' : ' data-noop') + ' class="tab'`, `'<a href="' + tabHref(label) + '"' + tabData(label) + ' class="tab'`);
rule('home', `'<span class="avatar avatar-tab" aria-hidden="true">G</span>'`, `'<span class="avatar avatar-tab" aria-hidden="true">' + esc(initialOf()) + '</span>'`);
rule('home', `<div class="state" role="alert"><p>Impossible de charger le catalogue. Vérifie la connexion au serveur, puis réessaie.</p>' +
    '<button type="button" class="btn btn-primary" data-retry>Réessayer</button></div></main>';`, `<div class="state" role="alert"><p>' + (isConfigured()
      ? 'Impossible de charger le catalogue. Vérifie la connexion à lastAddon, puis réessaie.'
      : 'lastAddon n’est pas configuré. Renseigne son adresse dans les réglages.') + '</p>' +
    '<button type="button" class="btn btn-primary" data-retry>Réessayer</button>' +
    '<button type="button" class="btn btn-ghost" data-settings>Réglages</button></div></main>';`);
M.home.post = `
const initialOf = () => (userStore.currentProfile().name || '?').slice(0, 1).toUpperCase();
const tabHref = (label) => (label === 'Bibliothèque' ? '#/library' : label === 'Profil' ? '#/settings' : '#/');
const tabData = (label) => (label === 'Bibliothèque' ? ' data-libnav' : label === 'Profil' ? ' data-settings' : ' data-noop');

/** Historique envoyé à /recommend : la bibliothèque si elle existe, sinon l'historique de démonstration. */
function recoSeed() {
  const lib = userStore.getLibrary().filter((e) => e.title).sort((a, b) => b.addedAt - a.addedAt).slice(0, 10);
  if (!lib.length) return { history: DEMO_HISTORY, liked: DEMO_LIKED, demo: true };
  const history = lib.map((e) => ({ title: e.title, year: Number(e.year) || null, type: e.type }));
  return { history, liked: history.slice(0, 3), demo: false };
}

/** « Reprendre la lecture » : progression réelle (userStore) ou, à défaut, la rangée de démonstration. */
function continueSection(r) {
  const real = userStore.continueWatching(10);
  if (real.length) {
    const items = real.map((p) => {
      const raw = { id: p.id, poster_path: p.poster, backdrop_path: p.backdrop || '' };
      raw[p.type === 'tv' ? 'name' : 'title'] = p.title;
      return { it: register(toItem(raw, p.type)), pct: Math.round((p.position / p.duration) * 100) };
    });
    return section('reprendre', 'Reprendre la lecture', items, (l) => row(l.map((x) => continueCard(x.it, x.pct)).join('')));
  }
  return section('reprendre', 'Reprendre la lecture', cut(r.continue, 4), (l) => row(l.map((it, i) => continueCard(it, DEMO_PROGRESS[i])).join('')), 'démo');
}
`;

rule('tiles', "raw['watch/providers'].results.FR) || {};", "raw['watch/providers'].results[getRegion().code]) || {};");

rule('ficheModel', FR, REG, true);
rule('ficheModel', "{ append_to_response: append, include_image_language: 'fr,en,null', include_video_language: 'fr,en,null' }", "{ append_to_response: append, include_image_language: 'fr,en,null' }");
rule('ficheModel', 'let en = null;', "raw.videos = { results: await videosOf(raw, type, id) };\n      let en = null;");

rule('fiche', 'title="Classification France">', `title="Classification ' + esc(getRegion().label) + '">`);
rule('fiche', 'clearTimeout(ambTimer);', 'clearAmbient();');
rule('fiche', /\bsvcIO\b/g, 'state.svcIO');

rule('providers', 'j.results.FR) || {};', 'j.results[getRegion().code]) || {};');
rule('providers', 'Pas disponible en streaming en France</p>\'', `Pas disponible en streaming ' + getRegion().where + '</p>'`);
rule('providers', 'aria-label="Où regarder en France (ouvre', `aria-label="Où regarder ' + getRegion().where + ' (ouvre`);

rule('ficheSections', `    const res = await fetch('/api/why', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title: m.name, year: m.year, overview: m.overview, genres: m.genres }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();`, `    const j = await why(m.type, m.id);`);

rule('services', "watch_region: 'FR'", 'watch_region: getRegion().code', true);
rule('services', 'Disponibles en France</p>', `Disponibles ' + getRegion().where + '</p>`);
rule('services', /\bsvcIO\b/g, 'state.svcIO');

rule('router', "document.title = 'Laststream · Accueil (prototype)';", "document.title = 'Laststream';");
rule('router', "else if (r.kind === 'library') showLibrary();", "else if (r.kind === 'library') showLibrary();\n  else if (r.kind === 'settings') showSettings();");
rule('router', "if (h === '#/library') return { kind: 'library' };", "if (h === '#/library') return { kind: 'library' };\n  if (h === '#/settings') return { kind: 'settings' };");

rule('rows', /\bdragRow\b/g, 'state.dragRow');
rule('rows', /\bsuppressClick\b/g, 'state.suppressClick');
rule('rows', 'let state.dragRow = null;', '');
rule('rows', 'let state.suppressClick = false;', '');
rule('ctxmenu', 'let ctxMenu = null;', '');
rule('ctxmenu', /\bctxMenu\b/g, 'state.ctxMenu');
rule('ctxmenu', /\bsuppressClick\b/g, 'state.suppressClick');
rule('hover', /\bctxMenu\b/g, 'state.ctxMenu');
rule('hover', /\bdragRow\b/g, 'state.dragRow');
rule('events', /\bctxMenu\b/g, 'state.ctxMenu');

rule('tv', `  return fetch('/api/tv/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) })
    .then((r) => (r.ok ? r.json() : { channels: [] })).then((j) => { tv.user = j.channels || []; }).catch(() => { tv.user = []; });`, `  return tvImport(cfg).then((j) => { tv.user = j.channels || []; }).catch(() => { tv.user = []; });`);
rule('tv', `      const res = await fetch('/api/tv/channels', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      tv.channels = await res.json();`, `      tv.channels = await tvChannels();`);
rule('tv', `    jobs.push(fetch('/api/tv/epg?ids=' + encodeURIComponent(part.join(',')) + '&from=' + w0 + '&to=' + (w0 + EPG_H * 3600), { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : [])).then((list) => {`, `    jobs.push(tvEpg(part, w0, w0 + EPG_H * 3600)
      .then((list) => {`);
rule('tv', `    const r = await fetch('/api/tv/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
    const j = await r.json();
    if (!r.ok) throw new Error('refus');`, `    const j = await tvImport(cfg);`);

rule('player', 'flaky: !!c.flaky });', 'flaky: !!c.flaky, sig: c.sig });');
rule('player', "const proxied = '/api/tv/hls?u=' + encodeURIComponent(c.url);", 'const proxied = c.sig ? tvHlsUrl(c) : \'\';');
rule('player', `if (/\\.(mp4|webm|mkv|ts)(\\?|$)/i.test(c.url)) {`, `if (!proxied && !/\\.(mp4|webm|mkv|ts)(\\?|$)/i.test(c.url)) {
    playFail(token);
  } else if (/\\.(mp4|webm|mkv|ts)(\\?|$)/i.test(c.url)) {`);

rule('person', `    fetch('/api/person-why', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: raw.name, knownFor: known.slice(0, 8).map((e) => e.it.name) }),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP')))).then((j) => {`, `    personWhy(raw.id).then((j) => {`);

rule('events', "if (play) { e.preventDefault(); openSources(play); return; }", "if (play) { e.preventDefault(); playFrom(play); return; }");
rule('events', `    const list = getSeen();
    const k = sn.dataset.seen;
    const i = list.indexOf(k);
    if (i >= 0) list.splice(i, 1); else list.push(k);
    store('ls_seen', list);
    const on = i < 0;`, `      const on = userStore.toggleSeen(sn.dataset.seen);`);
rule('events', "const libNav = t.closest('[data-libnav]');", "const setB = t.closest('[data-settings]');\n    if (setB) { e.preventDefault(); go('#/settings', setB); return; }\n    const libNav = t.closest('[data-libnav]');");

// ---------- Construction ----------
function build(name) {
  const m = M[name];
  let text = m.pre + dedent(m.ranges.flatMap(([a, b]) => range(a, b))).join('\n') + m.post;
  for (const r of m.rules) {
    if (typeof r.from === 'string') {
      if (!text.includes(r.from)) throw new Error(`[${name}] règle introuvable : ${r.from.slice(0, 70)}`);
      text = r.all ? text.split(r.from).join(r.to) : text.replace(r.from, () => r.to);
    } else {
      if (!r.from.test(text)) throw new Error(`[${name}] règle regex introuvable : ${r.from}`);
      r.from.lastIndex = 0;
      text = text.replace(r.from, r.to);
    }
  }
  return text;
}

const texts = {};
for (const n of Object.keys(M)) texts[n] = build(n);
texts.certification = null;
delete texts.certification;
// frCertification -> certification
for (const n of Object.keys(texts)) texts[n] = texts[n].replace(/\bfrCertification\b/g, 'certification');

const DECL = /^(?:(?:async\s+)?function\s+(\w+)|(const|let)\s+(\w+)|class\s+(\w+))/;
const table = new Map(); // nom -> module
const privateLets = new Map();
for (const [n, t] of Object.entries(texts)) {
  for (const l of t.split('\n')) {
    const d = DECL.exec(l);
    if (!d) continue;
    const name = d[1] || d[3] || d[4];
    if (d[2] === 'let') { privateLets.set(name + '@' + n, n); continue; }
    if (table.has(name)) throw new Error(`Doublon ${name} : ${table.get(name)} / ${n}`);
    table.set(name, n);
  }
}
const EXTERNAL = {
  '../data/lt': ['api', 'tmdb', 'recommend', 'why', 'personWhy', 'tvChannels', 'tvEpg', 'tvImport', 'tvHlsUrl'],
  '../data/userStore': ['userStore'],
  '../data/prefs': ['getRegion'],
  '../data/config': ['isConfigured'],
  './sources-ui.js': ['playFrom'],
  './settings.js': ['showSettings'],
};
const ext = new Map();
for (const [p, names] of Object.entries(EXTERNAL)) names.forEach((x) => ext.set(x, p));

function strip(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}
const idents = (code) => new Set([...strip(code).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

fs.mkdirSync(OUT, { recursive: true });
for (const [n, t0] of Object.entries(texts)) {
  // export des déclarations de premier niveau (sauf let)
  const body = t0.split('\n').map((l) => {
    const d = DECL.exec(l);
    return d && d[2] !== 'let' ? 'export ' + l : l;
  }).join('\n');
  const used = idents(body);
  const own = new Set([...table].filter(([, mm]) => mm === n).map(([k]) => k));
  const byFile = new Map();
  for (const id of used) {
    if (own.has(id)) continue;
    // variables locales qui masquent : on importe quand même (inoffensif)
    if (table.has(id)) {
      const f = './' + table.get(id) + '.js';
      (byFile.get(f) || byFile.set(f, []).get(f)).push(id);
    } else if (ext.has(id)) {
      const f = ext.get(id);
      (byFile.get(f) || byFile.set(f, []).get(f)).push(id);
    } else {
      for (const k of privateLets.keys()) {
        const [pn, pm] = k.split('@');
        if (pn === id && pm !== n) console.warn(`ATTENTION ${n} référence le let privé ${id} de ${pm}`);
      }
    }
  }
  const imports = [...byFile].sort().map(([f, ids]) => `import { ${ids.sort().join(', ')} } from '${f}';`).join('\n');
  fs.writeFileSync(path.join(OUT, n + '.js'), `/* Port du prototype (voir tools/port-prototype.mjs). */\n${imports}\n\n${body.replace(/\n+$/, '')}\n`);
}
console.log('modules :', Object.keys(texts).join(', '));
