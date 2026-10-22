/* Réglages > TV en direct : « Ma box TV » (Freebox) et playlists M3U de l'utilisateur (avec guide XMLTV facultatif).
 * Les playlists sont lues par l'appareil ; leur définition (nom, adresse, guide) est synchronisée avec le compte, chiffrée côté
 * serveur, et écrite par le seul profil principal. Les adresses ne sont jamais affichées en clair (identifiants fréquents). */
import {
  BOX_MESSAGES, BoxError, channelsFromText, FREEBOX_LIST_ID, FREEBOX_PLAYLIST_URL, fetchBoxChannels, getBoxQuality, getBoxReach, isHttpUrl,
  maskUrl, newListId, QUALITY_KEYS, QUALITY_LABELS, setBoxQuality, setBoxReach,
} from '../data/tvBox';
import { addList, BOX_CHANGED, getLists, refreshAll, removeList, updateList } from '../data/tvSources';
import { getMolotovStatus, molotovWay } from '../data/molotovApi';
import { connectMolotovWithPassword, disconnectMolotovAccount, MolotovAuthError } from '../data/molotovAuth';
import { isMainProfile, isServerMode } from '../data/auth';
import { card, fieldRow, rowHTML } from './settings-ui.js';
import { detailEl } from './dom.js';
import { esc } from './util.js';

/** Écriture permise : hors compte serveur, ou profil principal (le serveur refuse les autres : `main_profile_required`). */
const canEdit = () => !isServerMode() || isMainProfile();

const plural = (n) => n + ' chaîne' + (n > 1 ? 's' : '');

function listRow(l, edit) {
  const reach = getBoxReach(l.id);
  const state = !l.enabled ? 'désactivée' : reach === false ? 'injoignable pour l’instant' : plural(l.channels.length);
  const src = l.kind === 'file' ? 'Fichier importé sur cet appareil' : l.kind === 'freebox' ? 'Freebox détectée sur cet appareil' : maskUrl(l.url);
  const guide = l.guideUrl ? ' · guide : ' + maskUrl(l.guideUrl) : '';
  const sync = l.synced ? ' · synchronisée avec le compte' : '';
  return '<div class="set-row is-stack" data-nav data-box-list="' + esc(l.id) + '"><div class="set-row-t">' +
    (edit ? '<input class="set-input" type="text" value="' + esc(l.name) + '" maxlength="60" aria-label="Nom de la playlist" data-box-rename="' + esc(l.id) + '">'
      : '<span class="set-row-l">' + esc(l.name) + '</span>') +
    '<span class="set-row-d">' + esc(src + guide + ' · ' + state + sync) + '</span></div>' +
    (edit ? '<div class="set-actions"><button type="button" class="btn btn-ghost btn-sm" data-box-toggle="' + esc(l.id) + '">' + (l.enabled ? 'Désactiver' : 'Activer') + '</button>' +
      (l.kind === 'file' ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-box-refresh="' + esc(l.id) + '">Actualiser</button>') +
      '<button type="button" class="btn btn-ghost btn-sm" data-box-remove="' + esc(l.id) + '">Retirer</button></div>' : '') + '</div>';
}

/** Contenu qui change selon les playlists (état, liste) : redessiné à chaque changement. */
function dynamicHTML() {
  const lists = getLists();
  const edit = canEdit();
  const fb = lists.find((l) => l.id === FREEBOX_LIST_ID);
  const q = getBoxQuality();
  return card('Ma box TV',
    rowHTML('Freebox', fb ? plural(fb.channels.length) + (getBoxReach(fb.id) === false ? ' · box injoignable (hors du réseau local)' : '') : 'Détecte les chaînes de ta Freebox quand tu es chez toi.',
      () => '<button type="button" class="btn btn-ghost btn-sm" data-box-detect>' + (fb ? 'Mettre à jour' : 'Détecter ma Freebox') + '</button>') +
    fieldRow('Qualité préférée', 'Les chaînes de la box existent en plusieurs qualités ; HD par défaut, sinon la meilleure disponible.', (id) =>
      '<select class="set-input" id="' + id + '" data-box-quality>' + QUALITY_KEYS.map((k) => '<option value="' + k + '"' + (k === q ? ' selected' : '') + '>' + QUALITY_LABELS[k] + '</option>').join('') + '</select>') +
    '<p class="set-msg" id="tv-box-msg" role="status"></p>',
    { desc: 'Les chaînes de ta box s’ajoutent à la TV en direct avec le badge « Box » et sont lues par l’app sur le réseau de ta box.' }) +
    card('Playlists M3U', (lists.filter((l) => l.id !== FREEBOX_LIST_ID).map((l) => listRow(l, edit)).join('') || '<p class="set-msg">Aucune playlist ajoutée.</p>') +
      (edit ? '' : '<p class="set-msg">Les playlists du compte sont gérées par le profil principal.</p>'),
    { desc: 'Playlists que tu as choisies toi-même. Lues par cet appareil, jamais par le serveur.' }) +
    molotovCardHTML();
}

/** Formulaire d'ajout : statique (il garde ce que l'on tape pendant les actualisations). */
function addHTML() {
  if (!canEdit()) return '';
  return card('Ajouter une playlist M3U',
    fieldRow('Nom', 'Facultatif.', (id) => '<input class="set-input" id="' + id + '" type="text" maxlength="60" data-box-name autocomplete="off">', { stack: true }) +
    fieldRow('Adresse de la playlist', 'URL http(s) d’un fichier M3U. Elle peut contenir des identifiants : enregistrée chiffrée sur ton compte, jamais affichée.', (id) =>
      '<input class="set-input" id="' + id + '" type="url" placeholder="http://…/get.php?username=…" data-box-url autocomplete="off" spellcheck="false">', { stack: true }) +
    fieldRow('Guide des programmes (XMLTV)', 'Facultatif : URL d’un fichier .xml ou .xml.gz. Lu sur cet appareil, de maintenant à +24 h.', (id) =>
      '<input class="set-input" id="' + id + '" type="url" placeholder="http://…/xmltv.xml.gz" data-box-guide autocomplete="off" spellcheck="false">', { stack: true }) +
    '<div class="set-actions"><button type="button" class="btn btn-primary btn-sm" data-box-add>Ajouter la playlist</button>' +
    '<label class="btn btn-ghost btn-sm">Importer un fichier<input type="file" accept=".m3u,.m3u8,text/plain,audio/x-mpegurl" hidden data-box-file></label></div>',
    {});
}

export function tvPanelHTML() {
  const web = typeof window !== 'undefined' && !window.chrome?.webview && !(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
  loadMolotovStatusSoon();
  return '<div id="tv-box-dyn">' + dynamicHTML() + '</div>' + addHTML() +
    (web ? '<p class="set-msg">Un navigateur ne peut pas joindre ta box ni la plupart des playlists : disponible dans les apps Windows et Android.</p>' : '');
}

const say = (text) => { const el = detailEl.querySelector('#tv-box-msg'); if (el) el.textContent = text; };
const errText = (err) => (err instanceof BoxError ? BOX_MESSAGES[err.code] : 'Playlist illisible.');
const rerender = () => {
  const el = detailEl.querySelector('#tv-box-dyn');
  if (el) el.innerHTML = dynamicHTML();
};

// ---------- Molotov (TV française) ----------

/** État de la connexion Molotov, redessiné à chaque changement. `draft` garde la saisie du formulaire entre les rendus. */
const molotov = { status: null, loading: false, msg: '', form: false, draft: { email: '', password: '' } };

const molotovErrorText = (err) => {
  if (err instanceof MolotovAuthError) {
    if (err.code === 'invalid_credentials') return 'Email ou mot de passe Molotov incorrect.';
    if (err.code === 'mfa_required') return 'La connexion Molotov demande une vérification en deux étapes : non gérée pour l’instant.';
    return err.message;
  }
  if (err && err.status === 404) return 'Ce serveur ne gère pas encore Molotov.';
  if (err && err.code === 'network') return 'Serveur injoignable.';
  return err instanceof Error ? err.message : 'Connexion Molotov impossible.';
};

/** Mini-formulaire de connexion par email et mot de passe : la saisie vit dans `molotov.draft` (les rendus la reprennent). */
function molotovFormHTML() {
  return '<div class="set-actions">' +
    '<input class="set-input" type="email" placeholder="Email Molotov" aria-label="Email Molotov" autocomplete="username" spellcheck="false" value="' + esc(molotov.draft.email) + '" data-molotov-email>' +
    '<input class="set-input" type="password" placeholder="Mot de passe Molotov" aria-label="Mot de passe Molotov" autocomplete="current-password" value="' + esc(molotov.draft.password) + '" data-molotov-password>' +
    '<button type="button" class="btn btn-primary btn-sm" data-molotov-signin>Se connecter</button>' +
    '</div>';
}

/** Carte « Molotov » : état de la connexion, connexion par email et mot de passe, déconnexion. */
function molotovCardHTML() {
  const st = molotov.status;
  const connected = !!(st && st.connected);
  const state = molotov.loading ? 'Lecture du compte.'
    : !st ? 'État inconnu'
      : connected ? 'Connecté' + (st.tier ? ' — ' + st.tier : '') + (st.channelCount != null ? ' — ' + st.channelCount + ' chaînes' : '')
        : 'Déconnecté';
  const edit = canEdit();
  const actions = !edit
    ? '<p class="set-msg">La connexion Molotov est gérée par le profil principal.</p>'
    : connected
      ? '<button type="button" class="btn btn-ghost btn-sm" data-molotov-disconnect>Déconnecter</button>'
      : molotov.form ? molotovFormHTML()
        : '<button type="button" class="btn btn-primary btn-sm" data-molotov-connect>Connecter un compte Molotov</button>';
  return card('Molotov - TV française',
    rowHTML('Compte Molotov', state, () => actions, { stack: !edit || (!connected && molotov.form) }) +
    rowHTML('Appels vers Molotov', molotovWay() === 'direct' ? 'Direct depuis cet appareil : les jetons ne quittent pas l\'appareil.' : 'Via le relais du serveur : un navigateur ne peut pas appeler l\'API Molotov (CORS).', () => '') +
    '<p class="set-msg" id="molotov-msg" role="status">' + esc(molotov.msg) + '</p>',
    { desc: 'Connecte un compte Molotov : ses chaînes s\'ajoutent à la TV en direct. La lecture DASH (Widevine) marche là où un module Widevine est disponible : navigateurs, Android et Windows (WebView).' });
}

let molotovTimer = 0;

/** Charge l'état de la connexion (à l'ouverture du panneau). */
function loadMolotovStatusSoon() {
  if (molotovTimer || molotov.status || molotov.loading) return;
  molotovTimer = setTimeout(() => { molotovTimer = 0; loadMolotovStatus(); }, 0);
}

async function loadMolotovStatus() {
  molotov.loading = true;
  try {
    molotov.status = await getMolotovStatus();
  } catch (err) {
    molotov.status = { connected: false };
    molotov.msg = molotovErrorText(err);
  } finally {
    molotov.loading = false;
    rerender();
  }
}

/** Connexion par email et mot de passe (formulaire de la carte). */
async function molotovSignin() {
  const email = molotov.draft.email.trim();
  const password = molotov.draft.password;
  if (!email || !password) {
    molotov.msg = 'Renseigne ton email et ton mot de passe Molotov.';
    rerender();
    return;
  }
  molotov.loading = true;
  molotov.msg = 'Connexion à Molotov.';
  rerender();
  try {
    molotov.status = await connectMolotovWithPassword(email, password);
    molotov.form = false;
    molotov.draft = { email: '', password: '' };
    molotov.msg = 'Compte Molotov connecté.';
  } catch (err) {
    molotov.msg = molotovErrorText(err);
  } finally {
    molotov.loading = false;
    rerender();
  }
}

async function molotovDisconnect() {
  molotov.loading = true;
  rerender();
  try {
    await disconnectMolotovAccount();
    molotov.status = { connected: false };
    molotov.msg = 'Compte Molotov déconnecté.';
  } catch (err) {
    molotov.msg = molotovErrorText(err);
  } finally {
    molotov.loading = false;
    rerender();
  }
}

window.addEventListener(BOX_CHANGED, rerender);

async function detect() {
  say('Recherche de ta Freebox…');
  try {
    const channels = await fetchBoxChannels(FREEBOX_PLAYLIST_URL, { list: FREEBOX_LIST_ID, freebox: true });
    setBoxReach(FREEBOX_LIST_ID, true);
    addList({ id: FREEBOX_LIST_ID, name: 'Ma Freebox', kind: 'freebox', url: FREEBOX_PLAYLIST_URL, guideUrl: '', enabled: true, channels, synced: false });
    say(plural(channels.length) + ' trouvée' + (channels.length > 1 ? 's' : '') + '. Elles sont dans la TV en direct, catégorie « Ma box ».');
  } catch (err) {
    say(errText(err));
  }
}

async function add() {
  const url = (detailEl.querySelector('[data-box-url]')?.value || '').trim();
  const guide = (detailEl.querySelector('[data-box-guide]')?.value || '').trim();
  let name = (detailEl.querySelector('[data-box-name]')?.value || '').trim();
  if (!isHttpUrl(url) || (guide && !isHttpUrl(guide))) { say(BOX_MESSAGES.invalid_url); return; }
  if (!name) { try { name = new URL(url).hostname; } catch (_) { name = 'Playlist'; } }
  say('Lecture de la playlist…');
  const id = newListId();
  try {
    const channels = await fetchBoxChannels(url, { list: id });
    addList({ id, name, kind: 'url', url, guideUrl: guide, enabled: true, channels, synced: isServerMode() });
    ['[data-box-url]', '[data-box-guide]', '[data-box-name]'].forEach((s) => { const el = detailEl.querySelector(s); if (el) el.value = ''; });
    say(plural(channels.length) + ' ajoutée' + (channels.length > 1 ? 's' : '') + (guide ? '. Lecture du guide des programmes…' : '.'));
    if (guide) refreshAll(true).then(() => say(plural(channels.length) + ' ajoutée' + (channels.length > 1 ? 's' : '') + ', guide à jour.'));
  } catch (err) {
    say(errText(err));
  }
}

async function importFile(file) {
  if (!file) return;
  try {
    const id = newListId();
    const channels = channelsFromText(await file.text(), { list: id });
    addList({ id, name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Playlist', kind: 'file', url: '', guideUrl: '', enabled: true, channels, synced: false });
    say(plural(channels.length) + ' importée' + (channels.length > 1 ? 's' : '') + ' (gardées sur cet appareil).');
  } catch (err) {
    say(errText(err));
  }
}

detailEl.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('.set-page')) return;
  if (t.closest('[data-molotov-connect]')) { e.preventDefault(); molotov.form = true; molotov.msg = ''; rerender(); return; }
  if (t.closest('[data-molotov-signin]')) { e.preventDefault(); molotovSignin(); return; }
  if (t.closest('[data-molotov-disconnect]')) { e.preventDefault(); molotovDisconnect(); return; }
  if (t.closest('[data-box-detect]')) { e.preventDefault(); detect(); return; }
  if (t.closest('[data-box-add]')) { e.preventDefault(); add(); return; }
  const tog = t.closest('[data-box-toggle]');
  if (tog) { e.preventDefault(); const l = getLists().find((x) => x.id === tog.dataset.boxToggle); if (l) updateList(l.id, { enabled: !l.enabled }); return; }
  const ref = t.closest('[data-box-refresh]');
  if (ref) { e.preventDefault(); say('Actualisation…'); refreshAll(true).then(() => say('Playlists actualisées.')); return; }
  const rm = t.closest('[data-box-remove]');
  if (rm) { e.preventDefault(); removeList(rm.dataset.boxRemove); say('Playlist retirée.'); }
});

detailEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.closest('.set-page')) return;
  if (t.dataset.molotovEmail !== undefined) { molotov.draft.email = t.value; return; }
  if (t.dataset.molotovPassword !== undefined) { molotov.draft.password = t.value; return; }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.closest('.set-page')) return;
  if (t instanceof HTMLInputElement && t.dataset.boxFile !== undefined) { importFile(t.files && t.files[0]); t.value = ''; return; }
  if (t instanceof HTMLInputElement && t.dataset.boxRename) { const n = t.value.trim().slice(0, 60); if (n) updateList(t.dataset.boxRename, { name: n }); return; }
  if (t instanceof HTMLSelectElement && t.dataset.boxQuality !== undefined) { setBoxQuality(t.value); window.dispatchEvent(new Event(BOX_CHANGED)); }
});
