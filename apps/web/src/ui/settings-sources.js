/* Réglages > lastAddon > Sources : cartes compactes (logo, nom, état), priorité par glisser-déposer ou boutons,
 * activation par source, informations lues dans le manifest de l'addon amont. */
import { getBase, isAndroidApp } from '../data/config';
import { isMask, testSource } from '../data/configApi';
import { connectShell, isShellEnvironment, openExternal } from '../player/shell';
import { checkKey, classifyStreams, isDue, readCheck, writeCheck } from '../data/addonSafety';
import { ICON } from './icons.js';
import { detailEl, toast } from './dom.js';
import { esc } from './util.js';

const TRACKER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>';
const DEFAULT_NAMES = ['Addon amont', 'Torznab', ''];
const TYPE_FR = { movie: 'Films', series: 'Séries', anime: 'Animés', tv: 'TV', channel: 'Chaînes' };

let list = [];
const info = new Map();
const safety = new Map(); // verdict « torrents seulement » par source (id de session), issu du diagnostic quotidien
let seq = 0;

// ---------- Manifest ----------
/** `stremio://…` → `https://…` (les autres adresses sont inchangées, espaces retirés). */
export function toHttpsUrl(raw) {
  return String(raw || '').trim().replace(/^stremio:\/\//i, 'https://');
}

/** `stremio://…` → https, avec ou sans /manifest.json : renvoie l'adresse du manifest (vide si invalide). */
export function normalizeManifestUrl(raw) {
  let u = toHttpsUrl(raw);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const url = new URL(u);
    if (!/manifest\.json$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/+$/, '') + '/manifest.json';
    return url.toString();
  } catch (_) { return ''; }
}

/** Page de configuration d'un addon : le /manifest.json devient /configure (préfixe de config et query gardés). */
export function configureUrl(raw) {
  const manifest = normalizeManifestUrl(raw);
  if (!manifest) return '';
  const url = new URL(manifest);
  url.pathname = url.pathname.replace(/\/manifest\.json$/i, '/configure');
  return url.toString();
}

/** Nom, version, description, logo, types, présence de la ressource « stream » et de la configuration d'un manifest Stremio. */
export function manifestInfo(m) {
  const resources = Array.isArray(m && m.resources) ? m.resources.map((r) => (typeof r === 'string' ? r : r && r.name)) : [];
  const hints = (m && m.behaviorHints && typeof m.behaviorHints === 'object') ? m.behaviorHints : {};
  return {
    name: String((m && m.name) || ''),
    version: String((m && m.version) || ''),
    desc: String((m && m.description) || ''),
    logo: String((m && (m.logo || m.icon)) || ''),
    types: Array.isArray(m && m.types) ? m.types : [],
    hasStream: resources.includes('stream'),
    configurable: !!(hints.configurable || hints.configurationRequired),
  };
}

async function fetchManifest(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadInfo(src) {
  const url = normalizeManifestUrl(src.url);
  if (!url) { info.set(src.id, { status: 'unk' }); paintCard(src.id); return; }
  info.set(src.id, { status: 'load' });
  paintCard(src.id);
  let result;
  try {
    const m = manifestInfo(await fetchManifest(url));
    result = { ...m, status: m.hasStream ? 'ok' : 'warn', error: m.hasStream ? '' : 'Pas de ressource « stream »' };
  } catch (_) {
    // Bloqué par CORS ou injoignable depuis le navigateur : lastAddon teste la source à notre place.
    try {
      const r = await testSource({ type: 'upstream', name: src.name || 'Source', url }, getBase());
      result = { name: r.name || '', logo: r.logo || '', version: r.version || '', desc: r.description || '', types: r.types || [], configurable: !!r.configurable, status: r.ok ? 'ok' : 'ko', error: r.ok ? '' : r.error || 'Source injoignable' };
    } catch (_e) {
      result = { status: 'ko', error: 'Source injoignable' };
    }
  }
  info.set(src.id, result);
  // Le nom du manifest remplit le champ « Nom » tant que l'utilisateur ne l'a pas modifié.
  if (result.name && (DEFAULT_NAMES.includes(src.name) || src.autoName === src.name)) {
    src.name = result.name;
    src.autoName = result.name;
  }
  paintCard(src.id);
}

// ---------- Modèle ----------
function toModel(s) {
  seq += 1;
  return { ...s, id: 's' + seq, enabled: s.enabled !== false, open: false, autoName: '' };
}

/** Appelé quand la configuration est chargée. */
export function initSources(sources) {
  list = (sources || []).map(toModel);
  info.clear();
  safety.clear();
  // À l'ouverture de la page : manifest, puis diagnostic « torrents seulement » (au plus une fois par jour et par addon).
  list.forEach((s, i) => { if (s.type === 'upstream' && s.url) setTimeout(() => { void loadInfo(s); void checkDaily(s); }, 150 * i); });
}

export function addSource(type) {
  syncFromDom();
  const s = toModel({ type: 'upstream', name: 'Addon amont', url: '' });
  s.open = true;
  list.push(s);
  renderSources();
  const inp = detailEl.querySelector('.src-card[data-srcid="' + s.id + '"] [data-sf]:not([data-sf="name"])');
  if (inp) inp.focus();
}

/** Lit les champs ouverts vers le modèle. */
export function syncFromDom() {
  detailEl.querySelectorAll('.src-card').forEach((card) => {
    const s = list.find((x) => x.id === card.dataset.srcid);
    if (!s) return;
    card.querySelectorAll('[data-sf]').forEach((inp) => {
      const f = inp.dataset.sf;
      const v = inp.value.trim();
      if (f === 'apiKey') { if (v) s.apiKey = v; } else if (f === 'name') { if (v !== s.name) s.autoName = ''; s.name = v; } else if (f === 'url') s.url = toHttpsUrl(v); else s[f] = v;
    });
  });
}

/** Sources à enregistrer, dans l'ordre de priorité. Les clés masquées sont renvoyées telles quelles (le serveur les conserve). */
export function serializeSources() {
  syncFromDom();
  return list.map((s) => {
    const { id, open, autoName, enabled, ...rest } = s;
    void id; void open; void autoName;
    return enabled ? rest : { ...rest, enabled: false };
  });
}

/** Résultats de « Tester les sources » : mettent à jour les pastilles. */
export function applyTestResults(results) {
  results.forEach((r) => {
    const s = list.find((x) => x.name === r.name && x.type === r.type);
    if (!s) return;
    const prev = info.get(s.id) || {};
    info.set(s.id, { ...prev, status: r.ok ? (prev.status === 'warn' ? 'warn' : 'ok') : 'ko', error: r.ok ? prev.error || '' : r.error || 'échec' });
    paintCard(s.id);
  });
}

// ---------- Rendu ----------
const STATUS_LABEL = { ok: 'Source disponible', warn: 'Disponible mais sans ressource « stream »', ko: 'Source en erreur', unk: 'Pas encore testée', load: 'Vérification…' };

function host(u) {
  try { return new URL(u).host; } catch (_) { return ''; }
}

function cardParts(s, pos) {
  const i = info.get(s.id) || { status: 'unk' };
  const t = s.type === 'torznab';
  const status = i.status || 'unk';
  const name = s.name || i.name || (t ? 'Ancienne source' : 'Addon amont');
  const types = (i.types || []).map((x) => TYPE_FR[x] || x).join(', ');
  const sub = t ? 'Ancienne source (inactive) · ' + (host(s.baseUrl) || 'sans adresse') : [i.version ? 'v' + i.version : '', types, i.desc].filter(Boolean).join(' · ') || host(s.url) || 'Addon amont';
  const logo = !t && i.logo ? '<img src="' + esc(i.logo) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : t ? TRACKER_ICON : ICON.film;
  return { status, name, sub, logo, err: i.error || '' , pos };
}

/** Vrai pour un addon amont dont le manifest déclare une configuration (behaviorHints.configurable / configurationRequired). */
function isConfigurable(s) {
  return s.type !== 'torznab' && !!configureUrl(s.url) && !!(info.get(s.id) || {}).configurable;
}

/** Adresse copiée par « Copier l’URL » : le manifest d’un addon (ou l’adresse d’une ancienne source, conservée telle quelle). */
function copyTarget(s) {
  return s.type === 'torznab' ? String(s.baseUrl || '') : normalizeManifestUrl(s.url);
}

function headHTML(s, pos) {
  const p = cardParts(s, pos);
  const cfg = isConfigurable(s);
  const copy = copyTarget(s);
  return '<span class="src-pos" aria-label="Priorité ' + pos + '">' + pos + '</span>' +
    '<button type="button" class="src-handle" data-src-handle aria-label="Déplacer la source ' + esc(p.name) + ' (flèches haut et bas)" title="Glisser pour changer la priorité">⋮⋮</button>' +
    '<span class="src-logo' + (s.type === 'torznab' ? ' is-generic' : '') + '">' + p.logo + '</span>' +
    '<span class="src-meta"><strong class="src-name">' + esc(p.name) + '</strong><span class="src-sub">' + esc(p.sub) + '</span></span>' +
    '<span class="src-dot is-' + p.status + '" role="img" aria-label="' + esc(STATUS_LABEL[p.status] + (p.err ? ' : ' + p.err : '')) + '" title="' + esc(STATUS_LABEL[p.status] + (p.err ? ' : ' + p.err : '')) + '"></span>' +
    '<label class="src-toggle"><input type="checkbox" data-src-enabled' + (s.enabled ? ' checked' : '') + '> <span>' + (s.enabled ? 'Activée' : 'Désactivée') + '</span></label>' +
    (cfg ? '<button type="button" class="src-cfg" data-src-config aria-label="Configurer l’addon ' + esc(p.name) + '" title="Configurer l’addon">' + ICON.gear + '</button>' : '') +
    '<span class="src-move"><button type="button" data-src-up aria-label="Monter la source ' + esc(p.name) + '">↑</button><button type="button" data-src-down aria-label="Descendre la source ' + esc(p.name) + '">↓</button></span>' +
    '<span class="ep-menu-wrap"><button type="button" class="src-more" data-src-menu aria-haspopup="menu" aria-expanded="false" aria-label="Plus d’actions pour ' + esc(p.name) + '">…</button>' +
    '<span class="ep-menu glass" role="menu" hidden><button type="button" role="menuitem" data-src-edit>Modifier</button>' +
    (cfg ? '<button type="button" role="menuitem" data-src-open-config>Ouvrir la configuration</button>' : '') +
    (copy ? '<button type="button" role="menuitem" data-src-copy>Copier l’URL</button>' : '') +
    '<button type="button" role="menuitem" data-src-toggle>' + (s.enabled ? 'Désactiver' : 'Activer') + '</button>' +
    '<button type="button" role="menuitem" data-src-remove>Retirer</button></span></span>';
}

/** Aide affichée sous la ligne après « Configurer » : l’utilisateur revient coller le lien d’installation. */
function cfgHelpHTML() {
  return '<div class="src-cfg-help" hidden>' +
    '<ol class="set-hint src-cfg-steps"><li>Configure l’addon dans la page ouverte.</li><li>Copie le lien d’installation.</li><li>Colle-le ici.</li></ol>' +
    '<div class="src-cfg-actions"><button type="button" class="btn btn-ghost btn-sm" data-src-paste>Coller</button></div>' +
    '<p class="set-hint src-cfg-status" aria-live="polite"></p></div>';
}

function editHTML(s) {
  const f = (label, inner, hint) => '<label class="tv-field">' + esc(label) + inner + (hint ? '<span class="set-hint">' + esc(hint) + '</span>' : '') + '</label>';
  const mask = isMask(s.apiKey) ? (s.apiKey.last4 ? 'Enregistrée (' + s.apiKey.last4 + ')' : 'Enregistrée') : 'Non définie';
  return f('Nom', '<input type="text" data-sf="name" value="' + esc(s.name || '') + '">') +
    (s.type === 'torznab'
      ? f('URL Torznab (baseUrl)', '<input type="url" data-sf="baseUrl" value="' + esc(s.baseUrl || '') + '" placeholder="https://indexeur.exemple/api">') +
        f('Clé API', '<input type="password" autocomplete="off" data-sf="apiKey" placeholder="' + esc(mask) + '">', 'Laisse vide pour garder la clé enregistrée.')
      : f('URL de l’addon amont', '<input type="text" inputmode="url" data-sf="url" value="' + esc(s.url || '') + '" placeholder="https://addon.exemple/manifest.json ou stremio://…">', 'Le manifest est lu à la saisie : nom, logo et état s’affichent.'));
}

function cardHTML(s, pos) {
  const status = (info.get(s.id) || {}).status || 'unk';
  return '<div class="src-card' + (s.enabled ? '' : ' is-off') + (s.open ? ' is-open' : '') + '" data-srcid="' + s.id + '" data-status="' + status + '">' +
    '<div class="src-head">' + headHTML(s, pos) + '</div>' +
    (s.type === 'torznab' ? '' : safetyRow(s.id) + cfgHelpHTML()) +
    '<div class="src-edit"' + (s.open ? '' : ' hidden') + '>' + editHTML(s) + '</div></div>';
}

export function sourcesHTML() {
  return '<div id="set-sources" class="src-list" role="list" aria-label="Sources, par ordre de priorité">' +
    (list.length ? list.map((s, i) => cardHTML(s, i + 1)).join('') : '<p class="set-hint">Ajoute tes extensions Stremio pour voir des sources.</p>') + '</div>' +
    '<p class="set-hint src-order-hint">L’ordre est la priorité : la source 1 passe en premier.</p><p class="sr-only" id="src-live" aria-live="polite"></p>';
}

function renderSources() {
  const box = detailEl.querySelector('#set-sources');
  if (!box) return;
  box.innerHTML = list.length ? list.map((s, i) => cardHTML(s, i + 1)).join('') : '<p class="set-hint">Ajoute tes extensions Stremio pour voir des sources.</p>';
}

/** Met à jour une carte en place (pastille, nom, logo) sans toucher aux champs en cours de saisie. */
function paintCard(id) {
  const card = detailEl.querySelector('.src-card[data-srcid="' + id + '"]');
  const s = list.find((x) => x.id === id);
  if (!card || !s) return;
  const pos = list.indexOf(s) + 1;
  const head = card.querySelector('.src-head');
  const open = !card.querySelector('.ep-menu').hidden;
  head.innerHTML = headHTML(s, pos);
  if (open) { head.querySelector('.ep-menu').hidden = false; }
  card.dataset.status = (info.get(id) || {}).status || 'unk';
  const nameInput = card.querySelector('[data-sf="name"]');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = s.name || '';
}

// ---------- Réordonner ----------
function move(id, to) {
  syncFromDom();
  const from = list.findIndex((x) => x.id === id);
  const dest = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from === dest) return false;
  const [s] = list.splice(from, 1);
  list.splice(dest, 0, s);
  renderSources();
  const live = detailEl.querySelector('#src-live');
  if (live) live.textContent = (s.name || 'Source') + ' déplacée en position ' + (dest + 1) + ' sur ' + list.length;
  return true;
}

function focusHandle(id, selector) {
  const el = detailEl.querySelector('.src-card[data-srcid="' + id + '"] ' + selector);
  if (el) el.focus();
}

let dragId = null;

detailEl.addEventListener('pointerdown', (e) => {
  const h = e.target instanceof Element && e.target.closest('[data-src-handle]');
  if (h) h.closest('.src-card').draggable = true;
});
detailEl.addEventListener('dragstart', (e) => {
  const card = e.target instanceof Element && e.target.closest('.src-card');
  if (!card) return;
  dragId = card.dataset.srcid;
  card.classList.add('is-drag');
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); }
});
detailEl.addEventListener('dragover', (e) => {
  if (!dragId) return;
  const card = e.target instanceof Element && e.target.closest('.src-card');
  if (!card) return;
  e.preventDefault();
  detailEl.querySelectorAll('.src-card.is-over').forEach((c) => c.classList.remove('is-over'));
  if (card.dataset.srcid !== dragId) card.classList.add('is-over');
});
detailEl.addEventListener('drop', (e) => {
  const card = e.target instanceof Element && e.target.closest('.src-card');
  if (!dragId || !card) return;
  e.preventDefault();
  const to = list.findIndex((x) => x.id === card.dataset.srcid);
  const id = dragId;
  dragId = null;
  move(id, to);
});
detailEl.addEventListener('dragend', () => {
  dragId = null;
  detailEl.querySelectorAll('.src-card').forEach((c) => { c.classList.remove('is-drag', 'is-over'); c.draggable = false; });
});

// ---------- Configuration de l’addon ----------
/** Page web hors de l’app : navigateur Android du système, sinon nouvel onglet. */
function openWeb(url) {
  if (isAndroidApp()) window.open(url, '_system');
  else window.open(url, '_blank', 'noopener');
}

/** Coque Windows : navigateur par défaut via la coque ; repli sur l’ouverture web si la coque ne répond pas. */
function openOutside(url) {
  if (!isShellEnvironment()) { openWeb(url); return Promise.resolve(); }
  return connectShell().then((t) => { if (t) openExternal(t, url); else openWeb(url); }, () => openWeb(url));
}

/** Le lien d’installation collé remplit le champ URL, relit le manifest ; l’enregistrement reste celui de la page. */
async function pasteInstallLink(card, s) {
  const status = card.querySelector('.src-cfg-status');
  const input = card.querySelector('[data-sf="url"]');
  const say = (msg) => { if (status) status.textContent = msg; };
  let text = '';
  try { text = navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : ''; } catch (_) { text = ''; }
  const link = toHttpsUrl(text);
  if (!/^https?:\/\//i.test(link)) {
    say('Pas de lien dans le presse-papiers : copie le lien d’installation, puis colle-le dans le champ URL ci-dessous.');
    if (input) input.focus();
    return;
  }
  if (input) input.value = link;
  syncFromDom();
  say('Lecture de l’addon…');
  await loadInfo(s);
  const i = info.get(s.id) || {};
  say(i.status === 'ok' ? 'Addon lu : ' + s.name + '. Enregistre la page pour valider.'
    : i.status === 'warn' ? 'Addon lu, mais sans ressource « stream ». Enregistre la page pour valider.'
      : 'Lien collé, mais l’addon ne répond pas : ' + (i.error || 'vérifie le lien.'));
}

/** « Configurer » : ouvre la page /configure de l’addon et affiche l’aide de collage sous la ligne. */
function openConfigure(card, s) {
  const page = configureUrl(s.url);
  const help = card.querySelector('.src-cfg-help');
  if (help) help.hidden = false;
  if (page) void openOutside(page);
}

// ---------- Addons « torrents seulement » ----------
const TEST_STREAM = '/stream/movie/tt0133093.json'; // Matrix : un flux de test suffit pour savoir ce que renvoie l’addon

/** Flux de test de l’addon, lu depuis l’app. Ne contacte jamais le débrideur : seul l’addon répond. */
async function probeStreams(manifest) {
  const u = new URL(manifest);
  const base = u.origin + u.pathname.replace(/\/manifest\.json$/i, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(base + TEST_STREAM, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return 'unknown';
    const body = await res.json();
    return classifyStreams(body && body.streams, u.origin);
  } catch (_) {
    return 'unknown'; // CORS, hors ligne ou réponse illisible
  } finally {
    clearTimeout(timer);
  }
}

/** Diagnostic en arrière-plan, à l’ouverture de la page : au plus une fois par jour et par addon (horodatage local). */
async function checkDaily(s) {
  const manifest = normalizeManifestUrl(s.url);
  if (!manifest) return;
  const key = checkKey(manifest);
  const prev = readCheck(key);
  const now = Date.now();
  if (!isDue(prev, now)) { setVerdict(s.id, prev.verdict); return; }
  // Horodatage posé avant le test : une autre ouverture pendant le test ne le relance pas.
  writeCheck(key, { at: now, verdict: prev ? prev.verdict : 'unknown' });
  const verdict = await probeStreams(manifest);
  writeCheck(key, { at: now, verdict });
  setVerdict(s.id, verdict);
}

function setVerdict(id, verdict) {
  safety.set(id, verdict);
  paintSafety(id);
}

/** Avertissement d’un addon « torrents seulement » : seul message affiché, avec « Configurer ». */
function safetyHTML() {
  return '<p class="src-safety-line">Ne renvoie que des torrents : aucune source lisible</p>' +
    '<div class="src-cfg-actions"><button type="button" class="btn btn-ghost btn-sm" data-safe-config>Configurer</button></div>';
}

/** Ligne d’avertissement d’un addon : masquée tant que tout va bien (rien n’est affiché). */
function safetyRow(id) {
  const torrents = safety.get(id) === 'torrents';
  return '<div class="src-safety"' + (torrents ? '' : ' hidden') + '>' + (torrents ? safetyHTML() : '') + '</div>';
}

function paintSafety(id) {
  const card = detailEl.querySelector('.src-card[data-srcid="' + id + '"]');
  const row = card && card.querySelector('.src-safety');
  if (row) row.outerHTML = safetyRow(id);
}

// ---------- Actions ----------
function closeMenus() {
  detailEl.querySelectorAll('.src-card .ep-menu').forEach((m) => { m.hidden = true; });
  detailEl.querySelectorAll('[data-src-menu]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function toggleEnabled(id, on) {
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.enabled = on;
  const card = detailEl.querySelector('.src-card[data-srcid="' + id + '"]');
  if (card) {
    card.classList.toggle('is-off', !on);
    const wasOpen = !card.querySelector('.ep-menu').hidden;
    card.querySelector('.src-head').innerHTML = headHTML(s, list.indexOf(s) + 1);
    if (wasOpen) card.querySelector('.ep-menu').hidden = false;
  }
}

detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !t.closest('.set-page')) return;
  const add = t.closest('[data-set-addsrc]');
  if (add) { e.preventDefault(); e.stopImmediatePropagation(); addSource(add.dataset.setAddsrc); return; }
  const card = t.closest('.src-card');
  if (!t.closest('.ep-menu-wrap')) closeMenus();
  if (!card) return;
  const id = card.dataset.srcid;
  const menu = t.closest('[data-src-menu]');
  if (menu) {
    e.preventDefault();
    const box = card.querySelector('.ep-menu');
    const open = box.hidden;
    closeMenus();
    box.hidden = !open;
    menu.setAttribute('aria-expanded', String(open));
    if (open) box.querySelector('button').focus();
    return;
  }
  if (t.closest('[data-src-config], [data-src-open-config], [data-safe-config]')) {
    e.preventDefault();
    closeMenus();
    syncFromDom();
    const s = list.find((x) => x.id === id);
    if (s) openConfigure(card, s);
    return;
  }
  if (t.closest('[data-src-copy]')) {
    e.preventDefault();
    closeMenus();
    syncFromDom();
    const s = list.find((x) => x.id === id);
    const text = s ? copyTarget(s) : '';
    if (!text) return;
    if (!navigator.clipboard || !navigator.clipboard.writeText) { toast('Copie impossible'); return; }
    navigator.clipboard.writeText(text).then(() => toast('URL copiée'), () => toast('Copie impossible'));
    return;
  }
  if (t.closest('[data-src-paste]')) {
    e.preventDefault();
    const s = list.find((x) => x.id === id);
    if (s) void pasteInstallLink(card, s);
    return;
  }
  if (t.closest('[data-src-edit]')) {
    e.preventDefault();
    closeMenus();
    const s = list.find((x) => x.id === id);
    syncFromDom();
    s.open = !s.open;
    card.classList.toggle('is-open', s.open);
    card.querySelector('.src-edit').hidden = !s.open;
    if (s.open) { const inp = card.querySelector('[data-sf]'); if (inp) inp.focus(); }
    return;
  }
  if (t.closest('[data-src-toggle]')) {
    e.preventDefault();
    closeMenus();
    const s = list.find((x) => x.id === id);
    toggleEnabled(id, !s.enabled);
    return;
  }
  if (t.closest('[data-src-remove]')) {
    e.preventDefault();
    syncFromDom();
    const s = list.find((x) => x.id === id);
    list = list.filter((x) => x.id !== id);
    info.delete(id);
    safety.delete(id);
    renderSources();
    toast('Source retirée : ' + (s.name || 'sans nom') + ' (enregistre pour valider)');
    return;
  }
  if (t.closest('[data-src-up]')) { e.preventDefault(); const i = list.findIndex((x) => x.id === id); if (move(id, i - 1)) focusHandle(id, '[data-src-up]'); return; }
  if (t.closest('[data-src-down]')) { e.preventDefault(); const i = list.findIndex((x) => x.id === id); if (move(id, i + 1)) focusHandle(id, '[data-src-down]'); }
}, true);

detailEl.addEventListener('change', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !t.closest('.src-card')) return;
  const card = t.closest('.src-card');
  if (t.matches('[data-src-enabled]')) { toggleEnabled(card.dataset.srcid, t.checked); return; }
  if (t.matches('[data-sf="url"]')) {
    const s = list.find((x) => x.id === card.dataset.srcid);
    const https = toHttpsUrl(t.value);
    if (https !== t.value) t.value = https; // stremio:// → https://
    syncFromDom();
    if (s) loadInfo(s).then(() => { const n = card.querySelector('[data-sf="name"]'); if (n && s.name) n.value = s.name; });
  }
});

// Clavier sur la poignée : flèches haut / bas déplacent la source.
detailEl.addEventListener('keydown', (e) => {
  const h = e.target instanceof Element && e.target.closest('[data-src-handle]');
  if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  e.stopPropagation();
  const id = h.closest('.src-card').dataset.srcid;
  const i = list.findIndex((x) => x.id === id);
  if (move(id, i + (e.key === 'ArrowUp' ? -1 : 1))) focusHandle(id, '[data-src-handle]');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailEl.querySelector('.src-card .ep-menu:not([hidden])')) { e.stopPropagation(); closeMenus(); }
}, true);
