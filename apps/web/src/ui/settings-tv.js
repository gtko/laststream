/* Réglages > TV en direct : « Ma box TV » (Freebox) et playlists M3U de l'utilisateur (avec guide XMLTV facultatif).
 * Les playlists sont lues par l'appareil ; leur définition (nom, adresse, guide) est synchronisée avec le compte, chiffrée côté
 * serveur, et écrite par le seul profil principal. Les adresses ne sont jamais affichées en clair (identifiants fréquents). */
import {
  BOX_MESSAGES, BoxError, channelsFromText, FREEBOX_LIST_ID, FREEBOX_PLAYLIST_URL, fetchBoxChannels, getBoxQuality, getBoxReach, isHttpUrl,
  maskUrl, newListId, QUALITY_KEYS, QUALITY_LABELS, setBoxQuality, setBoxReach,
} from '../data/tvBox';
import { addList, BOX_CHANGED, getLists, refreshAll, removeList, updateList } from '../data/tvSources';
import { isMainProfile, isServerMode } from '../data/auth';
import { card, fieldRow, rowHTML } from './settings-ui.js';
import { detailEl } from './dom.js';
import { esc } from './util.js';
import { t as tr } from '../i18n';

/** Écriture permise : hors compte serveur, ou profil principal (le serveur refuse les autres : `main_profile_required`). */
const canEdit = () => !isServerMode() || isMainProfile();

const plural = (n) => tr('{n} chaîne', { n }) + (n > 1 ? 's' : '');

function listRow(l, edit) {
  const reach = getBoxReach(l.id);
  const state = !l.enabled ? tr('désactivée') : reach === false ? tr('injoignable pour l’instant') : plural(l.channels.length);
  const src = l.kind === 'file' ? tr('Fichier importé sur cet appareil') : l.kind === 'freebox' ? tr('Freebox détectée sur cet appareil') : maskUrl(l.url);
  const guide = l.guideUrl ? ' ' + tr('· guide : {guideUrl}', { guideUrl: maskUrl(l.guideUrl) }) : '';
  const sync = l.synced ? ' ' + tr('· synchronisée avec le compte') : '';
  return '<div class="set-row is-stack" data-nav data-box-list="' + esc(l.id) + '"><div class="set-row-t">' +
    (edit ? '<input class="set-input" type="text" value="' + esc(l.name) + '" maxlength="60" aria-label="' + tr('Nom de la playlist') + '" data-box-rename="' + esc(l.id) + '">'
      : '<span class="set-row-l">' + esc(l.name) + '</span>') +
    '<span class="set-row-d">' + esc(src + guide + ' · ' + state + sync) + '</span></div>' +
    (edit ? '<div class="set-actions"><button type="button" class="btn btn-ghost btn-sm" data-box-toggle="' + esc(l.id) + '">' + (l.enabled ? tr('Désactiver') : tr('Activer')) + '</button>' +
      (l.kind === 'file' ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-box-refresh="' + esc(l.id) + '">' + tr('Actualiser') + '</button>') +
      '<button type="button" class="btn btn-ghost btn-sm" data-box-remove="' + esc(l.id) + '">' + tr('Retirer') + '</button></div>' : '') + '</div>';
}

/** Contenu qui change selon les playlists (état, liste) : redessiné à chaque changement. */
function dynamicHTML() {
  const lists = getLists();
  const edit = canEdit();
  const fb = lists.find((l) => l.id === FREEBOX_LIST_ID);
  const q = getBoxQuality();
  return card(tr('Ma box TV'),
    rowHTML(tr('Freebox'), fb ? plural(fb.channels.length) + (getBoxReach(fb.id) === false ? ' ' + tr('· box injoignable (hors du réseau local)') : '') : tr('Détecte les chaînes de ta Freebox quand tu es chez toi.'),
      () => '<button type="button" class="btn btn-ghost btn-sm" data-box-detect>' + (fb ? tr('Mettre à jour') : tr('Détecter ma Freebox')) + '</button>') +
    fieldRow(tr('Qualité préférée'), tr('Les chaînes de la box existent en plusieurs qualités ; HD par défaut, sinon la meilleure disponible.'), (id) =>
      '<select class="set-input" id="' + id + '" data-box-quality>' + QUALITY_KEYS.map((k) => '<option value="' + k + '"' + (k === q ? ' selected' : '') + '>' + QUALITY_LABELS[k] + '</option>').join('') + '</select>') +
    '<p class="set-msg" id="tv-box-msg" role="status"></p>',
    { desc: tr('Les chaînes de ta box s’ajoutent à la TV en direct avec le badge « Box » et sont lues par l’app sur le réseau de ta box.') }) +
    card(tr('Playlists M3U'), (lists.filter((l) => l.id !== FREEBOX_LIST_ID).map((l) => listRow(l, edit)).join('') || '<p class="set-msg">' + tr('Aucune playlist ajoutée.') + '</p>') +
      (edit ? '' : '<p class="set-msg">' + tr('Les playlists du compte sont gérées par le profil principal.') + '</p>'),
    { desc: tr('Playlists que tu as choisies toi-même. Lues par cet appareil, jamais par le serveur.') });
}

/** Formulaire d'ajout : statique (il garde ce que l'on tape pendant les actualisations). */
function addHTML() {
  if (!canEdit()) return '';
  return card(tr('Ajouter une playlist M3U'),
    fieldRow(tr('Nom'), tr('Facultatif.'), (id) => '<input class="set-input" id="' + id + '" type="text" maxlength="60" data-box-name autocomplete="off">', { stack: true }) +
    fieldRow(tr('Adresse de la playlist'), tr('URL http(s) d’un fichier M3U. Elle peut contenir des identifiants : enregistrée chiffrée sur ton compte, jamais affichée.'), (id) =>
      '<input class="set-input" id="' + id + '" type="url" placeholder="http://…/get.php?username=…" data-box-url autocomplete="off" spellcheck="false">', { stack: true }) +
    fieldRow(tr('Guide des programmes (XMLTV)'), tr('Facultatif : URL d’un fichier .xml ou .xml.gz. Lu sur cet appareil, de maintenant à +24 h.'), (id) =>
      '<input class="set-input" id="' + id + '" type="url" placeholder="http://…/xmltv.xml.gz" data-box-guide autocomplete="off" spellcheck="false">', { stack: true }) +
    '<div class="set-actions"><button type="button" class="btn btn-primary btn-sm" data-box-add>' + tr('Ajouter la playlist') + '</button>' +
    '<label class="btn btn-ghost btn-sm">' + tr('Importer un fichier') + '<input type="file" accept=".m3u,.m3u8,text/plain,audio/x-mpegurl" hidden data-box-file></label></div>',
    {});
}

export function tvPanelHTML() {
  const web = typeof window !== 'undefined' && !window.chrome?.webview && !(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
  return '<div id="tv-box-dyn">' + dynamicHTML() + '</div>' + addHTML() +
    (web ? '<p class="set-msg">' + tr('Un navigateur ne peut pas joindre ta box ni la plupart des playlists : disponible dans les apps Windows et Android.') + '</p>' : '');
}

const say = (text) => { const el = detailEl.querySelector('#tv-box-msg'); if (el) el.textContent = text; };
const errText = (err) => (err instanceof BoxError ? BOX_MESSAGES[err.code] : tr('Playlist illisible.'));
const rerender = () => {
  const el = detailEl.querySelector('#tv-box-dyn');
  if (el) el.innerHTML = dynamicHTML();
};

window.addEventListener(BOX_CHANGED, rerender);

async function detect() {
  say(tr('Recherche de ta Freebox…'));
  try {
    const channels = await fetchBoxChannels(FREEBOX_PLAYLIST_URL, { list: FREEBOX_LIST_ID, freebox: true });
    setBoxReach(FREEBOX_LIST_ID, true);
    addList({ id: FREEBOX_LIST_ID, name: tr('Ma Freebox'), kind: 'freebox', url: FREEBOX_PLAYLIST_URL, guideUrl: '', enabled: true, channels, synced: false });
    say(tr('{length} trouvée{v}. Elles sont dans la TV en direct, catégorie « Ma box ».', { length: plural(channels.length), v: (channels.length > 1 ? 's' : '') }));
  } catch (err) {
    say(errText(err));
  }
}

async function add() {
  const url = (detailEl.querySelector('[data-box-url]')?.value || '').trim();
  const guide = (detailEl.querySelector('[data-box-guide]')?.value || '').trim();
  let name = (detailEl.querySelector('[data-box-name]')?.value || '').trim();
  if (!isHttpUrl(url) || (guide && !isHttpUrl(guide))) { say(BOX_MESSAGES.invalid_url); return; }
  if (!name) { try { name = new URL(url).hostname; } catch (_) { name = tr('Playlist'); } }
  say(tr('Lecture de la playlist…'));
  const id = newListId();
  try {
    const channels = await fetchBoxChannels(url, { list: id });
    addList({ id, name, kind: 'url', url, guideUrl: guide, enabled: true, channels, synced: isServerMode() });
    ['[data-box-url]', '[data-box-guide]', '[data-box-name]'].forEach((s) => { const el = detailEl.querySelector(s); if (el) el.value = ''; });
    say(tr('{length} ajoutée', { length: plural(channels.length) }) + (channels.length > 1 ? 's' : '') + (guide ? tr('. Lecture du guide des programmes…') : '.'));
    if (guide) refreshAll(true).then(() => say(tr('{length} ajoutée{v}, guide à jour.', { length: plural(channels.length), v: (channels.length > 1 ? 's' : '') })));
  } catch (err) {
    say(errText(err));
  }
}

async function importFile(file) {
  if (!file) return;
  try {
    const id = newListId();
    const channels = channelsFromText(await file.text(), { list: id });
    addList({ id, name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || tr('Playlist'), kind: 'file', url: '', guideUrl: '', enabled: true, channels, synced: false });
    say(tr('{length} importée{v} (gardées sur cet appareil).', { length: plural(channels.length), v: (channels.length > 1 ? 's' : '') }));
  } catch (err) {
    say(errText(err));
  }
}

detailEl.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('.set-page')) return;
  if (t.closest('[data-box-detect]')) { e.preventDefault(); detect(); return; }
  if (t.closest('[data-box-add]')) { e.preventDefault(); add(); return; }
  const tog = t.closest('[data-box-toggle]');
  if (tog) { e.preventDefault(); const l = getLists().find((x) => x.id === tog.dataset.boxToggle); if (l) updateList(l.id, { enabled: !l.enabled }); return; }
  const ref = t.closest('[data-box-refresh]');
  if (ref) { e.preventDefault(); say(tr('Actualisation…')); refreshAll(true).then(() => say(tr('Playlists actualisées.'))); return; }
  const rm = t.closest('[data-box-remove]');
  if (rm) { e.preventDefault(); removeList(rm.dataset.boxRemove); say(tr('Playlist retirée.')); }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.closest('.set-page')) return;
  if (t instanceof HTMLInputElement && t.dataset.boxFile !== undefined) { importFile(t.files && t.files[0]); t.value = ''; return; }
  if (t instanceof HTMLInputElement && t.dataset.boxRename) { const n = t.value.trim().slice(0, 60); if (n) updateList(t.dataset.boxRename, { name: n }); return; }
  if (t instanceof HTMLSelectElement && t.dataset.boxQuality !== undefined) { setBoxQuality(t.value); window.dispatchEvent(new Event(BOX_CHANGED)); }
});
