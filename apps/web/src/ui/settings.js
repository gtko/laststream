/* Page #/settings : lastAddon (schéma, clés, langues, sources, debrid), lecture, apparence, région. */
import { decodeConfig, encodeConfig, getSchema, isMask, testConfig } from '../data/configApi';
import { DEFAULT_BASE, getBase, getConfig, isConfigured, normalizeBase, saveSettings } from '../data/config';
import { clearCache } from '../data/transport';
import {
  BANDWIDTH_PRESETS_MBPS, getAutoplay, getBandwidthSetting, getRegion, getSkipPref, REGIONS,
  setAutoplay, setBandwidthSetting, setRegion, setSkipPref,
} from '../data/prefs';
import { testBandwidthKbps, readStoredBandwidth } from '../data/sources';
import { applyTheme, CUSTOM_THEME_ID, isHexColor, PRESETS, readTheme, resolveTheme, saveTheme } from '../data/theme';
import { userStore } from '../data/userStore';
import { detailEl, toast } from './dom.js';
import { esc } from './util.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';

const LANGS = [['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien'], ['multi', 'Multi'], ['original', 'Version originale']];
const RESOLUTIONS = ['2160p', '1080p', '720p', '480p', 'SD'];
const SERVICE_FALLBACK = {
  tmdbToken: ['Jeton TMDB (lecture v4)', 'Catalogues, fiches et recommandations.'],
  mdblistApiKey: ['Clé MDBList', 'Notes IMDb, Rotten Tomatoes, Metacritic, Letterboxd.'],
  tvdbApiKey: ['Clé TheTVDB', 'Saisons et prochain épisode des séries.'],
  tvdbPin: ['PIN d’abonné TVDB', 'Seulement pour une clé v4 personnelle.'],
  openrouterApiKey: ['Clé OpenRouter', 'Recommandations IA et « Pourquoi tu vas aimer ».'],
  openrouterModel: ['Modèle OpenRouter', 'Identifiant du modèle utilisé pour les textes.'],
  fanartApiKey: ['Clé Fanart.tv', 'Facultative.'],
  introdbApiKey: ['Clé IntroDB', 'Segments intro, reprise et générique.'],
  animeskipClientId: ['Client ID Anime Skip', 'Repères de saut des séries d’animation.'],
  tmdbApiKey: ['Clé API TMDB (v3)', 'Facultative.'],
};

/** État de la page : configuration en cours d'édition (secrets masqués) et configuration chiffrée de départ. */
const ed = { cfg: null, schema: null, loaded: false, error: '', loading: false, token: 0 };

const secretPlaceholder = (v) => (isMask(v) ? (v.last4 ? 'Enregistrée (' + v.last4 + ')' : 'Enregistrée') : 'Non définie');

function serviceDefs() {
  const props = ed.schema && ed.schema.properties && ed.schema.properties.services && ed.schema.properties.services.properties;
  if (props) return Object.entries(props).map(([k, v]) => [k, v.title || k, v.description || '']);
  return Object.entries(SERVICE_FALLBACK).map(([k, [t, d]]) => [k, t, d]);
}

function enumOf(path, fallback) {
  try {
    const s = ed.schema.properties;
    const node = path.reduce((n, k) => n.properties[k], { properties: s });
    return node.items ? node.items.enum : node.enum;
  } catch (_) { return fallback; }
}

function check(name, label, on, extra) {
  return '<label class="set-check"><input type="checkbox" name="' + esc(name) + '"' + (on ? ' checked' : '') + (extra || '') + '> <span>' + esc(label) + '</span></label>';
}

function field(label, inner, hint) {
  return '<label class="tv-field">' + esc(label) + inner + (hint ? '<span class="set-hint">' + esc(hint) + '</span>' : '') + '</label>';
}

function sourceRow(s, i) {
  const t = s.type === 'torznab';
  return '<div class="set-source" data-srci="' + i + '"><div class="set-source-head"><strong>' + (t ? 'Torznab' : 'Addon amont') + '</strong>' +
    '<button type="button" class="link-btn" data-set-delsrc="' + i + '">Retirer</button></div>' +
    field('Nom', '<input type="text" data-sf="name" value="' + esc(s.name || '') + '">') +
    (t
      ? field('URL Torznab (baseUrl)', '<input type="url" data-sf="baseUrl" value="' + esc(s.baseUrl || '') + '" placeholder="https://indexeur.exemple/api">') +
        field('Clé API', '<input type="password" autocomplete="off" data-sf="apiKey" placeholder="' + esc(secretPlaceholder(s.apiKey)) + '">', 'Laisse vide pour garder la clé enregistrée.')
      : field('URL de l’addon amont', '<input type="url" data-sf="url" value="' + esc(s.url || '') + '" placeholder="https://addon.exemple/manifest.json">')) +
    '<div class="set-tests" data-tests-src="' + esc(s.name || '') + '"></div></div>';
}

function lastAddonSection() {
  const c = ed.cfg || {};
  const sv = c.services || {};
  const langs = c.languages || {};
  const pref = langs.preferred || ['fr', 'multi'];
  const res = c.resolutions || {};
  const allowed = res.allowed || RESOLUTIONS;
  const size = c.size || {};
  const resList = enumOf(['resolutions', 'allowed'], RESOLUTIONS) || RESOLUTIONS;
  const base = getBase() || DEFAULT_BASE;
  const status = ed.loading ? 'Chargement de la configuration…' : ed.error ? ed.error : ed.loaded ? 'Configuration chargée.' : isConfigured() ? '' : 'Aucune configuration enregistrée : renseigne l’adresse puis enregistre.';

  const services = serviceDefs().map(([k, title, desc]) => (k === 'openrouterModel'
    ? field(title, '<input type="text" name="svc.' + k + '" value="' + esc(sv[k] || 'openai/gpt-4o-mini') + '">', desc)
    : field(title, '<input type="password" autocomplete="off" name="svc.' + k + '" placeholder="' + esc(secretPlaceholder(sv[k])) + '">', desc))).join('');

  const debrid = c.debrid;
  return '<section class="set-sec glass" aria-labelledby="set-la-h"><h2 class="f-sub" id="set-la-h">lastAddon</h2>' +
    '<p class="set-hint">Le serveur qui fournit le catalogue, les notes, la TV et les sources.</p>' +
    '<form id="set-la" class="tv-form set-form" autocomplete="off">' +
    field('Adresse du serveur', '<input type="url" name="base" value="' + esc(base) + '" placeholder="http://localhost:7000">') +
    '<p class="tv-form-msg" id="set-la-msg" role="status">' + esc(status) + '</p>' +
    '<div class="set-block"><h3 class="set-h3">Clés des services</h3>' + services +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-set-test="services">Tester les clés</button></div>' +
    '<div class="set-tests" id="set-tests-services" aria-live="polite"></div></div>' +
    '<div class="set-block"><h3 class="set-h3">Langues</h3><div class="set-checks">' +
    LANGS.map(([v, l]) => check('lang.' + v, l, pref.includes(v))).join('') + '</div>' +
    check('acceptVostfr', 'Accepter la VOSTFR', langs.acceptVostfr !== false) +
    check('fallbackToOthers', 'Afficher les autres langues s’il n’y a rien dans ma langue', langs.fallbackToOthers !== false) + '</div>' +
    '<div class="set-block"><h3 class="set-h3">Résolutions</h3><div class="set-checks">' +
    resList.map((v) => check('res.' + v, v, allowed.includes(v))).join('') + '</div>' +
    field('Résolution maximale', '<select name="resMax"><option value="">Aucune limite</option>' + resList.map((v) => '<option value="' + v + '"' + (res.max === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>') + '</div>' +
    '<div class="set-block"><h3 class="set-h3">Tailles</h3><div class="set-grid">' +
    field('Taille minimale (Go)', '<input type="number" min="0" step="0.1" name="minGb" value="' + esc(size.minGb != null ? size.minGb : '') + '">') +
    field('Taille maximale (Go)', '<input type="number" min="0.1" step="0.1" name="maxGb" value="' + esc(size.maxGb != null ? size.maxGb : '') + '">') +
    field('Nombre de résultats', '<input type="number" min="1" max="500" name="maxResults" value="' + esc(c.maxResults != null ? c.maxResults : 30) + '">') + '</div></div>' +
    '<div class="set-block"><h3 class="set-h3">Sources</h3><div id="set-sources">' + (c.sources || []).map(sourceRow).join('') + '</div>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-set-addsrc="upstream">Ajouter un addon amont</button>' +
    '<button type="button" class="btn btn-ghost" data-set-addsrc="torznab">Ajouter un Torznab</button>' +
    '<button type="button" class="btn btn-ghost" data-set-test="sources">Tester les sources</button></div>' +
    '<div class="set-tests" id="set-tests-sources" aria-live="polite"></div></div>' +
    '<div class="set-block"><h3 class="set-h3">Debrid</h3>' +
    check('debridOn', 'Activer AllDebrid', !!debrid) +
    field('Clé API AllDebrid', '<input type="password" autocomplete="off" name="debridKey" placeholder="' + esc(secretPlaceholder(debrid && debrid.apiKey)) + '">', 'Laisse vide pour garder la clé enregistrée.') +
    check('onlyCached', 'Seulement les sources déjà en cache', !!c.onlyCached) +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-set-test="debrid">Tester AllDebrid</button></div>' +
    '<div class="set-tests" id="set-tests-debrid" aria-live="polite"></div></div>' +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">Enregistrer</button></div>' +
    '<p class="tv-form-note">Les clés sont chiffrées par le serveur ; ce navigateur ne garde que la configuration chiffrée.</p>' +
    '</form></section>';
}

function playbackSection() {
  const bw = getBandwidthSetting();
  const stored = readStoredBandwidth();
  const mbps = stored && stored.expiresAt > Date.now() ? (stored.kbps / 1000).toFixed(1).replace('.', ',') + ' Mb/s' : '';
  return '<section class="set-sec glass" aria-labelledby="set-pl-h"><h2 class="f-sub" id="set-pl-h">Lecture</h2>' +
    check('autoplay', 'Lancer automatiquement la meilleure source', getAutoplay(), ' data-set-pref="autoplay"') +
    '<div class="set-row">' + field('Débit de ma connexion', '<select data-set-pref="bandwidth"><option value="auto"' + (bw === 'auto' ? ' selected' : '') + '>Automatique (mesure)</option>' +
    BANDWIDTH_PRESETS_MBPS.map((n) => '<option value="' + n + '"' + (bw === n ? ' selected' : '') + '>' + n + ' Mb/s</option>').join('') + '</select>') +
    '<button type="button" class="btn btn-ghost" data-set-bw>Tester ma connexion</button></div>' +
    '<p class="tv-form-msg" id="set-bw-msg" role="status">' + (mbps ? 'Dernière mesure : ' + mbps : '') + '</p>' +
    check('skip-intro', 'Passer l’intro automatiquement', getSkipPref('intro'), ' data-set-pref="skip-intro"') +
    check('skip-recap', 'Passer le récapitulatif automatiquement', getSkipPref('recap'), ' data-set-pref="skip-recap"') +
    check('skip-next', 'Enchaîner l’épisode suivant', getSkipPref('nextEpisode'), ' data-set-pref="skip-next"') + '</section>';
}

function appearanceSection() {
  const th = readTheme();
  return '<section class="set-sec glass" aria-labelledby="set-ap-h"><h2 class="f-sub" id="set-ap-h">Apparence</h2>' +
    '<div class="pills" role="group" aria-label="Thème">' +
    PRESETS.map((p) => '<button type="button" class="pill set-theme" data-set-theme="' + p.id + '" aria-pressed="' + (th.id === p.id) + '"><span class="set-dot" style="background:' + p.accent + '"></span>' + esc(p.label) + '</button>').join('') +
    '<button type="button" class="pill set-theme" data-set-theme="custom" aria-pressed="' + (th.id === CUSTOM_THEME_ID) + '">Personnalisé</button></div>' +
    '<label class="set-check set-color"><span>Couleur d’accent</span><input type="color" data-set-color value="' + esc(th.accent.toLowerCase()) + '"' + (th.id === CUSTOM_THEME_ID ? '' : ' disabled') + '></label></section>';
}

function regionSection() {
  const r = getRegion();
  return '<section class="set-sec glass" aria-labelledby="set-rg-h"><h2 class="f-sub" id="set-rg-h">Région</h2>' +
    '<p class="set-hint">Disponibilités en streaming, classification par âge et sorties selon le pays.</p>' +
    field('Pays', '<select data-set-pref="region">' + REGIONS.map((x) => '<option value="' + x.code + '"' + (x.code === r.code ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('') + '</select>') + '</section>';
}

function dataSection() {
  const p = userStore.currentProfile();
  return '<section class="set-sec glass" aria-labelledby="set-dt-h"><h2 class="f-sub" id="set-dt-h">Profil et données</h2>' +
    '<p class="set-hint">Profil actif : <strong>' + esc(p.name) + '</strong> · ' + userStore.getLibrary().length + ' titre(s) dans la bibliothèque. Les comptes, profils et la synchronisation arrivent avec l’API utilisateur de lastAddon.</p>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-set-clear>Vider le cache</button></div></section>';
}

function pageHTML() {
  return topBar(false) +
    '<article class="svc-page set-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Réglages</h1><p class="svc-eyebrow">lastAddon, lecture, apparence et région</p></div></header>' +
    '<div class="set-body">' + lastAddonSection() + playbackSection() + appearanceSection() + regionSection() + dataSection() + '</div></article>';
}

function rerender() {
  const scroll = window.scrollY;
  detailEl.innerHTML = pageHTML();
  window.scrollTo(0, scroll);
}

async function loadConfig() {
  const token = ++ed.token;
  ed.loading = true;
  ed.error = '';
  ed.cfg = ed.cfg || {};
  try {
    const base = getBase();
    if (!base) { ed.loading = false; return; }
    ed.schema = await getSchema(base).catch(() => null);
    const enc = getConfig();
    const decoded = enc ? await decodeConfig(enc, base) : null;
    if (token !== ed.token) return;
    ed.cfg = decoded || {};
    ed.loaded = !!decoded;
    if (enc && !decoded) ed.error = 'Impossible de lire la configuration enregistrée (serveur injoignable ou clé de chiffrement différente).';
  } catch (_) {
    ed.error = 'lastAddon est injoignable à cette adresse.';
  }
  if (token !== ed.token) return;
  ed.loading = false;
  if (state.kind === 'settings') rerender();
}

export async function showSettings() {
  teardownFiche();
  state.kind = 'settings';
  document.title = 'Réglages · Laststream';
  ed.loaded = false;
  ed.cfg = null;
  ed.schema = null;
  detailEl.innerHTML = pageHTML();
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  loadConfig();
}

// ---------- Lecture du formulaire ----------
function readSourcesInto(cfg, form) {
  const rows = Array.from(form.querySelectorAll('.set-source'));
  cfg.sources = rows.map((row) => {
    const i = Number(row.dataset.srci);
    const src = Object.assign({}, (ed.cfg.sources || [])[i]);
    row.querySelectorAll('[data-sf]').forEach((inp) => {
      const f = inp.dataset.sf;
      const v = inp.value.trim();
      if (f === 'apiKey') { if (v) src.apiKey = v; } else src[f] = v;
    });
    return src;
  });
}

function buildConfig(form) {
  const cfg = JSON.parse(JSON.stringify(ed.cfg || {}));
  const f = form.elements;
  cfg.services = cfg.services || {};
  serviceDefs().forEach(([k]) => {
    const inp = f['svc.' + k];
    if (!inp) return;
    const v = inp.value.trim();
    if (v) cfg.services[k] = v;
    else if (k === 'openrouterModel') delete cfg.services[k];
  });
  cfg.languages = cfg.languages || {};
  cfg.languages.preferred = LANGS.map(([v]) => v).filter((v) => f['lang.' + v] && f['lang.' + v].checked);
  cfg.languages.acceptVostfr = f.acceptVostfr.checked;
  cfg.languages.fallbackToOthers = f.fallbackToOthers.checked;
  const resList = enumOf(['resolutions', 'allowed'], RESOLUTIONS) || RESOLUTIONS;
  cfg.resolutions = cfg.resolutions || {};
  cfg.resolutions.allowed = resList.filter((v) => f['res.' + v] && f['res.' + v].checked);
  if (f.resMax.value) cfg.resolutions.max = f.resMax.value; else delete cfg.resolutions.max;
  cfg.size = cfg.size || {};
  ['minGb', 'maxGb'].forEach((k) => { if (f[k].value !== '') cfg.size[k] = Number(f[k].value); else delete cfg.size[k]; });
  if (f.maxResults.value !== '') cfg.maxResults = Number(f.maxResults.value);
  readSourcesInto(cfg, form);
  cfg.onlyCached = f.onlyCached.checked;
  if (f.debridOn.checked) {
    const key = f.debridKey.value.trim();
    if (key) cfg.debrid = { service: 'alldebrid', apiKey: key };
    else if (!cfg.debrid) cfg.debrid = undefined; // pas de clé : rien à activer
  } else {
    delete cfg.debrid;
  }
  if (cfg.debrid === undefined) delete cfg.debrid;
  return cfg;
}

const issuesText = (err) => (err && err.issues && err.issues.length ? err.issues.join(' · ') : '');

async function encodeFromForm(form) {
  const base = normalizeBase(form.elements.base.value) || DEFAULT_BASE;
  const body = buildConfig(form);
  const config = await encodeConfig(body, getConfig() || undefined, base);
  return { base, config };
}

function showTests(kind, results) {
  const box = detailEl.querySelector('#set-tests-' + kind);
  if (!box) return;
  box.innerHTML = results.length
    ? results.map((r) => '<p class="set-test ' + (r.ok ? 'is-ok' : 'is-ko') + '"><strong>' + (r.ok ? '✓' : '✕') + '</strong> ' + esc(r.name) +
      (r.ok ? (r.note ? ' <em>' + esc(r.note) + '</em>' : '') : ' : ' + esc(r.error || 'échec')) + '</p>').join('')
    : '<p class="set-hint">Rien à tester.</p>';
}

async function runTest(kind, btn) {
  const form = detailEl.querySelector('#set-la');
  if (!form) return;
  const box = detailEl.querySelector('#set-tests-' + kind);
  if (box) box.innerHTML = '<p class="set-hint">Test en cours…</p>';
  btn.disabled = true;
  try {
    const { base, config } = await encodeFromForm(form);
    const res = await testConfig(config, base);
    if (kind === 'services') showTests('services', res.services);
    else if (kind === 'debrid') showTests('debrid', res.sources.filter((s) => s.type === 'alldebrid'));
    else showTests('sources', res.sources.filter((s) => s.type !== 'alldebrid'));
  } catch (err) {
    if (box) box.innerHTML = '<p class="set-test is-ko">' + esc(issuesText(err) || 'Test impossible : vérifie l’adresse et la configuration.') + '</p>';
  } finally {
    btn.disabled = false;
  }
}

async function save(form) {
  const msg = detailEl.querySelector('#set-la-msg');
  if (msg) msg.textContent = 'Enregistrement…';
  try {
    const { base, config } = await encodeFromForm(form);
    saveSettings({ base, config });
    clearCache();
    ed.cfg = (await decodeConfig(config, base)) || ed.cfg;
    ed.loaded = true;
    ed.error = '';
    rerender();
    const m2 = detailEl.querySelector('#set-la-msg');
    if (m2) m2.textContent = 'Configuration enregistrée.';
    toast('Configuration enregistrée');
  } catch (err) {
    if (msg) msg.textContent = 'Enregistrement refusé : ' + (issuesText(err) || (err && err.message) || 'erreur');
  }
}

// ---------- Événements (délégués, limités à la page) ----------
detailEl.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('.set-page')) return;
  const test = t.closest('[data-set-test]');
  if (test) { e.preventDefault(); runTest(test.dataset.setTest, test); return; }
  const add = t.closest('[data-set-addsrc]');
  if (add) {
    e.preventDefault();
    const form = detailEl.querySelector('#set-la');
    const cfg = buildConfig(form);
    cfg.sources = cfg.sources || [];
    cfg.sources.push(add.dataset.setAddsrc === 'torznab' ? { type: 'torznab', name: 'Torznab', baseUrl: '' } : { type: 'upstream', name: 'Addon amont', url: '' });
    ed.cfg = Object.assign({}, ed.cfg, { sources: cfg.sources });
    rerender();
    return;
  }
  const del = t.closest('[data-set-delsrc]');
  if (del) {
    e.preventDefault();
    const form = detailEl.querySelector('#set-la');
    const cfg = buildConfig(form);
    cfg.sources.splice(Number(del.dataset.setDelsrc), 1);
    ed.cfg = Object.assign({}, ed.cfg, { sources: cfg.sources });
    rerender();
    return;
  }
  const th = t.closest('[data-set-theme]');
  if (th) {
    e.preventDefault();
    const id = th.dataset.setTheme;
    const cur = readTheme();
    const theme = id === CUSTOM_THEME_ID ? resolveTheme(CUSTOM_THEME_ID, isHexColor(cur.accent) ? cur.accent : '#ff5a36') : resolveTheme(id, null);
    saveTheme(theme);
    applyTheme(theme);
    detailEl.querySelectorAll('[data-set-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b === th)));
    const color = detailEl.querySelector('[data-set-color]');
    if (color) { color.disabled = theme.id !== CUSTOM_THEME_ID; color.value = theme.accent.toLowerCase(); }
    return;
  }
  if (t.closest('[data-set-bw]')) {
    e.preventDefault();
    const msg = detailEl.querySelector('#set-bw-msg');
    const btn = t.closest('[data-set-bw]');
    btn.disabled = true;
    if (msg) msg.textContent = 'Mesure en cours (3 s au plus)…';
    const kbps = await testBandwidthKbps();
    btn.disabled = false;
    if (msg) msg.textContent = kbps ? 'Débit mesuré : ' + (kbps / 1000).toFixed(1).replace('.', ',') + ' Mb/s (gardé 24 h).' : 'Mesure impossible : vérifie ta connexion.';
    return;
  }
  if (t.closest('[data-set-clear]')) {
    e.preventDefault();
    clearCache();
    toast('Cache vidé');
  }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.closest('.set-page')) return;
  const p = t.dataset.setPref;
  if (!p) return;
  if (p === 'autoplay') setAutoplay(t.checked);
  else if (p === 'bandwidth') setBandwidthSetting(t.value === 'auto' ? 'auto' : Number(t.value));
  else if (p === 'skip-intro') setSkipPref('intro', t.checked);
  else if (p === 'skip-recap') setSkipPref('recap', t.checked);
  else if (p === 'skip-next') setSkipPref('nextEpisode', t.checked);
  else if (p === 'region') {
    setRegion(t.value);
    clearCache();
    toast('Région mise à jour : rechargement…');
    setTimeout(() => location.reload(), 600);
  }
});

detailEl.addEventListener('input', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.dataset.setColor !== undefined && isHexColor(t.value)) {
    const theme = resolveTheme(CUSTOM_THEME_ID, t.value);
    saveTheme(theme);
    applyTheme(theme);
  }
});

detailEl.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'set-la') { e.preventDefault(); save(e.target); }
});
