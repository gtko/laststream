/* Page #/settings : lastAddon (schéma, clés, langues, sources, debrid), lecture, apparence, région. */
import { applyTestResults, initSources, serializeSources, sourcesHTML } from './settings-sources.js';
import { decodeConfig, encodeConfig, getSchema, isMask, testConfig } from '../data/configApi';
import { testServer } from '../data/serverTest';
import { DEFAULT_BASE, getBase, getConfig, isAndroidApp, isConfigured, normalizeBase, saveSettings } from '../data/config';
import { clearCache } from '../data/transport';
import {
  BANDWIDTH_PRESETS_MBPS, getAutoplay, getBandwidthSetting, getRegion, getSkipPref, getVideoLangSetting, REGIONS, VIDEO_LANGS, setVideoLang,
  setAutoplay, setBandwidthSetting, setRegion, setSkipPref,
} from '../data/prefs';
import { testBandwidthKbps, readStoredBandwidth } from '../data/sources';
import { applyTheme, CUSTOM_THEME_ID, isHexColor, PRESETS, readTheme, resolveTheme, saveTheme } from '../data/theme';
import { getLangPrefs, LANG_CHOICES, LANG_MAIN, LANG_NONE, LANG_VO, setLangPrefs } from '../data/langPrefs';
import { userStore } from '../data/userStore';
import { auth, importFromStremio, isKidProfile, isServerMode, pushConfig, pushPrefs, signOut } from '../data/auth';
import { errorText, openLogin, openPicker } from './auth-ui.js';
import { homePanelHTML } from './homeprefs.js';
import {
  CATEGORIES, card, chipHTML, chipsHTML, fieldRow, flip, isOn, navHTML, panelHTML, rowHTML, switchRow,
} from './settings-ui.js';
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

const stackInput = (label, desc, attrs) => fieldRow(label, desc, (id) => '<input class="set-input" id="' + id + '" ' + attrs + '>', { stack: true });
const msgP = (id, text) => '<p class="set-msg" id="' + id + '" role="status">' + esc(text || '') + '</p>';
const actions = (inner) => '<div class="set-actions">' + inner + '</div>';

function accountPanel() {
  const p = userStore.currentProfile();
  const lib = userStore.getLibrary().length;
  const data = card('Données de ce navigateur', rowHTML('Bibliothèque', 'Titres gardés pour le profil « ' + p.name + ' » dans ce navigateur.', () => '<span class="set-val">' + lib + ' titre(s)</span>') +
    rowHTML('Vider le cache', 'Supprime les réponses mémorisées du catalogue ; rien d’autre n’est effacé.', () => '<button type="button" class="btn btn-ghost btn-sm" data-set-clear>Vider le cache</button>'));
  if (!isServerMode()) {
    return card('Compte', '<p class="set-hint">' + (auth.status === 'offline'
      ? 'lastAddon est injoignable : la bibliothèque et la progression restent dans ce navigateur.'
      : 'Sans compte, la bibliothèque et la progression restent dans ce navigateur. Un compte lastAddon les garde sur ton serveur, avec des profils.') + '</p>' +
      actions('<button type="button" class="btn btn-primary" data-set-login>Se connecter ou créer un compte</button>')) + data;
  }
  const pr = auth.profile;
  return card('Compte et profils',
    rowHTML('Connecté en tant que', '', () => '<span class="set-val">' + esc(auth.username) + '</span>') +
    rowHTML('Profil actif', pr.isKid ? 'Profil enfant' : '', () => '<span class="set-val">' + esc(pr.name) + '</span><button type="button" class="btn btn-ghost btn-sm" data-set-switch>Changer de profil</button>') +
    rowHTML('Session', '', () => '<button type="button" class="btn btn-ghost btn-sm" data-set-logout>Se déconnecter</button>')) + data +
    card('Importer ma bibliothèque Stremio',
      '<form id="set-stremio" class="set-form" autocomplete="off">' +
      '<p class="set-hint">Ajoute à ce profil les films et séries de ta bibliothèque Stremio. Les identifiants sont envoyés à ton serveur lastAddon pour l’import, sans être conservés.</p>' +
      stackInput('E-mail Stremio', '', 'type="email" name="email" required autocomplete="off"') +
      stackInput('Mot de passe Stremio', '', 'type="password" name="password" required autocomplete="off"') +
      msgP('set-st-msg') + actions('<button type="submit" class="btn btn-primary">Importer</button>') + '</form>');
}

function appearancePanel() {
  const th = readTheme();
  const themes = '<div class="set-themes" role="group" aria-label="Thème" data-nav>' +
    PRESETS.map((p) => '<button type="button" class="set-theme" data-set-theme="' + p.id + '" aria-pressed="' + (th.id === p.id) + '"><span class="set-dot" style="background:' + p.accent + '"></span>' + esc(p.label) + '</button>').join('') +
    '<button type="button" class="set-theme" data-set-theme="custom" aria-pressed="' + (th.id === CUSTOM_THEME_ID) + '"><span class="set-dot set-dot-custom"></span>Personnalisé</button></div>';
  return card('Thème', '<div class="set-row is-stack"><div class="set-row-t"><span class="set-row-l">Couleur de l’application</span><span class="set-row-d">Choisis une palette ou compose ta propre couleur d’accent.</span></div><div class="set-row-c">' + themes + '</div></div>' +
    fieldRow('Couleur d’accent', 'Disponible avec le thème Personnalisé.', (id) => '<span class="set-color"><input type="color" id="' + id + '" data-set-color value="' + esc(th.accent.toLowerCase()) + '"' + (th.id === CUSTOM_THEME_ID ? '' : ' disabled') + '></span>'));
}

function regionPanel() {
  const r = getRegion();
  const vl = getVideoLangSetting();
  return card('Région', fieldRow('Pays', 'Disponibilités en streaming, classification par âge et sorties selon le pays.', (id) =>
    '<select class="set-input" id="' + id + '" data-set-pref="region">' + REGIONS.map((x) => '<option value="' + x.code + '"' + (x.code === r.code ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('') + '</select>')) +
    card('Bandes-annonces et synopsis', fieldRow('Langue', 'Les vidéos dans cette langue passent en premier, puis l’anglais.', (id) =>
      '<select class="set-input" id="' + id + '" data-set-pref="videolang"><option value="auto"' + (vl === 'auto' ? ' selected' : '') + '>Automatique (selon la région)</option>' +
      VIDEO_LANGS.map(([c, l]) => '<option value="' + c + '"' + (vl === c ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>'));
}

function playbackPanel() {
  const bw = getBandwidthSetting();
  const stored = readStoredBandwidth();
  const mbps = stored && stored.expiresAt > Date.now() ? (stored.kbps / 1000).toFixed(1).replace('.', ',') + ' Mb/s' : '';
  return card('Lancement', switchRow('Lancer la meilleure source', 'Démarre la lecture sans passer par la liste des sources.', getAutoplay(), 'data-set-pref="autoplay"')) +
    card('Connexion',
      fieldRow('Débit de ma connexion', 'Sert à choisir une source que ta connexion peut lire.', (id) =>
        '<select class="set-input" id="' + id + '" data-set-pref="bandwidth"><option value="auto"' + (bw === 'auto' ? ' selected' : '') + '>Automatique (mesure)</option>' +
        BANDWIDTH_PRESETS_MBPS.map((n) => '<option value="' + n + '"' + (bw === n ? ' selected' : '') + '>' + n + ' Mb/s</option>').join('') + '</select>') +
      rowHTML('Mesurer maintenant', '', () => '<button type="button" class="btn btn-ghost btn-sm" data-set-bw>Tester ma connexion</button>') +
      msgP('set-bw-msg', mbps ? 'Dernière mesure : ' + mbps : '')) +
    card('Séries et épisodes',
      switchRow('Passer l’intro', 'Saute le générique d’ouverture quand il est repéré.', getSkipPref('intro'), 'data-set-pref="skip-intro"') +
      switchRow('Passer le récapitulatif', 'Saute le « précédemment » quand il est repéré.', getSkipPref('recap'), 'data-set-pref="skip-recap"') +
      switchRow('Enchaîner l’épisode suivant', 'Lance l’épisode suivant à la fin du générique.', getSkipPref('nextEpisode'), 'data-set-pref="skip-next"'));
}

const langOptions = (value, extra) => extra.map(([c, l]) => [c, l]).concat(LANG_CHOICES).map(([c, l]) => '<option value="' + c + '"' + (c === value ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
const langSelect = (pref, value, extra, disabled) => (id) => '<select class="set-input" id="' + id + '" data-set-pref="' + pref + '"' + (disabled ? ' disabled' : '') + '>' + langOptions(value, extra) + '</select>';

/** Langues audio et sous-titres du profil : appliquées au démarrage de chaque lecture (voir player/langPolicy.ts). */
function audioPanel() {
  const lp = getLangPrefs();
  return card('Langue audio',
    fieldRow('Langue audio principale', 'La piste utilisée en priorité. Dans cette langue, seuls les sous-titres forcés restent affichés.', langSelect('lang-audio', lp.audio, [])) +
    fieldRow('Langue audio secondaire', 'Utilisée quand la principale manque dans la source. « Version originale » prend la langue d’origine du titre.', langSelect('lang-audio2', lp.audio2, [[LANG_VO, 'Version originale'], [LANG_NONE, 'Aucune']]))) +
    card('Sous-titres',
      switchRow('Sous-titres hors langue principale', 'Les active quand l’audio n’est pas dans la langue principale.', lp.subsOn, 'data-set-pref="lang-subs"') +
      fieldRow('Langue des sous-titres', 'Pistes du fichier d’abord, puis sous-titres externes.', langSelect('lang-subtitles', lp.subs, [[LANG_MAIN, 'Identique à la langue principale']], !lp.subsOn)), { attrs: 'data-lang-subs-card' }) +
    card('Mode apprentissage de langue',
      switchRow('Apprendre une langue', 'Audio dans la langue apprise si elle existe, avec deux sous-titres : la langue apprise et ta langue principale.', lp.learn, 'data-set-pref="lang-learn"') +
      fieldRow('Langue apprise', '', langSelect('lang-learnlang', lp.learnLang, [], !lp.learn)));
}

function serverPanelInner() {
  const c = ed.cfg || {};
  const sv = c.services || {};
  const android = isAndroidApp();
  const base = getBase() || (android ? '' : DEFAULT_BASE);
  const services = serviceDefs().map(([k, title, desc]) => (k === 'openrouterModel'
    ? stackInput(title, desc, 'type="text" name="svc.' + k + '" value="' + esc(sv[k] || 'openai/gpt-4o-mini') + '"')
    : stackInput(title, desc, 'type="password" autocomplete="off" name="svc.' + k + '" placeholder="' + esc(secretPlaceholder(sv[k])) + '"'))).join('');
  return card('Adresse', stackInput('Adresse du serveur', 'Le serveur qui fournit le catalogue, les notes, la TV et les sources.' + (android ? ' Sur Android, c’est lastAddon sur ton PC : adresse du réseau local, par exemple http://192.168.1.20:7000.' : ''),
    'type="url" name="base" value="' + esc(base) + '" placeholder="' + (android ? 'http://192.168.1.20:7000' : 'http://localhost:7000') + '"') +
    actions('<button type="button" class="btn btn-ghost btn-sm" data-set-ping>Tester l’adresse</button>')) +
    card('Clés des services', services + actions('<button type="button" class="btn btn-ghost btn-sm" data-set-test="services">Tester les clés</button>') +
      '<div class="set-tests" id="set-tests-services" aria-live="polite"></div>', { desc: 'Catalogues, notes, saisons et recommandations. Laisse un champ vide pour garder la clé enregistrée.' });
}

function sourcesPanelInner() {
  const c = ed.cfg || {};
  const langs = c.languages || {};
  const pref = langs.preferred || ['fr', 'multi'];
  const res = c.resolutions || {};
  const allowed = res.allowed || RESOLUTIONS;
  const size = c.size || {};
  const resList = enumOf(['resolutions', 'allowed'], RESOLUTIONS) || RESOLUTIONS;
  const debrid = c.debrid;
  const num = (label, desc, attrs) => fieldRow(label, desc, (id) => '<input class="set-input set-input-sm" id="' + id + '" type="number" ' + attrs + '>');
  return card('Langues', rowHTML('Langues préférées', 'Les sources dans ces langues passent en premier.', () => chipsHTML('Langues préférées', LANGS.map(([v, l]) => chipHTML(l, pref.includes(v), 'data-set-toggle name="lang.' + v + '"')).join('')), { stack: true }) +
    switchRow('Accepter la VOSTFR', '', langs.acceptVostfr !== false, 'name="acceptVostfr"') +
    switchRow('Autres langues en dernier recours', 'Affiche les autres langues s’il n’y a rien dans ma langue.', langs.fallbackToOthers !== false, 'name="fallbackToOthers"')) +
    card('Résolutions', rowHTML('Résolutions acceptées', '', () => chipsHTML('Résolutions acceptées', resList.map((v) => chipHTML(v, allowed.includes(v), 'data-set-toggle name="res.' + v + '"')).join('')), { stack: true }) +
      fieldRow('Résolution maximale', '', (id) => '<select class="set-input" id="' + id + '" name="resMax"><option value="">Aucune limite</option>' +
        resList.map((v) => '<option value="' + v + '"' + (res.max === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>')) +
    card('Tailles et résultats',
      num('Taille minimale', 'En Go.', 'min="0" step="0.1" name="minGb" value="' + esc(size.minGb != null ? size.minGb : '') + '"') +
      num('Taille maximale', 'En Go.', 'min="0.1" step="0.1" name="maxGb" value="' + esc(size.maxGb != null ? size.maxGb : '') + '"') +
      num('Nombre de résultats', '', 'min="1" max="500" name="maxResults" value="' + esc(c.maxResults != null ? c.maxResults : 30) + '"')) +
    card('Sources', sourcesHTML() +
      actions('<button type="button" class="btn btn-ghost btn-sm" data-set-addsrc="upstream">Ajouter un addon amont</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-set-addsrc="torznab">Ajouter un Torznab</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-set-test="sources">Tester les sources</button>') +
      '<div class="set-tests" id="set-tests-sources" aria-live="polite"></div>', { desc: 'Addons amont et indexeurs interrogés pour trouver des sources.' }) +
    card('Debrid',
      switchRow('Activer AllDebrid', '', !!debrid, 'name="debridOn"') +
      stackInput('Clé API AllDebrid', 'Laisse vide pour garder la clé enregistrée.', 'type="password" autocomplete="off" name="debridKey" placeholder="' + esc(secretPlaceholder(debrid && debrid.apiKey)) + '"') +
      switchRow('Seulement les sources en cache', 'Masque les sources qu’AllDebrid doit d’abord télécharger.', !!c.onlyCached, 'name="onlyCached"') +
      actions('<button type="button" class="btn btn-ghost btn-sm" data-set-test="debrid">Tester AllDebrid</button>') +
      '<div class="set-tests" id="set-tests-debrid" aria-live="polite"></div>');
}

function serverFormHTML(cats) {
  const status = ed.loading ? 'Chargement de la configuration…' : ed.error ? ed.error : ed.loaded ? 'Configuration chargée.' : isConfigured() ? '' : 'Aucune configuration enregistrée : renseigne l’adresse puis enregistre.';
  const cat = (id) => cats.find((c) => c.id === id);
  return '<form id="set-la" class="set-form" autocomplete="off">' +
    panelHTML(cat('server'), 'Adresse du serveur et clés des services.', serverPanelInner()) +
    panelHTML(cat('sources'), 'Langues, résolutions, tailles, addons, indexeurs et AllDebrid.', sourcesPanelInner()) +
    '<div class="set-savebar"><div class="set-savebar-t">' + msgP('set-la-msg', status) +
    '<p class="set-note">Les clés sont chiffrées par le serveur ; ce navigateur ne garde que la configuration chiffrée.</p></div>' +
    '<button type="submit" class="btn btn-primary">Enregistrer</button></div></form>';
}

const PANEL_DESC = {
  account: 'Ton compte, ton profil actif et les données gardées dans ce navigateur.',
  appearance: 'Thème et couleur d’accent de l’application.',
  region: 'Pays, disponibilités et langue des bandes-annonces.',
  playback: 'Lancement des sources, connexion et enchaînement des épisodes.',
  audio: 'Langues de l’audio et des sous-titres, appliquées au début de chaque lecture sur ce profil.',
  home: 'Ce qui est proposé, ou non, sur l’accueil de ce profil.',
};

let activeCat = 'account';
let lockUntil = 0;

function categories() {
  return CATEGORIES.filter((c) => c.id !== 'home' || !isKidProfile());
}

function pageHTML() {
  const cats = categories();
  const cat = (id) => cats.find((c) => c.id === id);
  if (!cat(activeCat)) activeCat = cats[0].id;
  const panels = [
    panelHTML(cat('account'), PANEL_DESC.account, accountPanel()),
    panelHTML(cat('appearance'), PANEL_DESC.appearance, appearancePanel()),
    panelHTML(cat('region'), PANEL_DESC.region, regionPanel()),
    panelHTML(cat('playback'), PANEL_DESC.playback, playbackPanel()),
    panelHTML(cat('audio'), PANEL_DESC.audio, audioPanel()),
    cat('home') ? panelHTML(cat('home'), PANEL_DESC.home, homePanelHTML()) : '',
    serverFormHTML(cats),
  ].join('');
  return topBar(false) +
    '<article class="svc-page set-page" aria-labelledby="svc-title"><header class="set-head">' +
    '<p class="set-eyebrow">Laststream</p><h1 class="set-title" id="svc-title" tabindex="-1">Réglages</h1></header>' +
    '<div class="set-layout">' + navHTML(cats, activeCat) + '<div class="set-main">' + panels + '</div></div></article>';
}

function setActive(id) {
  activeCat = id;
  detailEl.querySelectorAll('[data-set-cat]').forEach((b) => {
    const on = b.dataset.setCat === id;
    b.setAttribute('aria-current', on ? 'true' : 'false');
    const nav = b.closest('.set-nav');
    if (on && nav && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2;
  });
}

/** Ancre : active la catégorie tout de suite (sans attendre le défilement) et amène son panneau en haut. */
export function goCategory(id) {
  const panel = detailEl.querySelector('#set-p-' + id);
  if (!panel) return;
  setActive(id);
  lockUntil = Date.now() + 800;
  if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.focus({ preventScroll: true });
}

/** Scrollspy : la catégorie active est celle du dernier panneau dont le haut a passé la ligne de lecture. */
export function syncActiveCategory() {
  if (state.kind !== 'settings' || Date.now() < lockUntil) return;
  const panels = Array.from(detailEl.querySelectorAll('.set-panel'));
  if (!panels.length) return;
  let cur = panels[0];
  panels.forEach((p) => { if (p.getBoundingClientRect().top <= 140) cur = p; });
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = panels[panels.length - 1];
  if (cur.dataset.cat !== activeCat) setActive(cur.dataset.cat);
}

let spyFrame = 0;
window.addEventListener('scroll', () => {
  if (state.kind !== 'settings' || spyFrame) return;
  spyFrame = requestAnimationFrame(() => { spyFrame = 0; syncActiveCategory(); });
}, { passive: true });
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
    initSources(ed.cfg.sources);
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
  activeCat = 'account';
  document.title = 'Réglages · Laststream';
  ed.loaded = false;
  ed.cfg = null;
  ed.schema = null;
  initSources([]);
  detailEl.innerHTML = pageHTML();
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  loadConfig();
}

// ---------- Lecture du formulaire ----------
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
  cfg.languages.preferred = LANGS.map(([v]) => v).filter((v) => f['lang.' + v] && isOn(f['lang.' + v]));
  cfg.languages.acceptVostfr = isOn(f.acceptVostfr);
  cfg.languages.fallbackToOthers = isOn(f.fallbackToOthers);
  const resList = enumOf(['resolutions', 'allowed'], RESOLUTIONS) || RESOLUTIONS;
  cfg.resolutions = cfg.resolutions || {};
  cfg.resolutions.allowed = resList.filter((v) => f['res.' + v] && isOn(f['res.' + v]));
  if (f.resMax.value) cfg.resolutions.max = f.resMax.value; else delete cfg.resolutions.max;
  cfg.size = cfg.size || {};
  ['minGb', 'maxGb'].forEach((k) => { if (f[k].value !== '') cfg.size[k] = Number(f[k].value); else delete cfg.size[k]; });
  if (f.maxResults.value !== '') cfg.maxResults = Number(f.maxResults.value);
  cfg.sources = serializeSources();
  cfg.onlyCached = isOn(f.onlyCached);
  if (isOn(f.debridOn)) {
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
    else { const src = res.sources.filter((x) => x.type !== 'alldebrid'); showTests('sources', src); applyTestResults(src); }
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
    pushConfig(config);
    clearCache();
    ed.cfg = (await decodeConfig(config, base)) || ed.cfg;
    initSources(ed.cfg.sources);
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

/** Effet d'un interrupteur de lecture : même écriture qu'avant (préférences locales), puis synchronisation du compte. */
function applyToggle(pref, on) {
  setTimeout(pushPrefs, 0);
  if (pref === 'autoplay') setAutoplay(on);
  else if (pref === 'skip-intro') setSkipPref('intro', on);
  else if (pref === 'skip-recap') setSkipPref('recap', on);
  else if (pref === 'skip-next') setSkipPref('nextEpisode', on);
  else if (pref === 'lang-subs' || pref === 'lang-learn') {
    setLangPrefs(pref === 'lang-subs' ? { subsOn: on } : { learn: on });
    syncLangRows();
  }
}

/** Les listes de langue des sous-titres et de la langue apprise se grisent avec leur interrupteur. */
function syncLangRows() {
  const lp = getLangPrefs();
  const subs = detailEl.querySelector('[data-set-pref="lang-subtitles"]');
  const learn = detailEl.querySelector('[data-set-pref="lang-learnlang"]');
  if (subs) subs.disabled = !lp.subsOn;
  if (learn) learn.disabled = !lp.learn;
}

// ---------- Événements (délégués, limités à la page) ----------
detailEl.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('.set-page')) return;
  const cat = t.closest('[data-set-cat]');
  if (cat) { e.preventDefault(); goCategory(cat.dataset.setCat); return; }
  const tg = t.closest('[data-set-toggle]');
  if (tg) {
    e.preventDefault();
    const on = flip(tg);
    if (tg.dataset.setPref) applyToggle(tg.dataset.setPref, on);
    return;
  }
  const swRow = t.closest('[data-sw-row]');
  if (swRow && !t.closest('button, a, input, select')) {
    const sw = swRow.querySelector('[data-set-toggle]');
    if (sw) sw.click();
    return;
  }
  if (t.closest('[data-set-ping]')) {
    const form = detailEl.querySelector('#set-la');
    const m = detailEl.querySelector('#set-la-msg');
    if (form && m) { m.textContent = 'Connexion en cours…'; m.textContent = (await testServer(form.elements.base.value)).message; }
    return;
  }
  const test = t.closest('[data-set-test]');
  if (test) { e.preventDefault(); runTest(test.dataset.setTest, test); return; }
  const th = t.closest('[data-set-theme]');
  if (th) {
    e.preventDefault();
    const id = th.dataset.setTheme;
    const cur = readTheme();
    const theme = id === CUSTOM_THEME_ID ? resolveTheme(CUSTOM_THEME_ID, isHexColor(cur.accent) ? cur.accent : '#ff5a36') : resolveTheme(id, null);
    saveTheme(theme);
    applyTheme(theme);
    pushPrefs();
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
  if (t.closest('[data-set-login]')) { e.preventDefault(); openLogin(); return; }
  if (t.closest('[data-set-switch]')) { e.preventDefault(); openPicker(); return; }
  if (t.closest('[data-set-logout]')) { e.preventDefault(); await signOut(); location.hash = '#/'; location.reload(); return; }
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
  setTimeout(pushPrefs, 0);
  if (p === 'lang-audio') setLangPrefs({ audio: t.value });
  else if (p === 'lang-audio2') setLangPrefs({ audio2: t.value });
  else if (p === 'lang-subtitles') setLangPrefs({ subs: t.value });
  else if (p === 'lang-learnlang') setLangPrefs({ learnLang: t.value });
  else if (p === 'bandwidth') setBandwidthSetting(t.value === 'auto' ? 'auto' : Number(t.value));
  else if (p === 'videolang') {
    setVideoLang(t.value);
    clearCache();
    toast('Langue mise à jour : rechargement…');
    setTimeout(() => location.reload(), 600);
  } else if (p === 'region') {
    setRegion(t.value);
    try { localStorage.removeItem('ls_tv_filters'); } catch (_) { /* ignoré */ }
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

detailEl.addEventListener('submit', async (e) => {
  if (e.target && e.target.id === 'set-stremio') {
    e.preventDefault();
    const f = e.target.elements;
    const msg = detailEl.querySelector('#set-st-msg');
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    msg.textContent = 'Import en cours (peut prendre un moment)…';
    try {
      const res = await importFromStremio(f.email.value.trim(), f.password.value, getConfig());
      f.password.value = '';
      const n = ['imported', 'added', 'count', 'library'].map((k) => res[k]).find((v) => typeof v === 'number');
      msg.textContent = n != null ? n + ' titre(s) importé(s).' : 'Import terminé.';
      toast('Bibliothèque Stremio importée');
    } catch (err) {
      msg.textContent = errorText(err);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (e.target && e.target.id === 'set-la') { e.preventDefault(); save(e.target); }
});
