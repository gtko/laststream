/* Page #/settings : lastAddon (schéma, clés, addons Stremio), lecture, apparence, région. */
import { applyTestResults, initSources, serializeSources, sourcesHTML } from './settings-sources.js';
import { decodeConfig, encodeConfig, getSchema, isMask, testConfig } from '../data/configApi';
import { testServer } from '../data/serverTest';
import { DEFAULT_BASE, getBase, getConfig, getCustom, getMode, isAndroidApp, isConfigured, normalizeBase, saveSettings } from '../data/config';
import { laststreamBase, PUBLIC_PROBE_MS, probeHealth, serverChoiceVisible, switchServer } from '../data/serverMode';
import { clearCache } from '../data/transport';
import {
  BANDWIDTH_PRESETS_MBPS, getAutoplay, getBandwidthSetting, getRegion, getSkipPref, getVideoLangSetting, REGIONS, VIDEO_LANGS, setVideoLang,
  setAutoplay, setBandwidthSetting, setRegion, setSkipPref, getTrailerAutoplay, setTrailerAutoplay,
} from '../data/prefs';
import { testBandwidthKbps, readStoredBandwidth } from '../data/sources';
import { getBufferLevel, setBufferLevel } from '../player/bufferLevel';
import { getLangPrefs, LANG_CHOICES, LANG_MAIN, LANG_NONE, LANG_VO, setLangPrefs } from '../data/langPrefs';
import { userStore } from '../data/userStore';
import { auth, canAdmin, isKidProfile, isMainProfile, isProfileLocked, isServerMode, parentalCodeMissing, pushConfig, pushPrefs, saveProfile, signOut } from '../data/auth';
import { errorText, openLogin, openPicker } from './auth-ui.js';
import { creditsLinkHTML } from './credits.js';
import { modelComboHTML } from './model-combobox.js';
import { homePanelHTML } from './homeprefs.js';
import { tvPanelHTML } from './settings-tv.js';
import { appearancePanel } from './settings-appearance.js';
import { invitesCard, refreshInvites } from './invites.js';
import { stremioImportCard } from './stremio-import.js';
import { householdInvitesCard, refreshHouseholdInvites, resetHouseholdList } from './household.js';
import {
  CATEGORIES, card, fieldRow, flip, isOn, navHTML, panelHTML, rowHTML, switchRow,
} from './settings-ui.js';
import { bindSettingsNav, syncNav } from './settings-nav.js';
import { detailEl, toast } from './dom.js';
import { esc } from './util.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { applyDownloadToggle, downloadsStorageCard } from './settings-downloads.js';
import { state } from './state.js';

const SERVICE_FALLBACK = {
  tmdbToken: ['Jeton TMDB (lecture v4)', 'Catalogues, fiches et recommandations.'],
  mdblistApiKey: ['Clé MDBList', 'Notes IMDb, Rotten Tomatoes, Metacritic, Letterboxd.'],
  tvdbApiKey: ['Clé TheTVDB', 'Saisons et prochain épisode des séries.'],
  tvdbPin: ['PIN d’abonné TVDB', 'Seulement pour une clé v4 personnelle.'],
  openrouterApiKey: ['Clé OpenRouter', 'Recommandations IA et textes sur les personnes.'],
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

const stackInput = (label, desc, attrs) => fieldRow(label, desc, (id) => '<input class="set-input" id="' + id + '" ' + attrs + '>', { stack: true });
const msgP = (id, text) => '<p class="set-msg" id="' + id + '" role="status">' + esc(text || '') + '</p>';
const actions = (inner) => '<div class="set-actions">' + inner + '</div>';

/** Propriétaire sur un profil adulte : accès à la console #/admin. */
/** Profil principal, un profil enfant existe mais aucun code parental : invitation à en définir un. */
const parentalCard = () => (isServerMode() && isMainProfile() && !isKidProfile() && parentalCodeMissing()
  ? card('Définis un code parental',
    '<form id="set-parental" class="set-form" autocomplete="off"><p class="set-hint">Un profil enfant existe, mais rien n’empêche de le quitter. Choisis un code à 4 chiffres : il sera demandé pour sortir d’un profil enfant, changer de profil ou ouvrir les réglages.</p>' +
    stackInput('Code parental (4 chiffres)', '', 'type="password" name="pin" inputmode="numeric" pattern="\d{4}" maxlength="4" required autocomplete="off"') +
    msgP('set-parental-msg') + actions('<button type="submit" class="btn btn-primary">Définir le code</button>') + '</form>')
  : '');
const adminCard = () => (canAdmin() ? card('Administration', rowHTML('Console d’administration', 'Comptes, performance, caches, modération et réglages du serveur.', () => '<a class="btn btn-ghost btn-sm" href="#/admin" data-go>Administration</a>')) : '');

function accountPanel() {
  const p = userStore.currentProfile();
  const lib = userStore.getLibrary().length;
  const data = card('Données de ce navigateur', rowHTML('Bibliothèque', 'Titres gardés pour le profil « ' + p.name + ' » dans ce navigateur.', () => '<span class="set-val">' + lib + ' titre(s)</span>') +
    rowHTML('Vider le cache', 'Supprime les réponses mémorisées du catalogue ; rien d’autre n’est effacé.', () => '<button type="button" class="btn btn-ghost btn-sm" data-set-clear>Vider le cache</button>'));
  if (!isServerMode()) {
    return card('Compte', '<p class="set-hint">' + (auth.status === 'offline'
      ? 'lastAddon est injoignable : la bibliothèque et la progression restent dans ce navigateur.'
      : 'La bibliothèque et la progression restent dans ce navigateur. Un compte lastAddon les garde sur ton serveur, avec des profils.') + '</p>' +
      actions('<button type="button" class="btn btn-primary" data-set-login>Se connecter ou créer un compte</button>')) + data;
  }
  const pr = auth.profile;
  return card('Compte et profils',
    rowHTML('Connecté en tant que', '', () => '<span class="set-val">' + esc(auth.username) + '</span>') +
    rowHTML('Profil actif', pr.isKid ? 'Profil enfant' : '', () => '<span class="set-val">' + esc(pr.name) + '</span>' +
      (isProfileLocked() ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-set-switch>Changer de profil</button>')) +
    rowHTML('Session', '', () => '<button type="button" class="btn btn-ghost btn-sm" data-set-logout>Se déconnecter</button>')) + parentalCard() + adminCard() +
    (isProfileLocked() ? '' : invitesCard()) + householdInvitesCard() + data +
    stremioImportCard();
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
  return card('Lancement', switchRow('Lancer la meilleure source', 'Démarre la lecture sans passer par la liste des sources.', getAutoplay(), 'data-set-pref="autoplay"') +
    switchRow('Lancer automatiquement après la bande-annonce', 'Sur la fiche d’un titre, la bande-annonce se lance puis enchaîne sur la lecture.',
      getTrailerAutoplay(isKidProfile()), 'data-set-pref="trailer-autoplay"')) +
    card('Connexion',
      fieldRow('Débit de ma connexion', 'Sert à choisir une source que ta connexion peut lire.', (id) =>
        '<select class="set-input" id="' + id + '" data-set-pref="bandwidth"><option value="auto"' + (bw === 'auto' ? ' selected' : '') + '>Automatique (mesure)</option>' +
        BANDWIDTH_PRESETS_MBPS.map((n) => '<option value="' + n + '"' + (bw === n ? ' selected' : '') + '>' + n + ' Mb/s</option>').join('') + '</select>') +
      rowHTML('Mesurer maintenant', '', () => '<button type="button" class="btn btn-ghost btn-sm" data-set-bw>Tester ma connexion</button>') +
      msgP('set-bw-msg', mbps ? 'Dernière mesure : ' + mbps : '')) +
    card('Mémoire tampon',
      fieldRow('Taille de la mémoire tampon', 'Sur cet appareil. Un tampon plus grand évite les saccades de chargement sur une source lente, mais utilise plus de mémoire et, sur Android, retarde le démarrage et les sauts de quelques secondes (jusqu’à 30 s en Maximum). Appliqué à la prochaine lecture.', (id) =>
        '<select class="set-input" id="' + id + '" data-set-pref="buffer-level">' + BUFFER_CHOICES.map(([c, l]) => '<option value="' + c + '"' + (c === getBufferLevel() ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>')) +
    card('Séries et épisodes',
      switchRow('Passer l’intro', 'Saute le générique d’ouverture quand il est repéré.', getSkipPref('intro'), 'data-set-pref="skip-intro"') +
      switchRow('Passer le récapitulatif', 'Saute le « précédemment » quand il est repéré.', getSkipPref('recap'), 'data-set-pref="skip-recap"') +
      switchRow('Enchaîner l’épisode suivant', 'Lance l’épisode suivant à la fin du générique.', getSkipPref('nextEpisode'), 'data-set-pref="skip-next"')) +
    downloadsStorageCard();
}

const langOptions = (value, extra) => extra.map(([c, l]) => [c, l]).concat(LANG_CHOICES).map(([c, l]) => '<option value="' + c + '"' + (c === value ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
const langSelect = (pref, value, extra, disabled) => (id) => '<select class="set-input" id="' + id + '" data-set-pref="' + pref + '"' + (disabled ? ' disabled' : '') + '>' + langOptions(value, extra) + '</select>';

/** Niveaux de la mémoire tampon : valeurs du contrat partagé (voir player/bufferLevel.ts). */
const BUFFER_CHOICES = [['standard', 'Standard'], ['large', 'Grand'], ['max', 'Maximum']];

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

/** Choix du serveur (Android et pages servies par lastAddon) : Laststream par défaut, ou un serveur perso. */
function serverChoiceHTML() {
  const mode = ed.srvMode || getMode() || 'public';
  const laststream = laststreamBase();
  const btn = (id, label) => '<button type="button" class="btn ' + (mode === id ? 'btn-primary' : 'btn-ghost') + ' btn-sm" data-set-srvmode="' + id + '" aria-pressed="' + (mode === id) + '">' + label + '</button>';
  return actions(btn('public', 'Serveur Laststream (par défaut)') + btn('custom', 'Mon propre serveur')) +
    (mode === 'public'
      ? '<p class="set-hint">Adresse : <b>' + esc(laststream) + '</b>. Le catalogue, les notes et les sources passent par ce serveur.</p>' +
        '<input type="hidden" name="base" value="' + esc(laststream) + '">'
      : stackInput('Adresse de mon serveur', 'Ton propre lastAddon : par exemple http://192.168.1.20:7000 sur le réseau local, ou une adresse https.',
        'type="url" name="base" value="' + esc(getCustom() || getBase()) + '" placeholder="http://192.168.1.20:7000"') +
        actions('<button type="button" class="btn btn-ghost btn-sm" data-set-ping>Tester</button>'));
}

function serverPanelInner() {
  const c = ed.cfg || {};
  const sv = c.services || {};
  const android = isAndroidApp();
  const choice = serverChoiceVisible();
  const base = getBase() || (android ? '' : DEFAULT_BASE);
  const services = serviceDefs().map(([k, title, desc]) => (k === 'openrouterModel'
    ? fieldRow(title, desc, (id) => modelComboHTML(id, sv[k] || 'openai/gpt-4o-mini'), { stack: true })
    : stackInput(title, desc, 'type="password" autocomplete="off" name="svc.' + k + '" placeholder="' + esc(secretPlaceholder(sv[k])) + '"'))).join('');
  return card('Adresse', choice ? serverChoiceHTML() : stackInput('Adresse du serveur', 'Le serveur qui fournit le catalogue, les notes, la TV et les sources.',
    'type="url" name="base" value="' + esc(base) + '" placeholder="http://localhost:7000"') +
    actions('<button type="button" class="btn btn-ghost btn-sm" data-set-ping>Tester l’adresse</button>')) +
    card('Clés des services', services + actions('<button type="button" class="btn btn-ghost btn-sm" data-set-test="services">Tester les clés</button>') +
      '<div class="set-tests" id="set-tests-services" aria-live="polite"></div>', { desc: 'Catalogues, notes, saisons et recommandations. Laisse un champ vide pour garder la clé enregistrée.' });
}

function sourcesPanelInner() {
  const c = ed.cfg || {};
  const res = c.resolutions || {};
  const maxChoices = [['', 'Aucune limite'], ['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p']];
  return card('Addons Stremio', sourcesHTML() +
    actions('<button type="button" class="btn btn-ghost btn-sm" data-set-addsrc="upstream">Ajouter un addon Stremio</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-set-test="sources">Tester les sources</button>') +
    '<div class="set-tests" id="set-tests-sources" aria-live="polite"></div>', { desc: 'Les addons interrogés pour trouver des sources. Ils débrident eux-mêmes : la clé de ton débrideur se règle dans l’addon.' }) +
    card('Préférences de lecture',
      fieldRow('Qualité maximale', 'Les sources au-dessus de cette qualité sont masquées.', (id) => '<select class="set-input" id="' + id + '" name="resMax">' +
        maxChoices.map(([v, l]) => '<option value="' + v + '"' + ((res.max || '') === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>'));
}

function serverFormHTML(cats) {
  const status = ed.loading ? 'Chargement de la configuration…' : ed.error ? ed.error : ed.loaded ? 'Configuration chargée.' : isConfigured() ? '' : 'Aucune configuration enregistrée : renseigne l’adresse puis enregistre.';
  const cat = (id) => cats.find((c) => c.id === id);
  return '<form id="set-la" class="set-form" autocomplete="off">' +
    panelHTML(cat('server'), 'Adresse du serveur et clés des services.', serverPanelInner()) +
    panelHTML(cat('sources'), 'Tes extensions Stremio, dans l’ordre où elles sont interrogées.', sourcesPanelInner()) +
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
  tv: 'Chaînes de ta box et playlists M3U, lues par cet appareil.',
};

let activeCat = 'account';
let lockUntil = 0;

function categories() {
  // Session verrouillée (profil invité au foyer) : pas d'extensions (Sources) ni de serveur lastAddon.
  const main = isMainProfile() && !isKidProfile() && !isProfileLocked();
  return CATEGORIES.filter((c) => ((c.id !== 'home' && c.id !== 'tv') || !isKidProfile()) && (main || (c.id !== 'server' && c.id !== 'sources')));
}

/** Pastilles du menu : uniquement des états réels (serveur injoignable ou non configuré). */
function navBadges() {
  return ed.error || !isConfigured() ? { server: ed.error ? 'serveur injoignable' : 'configuration manquante' } : {};
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
    cat('tv') ? panelHTML(cat('tv'), PANEL_DESC.tv, tvPanelHTML()) : '',
    cat('server') ? serverFormHTML(cats) : '',
  ].join('');
  return topBar(false) +
    '<article class="svc-page set-page" aria-labelledby="svc-title"><header class="set-head">' +
    '<p class="set-eyebrow">Laststream</p><h1 class="set-title" id="svc-title" tabindex="-1">Réglages</h1></header>' +
    '<div class="set-layout">' + navHTML(cats, activeCat, navBadges()) + '<div class="set-main">' + panels + '</div></div><p class="set-foot">' + creditsLinkHTML() + '</p></article>';
}

function setActive(id) {
  activeCat = id;
  syncNav(detailEl, id);
}

bindSettingsNav(detailEl, (id) => goCategory(id));

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

/** Efface la clé de débrideur résiduelle de la configuration serveur (jamais affichée), sans toucher au reste. */
async function dropServerDebridKey(decoded, enc, base) {
  try {
    const clean = { ...decoded };
    delete clean.debrid;
    delete clean.onlyCached;
    const config = await encodeConfig(clean, enc, base);
    saveSettings({ base, config });
    pushConfig(config);
    clearCache();
    ed.cfg = (await decodeConfig(config, base)) || clean;
  } catch (_) { /* repli : elle sera retirée au prochain enregistrement */ }
}

async function loadConfig() {
  if (!detailEl.querySelector('#set-la')) return; // profil secondaire ou enfant : ni sources ni clés
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
    if (decoded && decoded.debrid) await dropServerDebridKey(decoded, enc, base);
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
  resetHouseholdList();
  detailEl.innerHTML = pageHTML();
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  if (isServerMode() && !isProfileLocked()) refreshInvites();
  if (isServerMode()) void refreshHouseholdInvites();
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
  // Langues : dérivées de la langue audio principale (« Audio et sous-titres »). VF/MULTI d'abord si le français est choisi,
  // VOSTFR accepté si les sous-titres sont activés, les autres langues toujours en dernier recours.
  const lp = getLangPrefs();
  const main = ['fr', 'en', 'es', 'de', 'it'].includes(lp.audio) ? lp.audio : 'original';
  cfg.languages = { preferred: [main, 'multi'], acceptVostfr: !!lp.subsOn, fallbackToOthers: true };
  // Résolution maximale seule réglable ; tailles et nombre de résultats : valeurs par défaut du serveur.
  cfg.resolutions = cfg.resolutions || {};
  delete cfg.resolutions.allowed;
  if (f.resMax && f.resMax.value) cfg.resolutions.max = f.resMax.value; else delete cfg.resolutions.max;
  delete cfg.size;
  delete cfg.maxResults;
  cfg.sources = serializeSources();
  cfg.onlyCached = isOn(f.onlyCached);
  // Les clés des débrideurs restent sur l'appareil (réglages ci-dessus) : la configuration serveur ne reçoit plus de clé.
  if (f.debridClear && isOn(f.debridClear)) delete cfg.debrid;
  // Plus de débrideur dans Laststream : les addons débrident eux-mêmes.
  delete cfg.onlyCached;
  delete cfg.debrid;
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
    else { const src = res.sources.filter((x) => x.type !== 'alldebrid'); showTests('sources', src); applyTestResults(src); }
  } catch (err) {
    if (box) box.innerHTML = '<p class="set-test is-ko">' + esc(issuesText(err) || 'Test impossible : vérifie l’adresse et la configuration.') + '</p>';
  } finally {
    btn.disabled = false;
  }
}

/** « Serveur Laststream » s'applique tout de suite (l'application redémarre si le serveur change) ; « Mon propre serveur » attend « Enregistrer ». */
function chooseServerMode(mode) {
  if (mode === 'custom') { ed.srvMode = 'custom'; rerender(); return; }
  ed.srvMode = 'public';
  if (!switchServer({ mode: 'public' })) rerender();
}

/** Test d'un serveur perso : /health, message OK ou erreur. */
async function pingMessage(raw) {
  let base = '';
  try { base = normalizeBase(raw); } catch (err) { return err.message; }
  if (!base) return 'Saisis l’adresse de ton serveur, par exemple http://192.168.1.20:7000.';
  return (await probeHealth(base, PUBLIC_PROBE_MS))
    ? 'OK : lastAddon répond à cette adresse.'
    : 'Erreur : serveur injoignable, ou ce n’est pas lastAddon. Vérifie l’adresse et que lastAddon tourne.';
}

async function save(form) {
  const msg = detailEl.querySelector('#set-la-msg');
  if (msg) msg.textContent = 'Enregistrement…';
  try {
    const choice = serverChoiceVisible() ? (ed.srvMode || getMode() || 'public') : null;
    if (choice === 'custom' && !form.elements.base.value.trim()) throw new Error('Saisis l’adresse de ton serveur.');
    const { base, config } = await encodeFromForm(form);
    if (choice) {
      // Serveur changé : l'application redémarre avec la config chiffrée de ce serveur.
      if (switchServer({ mode: choice, custom: choice === 'custom' ? base : undefined }, config)) return;
    } else {
      saveSettings({ base, config });
    }
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
  else if (pref === 'trailer-autoplay') setTrailerAutoplay(on);
  else if (pref === 'dl-wifi') applyDownloadToggle(pref, on);
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
    if (form && m) {
      m.textContent = 'Connexion en cours…';
      m.textContent = serverChoiceVisible() ? await pingMessage(form.elements.base.value) : (await testServer(form.elements.base.value)).message;
    }
    return;
  }
  const srvMode = t.closest('[data-set-srvmode]');
  if (srvMode) { e.preventDefault(); chooseServerMode(srvMode.dataset.setSrvmode); return; }
  const test = t.closest('[data-set-test]');
  if (test) { e.preventDefault(); runTest(test.dataset.setTest, test); return; }
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
  else if (p === 'buffer-level') setBufferLevel(t.value);
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

detailEl.addEventListener('submit', async (e) => {
  if (e.target && e.target.id === 'set-parental') {
    e.preventDefault();
    const pin = e.target.elements.pin.value.trim();
    const msg = detailEl.querySelector('#set-parental-msg');
    if (!/^d{4}$/.test(pin)) { msg.textContent = 'Le code compte 4 chiffres.'; return; }
    try {
      await saveProfile(auth.profile.id, { pin });
      toast('Code parental défini');
      rerender();
    } catch (err) {
      msg.textContent = errorText(err);
    }
    return;
  }
  if (e.target && e.target.id === 'set-la') { e.preventDefault(); save(e.target); }
});
