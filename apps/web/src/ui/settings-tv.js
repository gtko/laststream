/* Réglages > TV en direct : « Ma box TV » (Freebox) et playlists M3U de l'utilisateur (avec guide XMLTV facultatif).
 * Les playlists sont lues par l'appareil ; leur définition (nom, adresse, guide) est synchronisée avec le compte, chiffrée côté
 * serveur, et écrite par le seul profil principal. Les adresses ne sont jamais affichées en clair (identifiants fréquents). */
import {
  BOX_MESSAGES, BoxError, channelsFromText, FREEBOX_LIST_ID, FREEBOX_PLAYLIST_URL, fetchBoxChannels, getBoxQuality, getBoxReach, isHttpUrl,
  maskUrl, newListId, QUALITY_KEYS, QUALITY_LABELS, setBoxQuality, setBoxReach,
} from '../data/tvBox';
import { addList, BOX_CHANGED, getLists, refreshAll, removeList, updateList } from '../data/tvSources';
import { getMolotovStatus, molotovWay } from '../data/molotovApi';
import { connectMolotovWithPassword, disconnectMolotovAccount, MolotovAuthError, resendMolotovMfa, verifyMolotovMfa } from '../data/molotovAuth';
import { auth, isMainProfile, isServerMode } from '../data/auth';
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

/**
 * État de la connexion Molotov, redessiné à chaque changement. `draft` garde la saisie du formulaire entre les rendus :
 * étape `creds` (email + mot de passe), puis étape `code` quand Molotov exige une vérification en deux étapes
 * (le jeton de défi reçu du serveur y vit aussi).
 */
const molotov = { status: null, loading: false, msg: '', form: false, draft: { email: '', password: '', code: '', step: 'creds', mfaToken: '' } };

const molotovErrorText = (err) => {
  if (err instanceof MolotovAuthError) {
    if (err.code === 'invalid_credentials') return 'Email ou mot de passe Molotov incorrect.';
    return err.message;
  }
  if (err && err.status === 404) return 'Ce serveur ne gère pas encore Molotov.';
  if (err && err.code === 'network') return 'Serveur injoignable.';
  return err instanceof Error ? err.message : 'Connexion Molotov impossible.';
};

/** Mini-formulaire en deux étapes : la saisie vit dans `molotov.draft` (les rendus la reprennent). */
function molotovFormHTML() {
  if (molotov.draft.step === 'code') {
    return '<div class="set-actions">' +
      '<p class="set-msg">Un code vient d\'être envoyé à l\'adresse email du compte Molotov.</p>' +
      '<input class="set-input" type="text" placeholder="Code de vérification" aria-label="Code de vérification" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" value="' + esc(molotov.draft.code) + '" data-molotov-code>' +
      '<button type="button" class="btn btn-primary btn-sm" data-molotov-verify>Vérifier</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-molotov-resend>Renvoyer le code</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-molotov-back>Retour</button>' +
      '</div>';
  }
  return '<div class="set-actions">' +
    '<input class="set-input" type="email" placeholder="Email Molotov" aria-label="Email Molotov" autocomplete="username" spellcheck="false" value="' + esc(molotov.draft.email) + '" data-molotov-email>' +
    '<input class="set-input" type="password" placeholder="Mot de passe Molotov" aria-label="Mot de passe Molotov" autocomplete="current-password" value="' + esc(molotov.draft.password) + '" data-molotov-password>' +
    '<button type="button" class="btn btn-primary btn-sm" data-molotov-signin>Se connecter</button>' +
    '</div>';
}

/**
 * La gestion du compte Molotov est réservée au profil principal (le serveur refuse les autres, `main_profile_required`).
 * Message vide = le formulaire est permis ; sinon le message nomme le profil à utiliser. `canEdit()` seul ne suffit pas :
 * sans profil actif, il renvoie `true` alors que la requête partira sans `x-profile-id`.
 */
function molotovProfileNote() {
  if (!isServerMode()) return '';
  if (auth.profile?.isMainProfile === true) return '';
  const main = auth.profiles.find((p) => p.isMainProfile === true);
  const here = auth.profile ? 'Tu es sur « ' + auth.profile.name + ' ».' : 'Aucun profil actif.';
  return 'La connexion Molotov est gérée par le profil principal' + (main ? ' (« ' + main.name + ' »)' : '') + '. ' + here;
}

/** Carte « Molotov » : état de la connexion, connexion par email et mot de passe, déconnexion. */
function molotovCardHTML() {
  const st = molotov.status;
  const connected = !!(st && st.connected);
  const state = molotov.loading ? 'Lecture du compte.'
    : !st ? 'État inconnu'
      : connected ? 'Connecté' + (st.tier ? ' — ' + st.tier : '') + (st.channelCount != null ? ' — ' + st.channelCount + ' chaînes' : '')
        : 'Déconnecté';
  const note = molotovProfileNote();
  const edit = canEdit() && note === '';
  const actions = !edit
    ? '<p class="set-msg">' + esc(note || 'La connexion Molotov est gérée par le profil principal.') + '</p>'
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

/** Connexion par email et mot de passe : passe à l'étape `code` quand Molotov exige une vérification en deux étapes. */
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
    const result = await connectMolotovWithPassword(email, password);
    if ('mfaToken' in result) {
      molotov.draft.mfaToken = result.mfaToken;
      molotov.draft.code = '';
      molotov.draft.step = 'code';
      molotov.msg = '';
    } else {
      molotov.status = result.status;
      molotov.form = false;
      molotov.draft = { email: '', password: '', code: '', step: 'creds', mfaToken: '' };
      molotov.msg = 'Compte Molotov connecté.';
    }
  } catch (err) {
    molotov.msg = molotovErrorText(err);
  } finally {
    molotov.loading = false;
    rerender();
  }
}

/** Vérification du code reçu par email : réussie, la connexion est établie et la saisie est effacée. */
async function molotovVerify() {
  const code = molotov.draft.code.trim();
  if (!code) {
    molotov.msg = 'Renseigne le code reçu par email.';
    rerender();
    return;
  }
  molotov.loading = true;
  molotov.msg = 'Vérification du code.';
  rerender();
  try {
    molotov.status = await verifyMolotovMfa(molotov.draft.mfaToken, code);
    molotov.form = false;
    molotov.draft = { email: '', password: '', code: '', step: 'creds', mfaToken: '' };
    molotov.msg = 'Compte Molotov connecté.';
  } catch (err) {
    molotov.msg = molotovErrorText(err);
  } finally {
    molotov.loading = false;
    rerender();
  }
}

/** Renvoi du code par email : le jeton de défi peut changer, la saisie du code est alors réinitialisée. */
async function molotovResend() {
  molotov.loading = true;
  molotov.msg = 'Renvoi du code.';
  rerender();
  try {
    molotov.draft.mfaToken = await resendMolotovMfa(molotov.draft.mfaToken);
    molotov.draft.code = '';
    molotov.msg = 'Un nouveau code vient d\'être envoyé.';
  } catch (err) {
    molotov.msg = molotovErrorText(err);
  } finally {
    molotov.loading = false;
    rerender();
  }
}

/** Retour à l'étape `creds` : email et mot de passe sont conservés. */
function molotovBack() {
  molotov.draft.step = 'creds';
  molotov.draft.code = '';
  molotov.msg = '';
  rerender();
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
  if (t.closest('[data-molotov-verify]')) { e.preventDefault(); molotovVerify(); return; }
  if (t.closest('[data-molotov-resend]')) { e.preventDefault(); molotovResend(); return; }
  if (t.closest('[data-molotov-back]')) { e.preventDefault(); molotovBack(); return; }
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
  if (t.dataset.molotovCode !== undefined) { molotov.draft.code = t.value; return; }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.closest('.set-page')) return;
  if (t instanceof HTMLInputElement && t.dataset.boxFile !== undefined) { importFile(t.files && t.files[0]); t.value = ''; return; }
  if (t instanceof HTMLInputElement && t.dataset.boxRename) { const n = t.value.trim().slice(0, 60); if (n) updateList(t.dataset.boxRename, { name: n }); return; }
  if (t instanceof HTMLSelectElement && t.dataset.boxQuality !== undefined) { setBoxQuality(t.value); window.dispatchEvent(new Event(BOX_CHANGED)); }
});
