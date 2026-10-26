/* Replay Molotov dans l'écran TV (ODY-267) : catégorie « Replay Molotov » à côté de la catégorie Molotov du direct,
 * tuiles (image + titre), fiche d'émission (description et épisodes) et lecture d'un asset (DASH + Widevine, comme le
 * direct, via la config de lecture déjà obtenue).
 *
 * Le catalogue vient du serveur (`/user/account/molotov/replay`) : sans compte Molotov connecté, il reste vide et la
 * catégorie disparaît. Une erreur réseau est annoncée dans la ligne d'état de l'app (le toast) ; un accès refusé
 * (pas de session, pas le profil principal) reste silencieux, comme le catalogue du direct. */
import { getMolotovPlayAsset, getMolotovProgram, getMolotovReplay, getMolotovStatus } from '../data/molotovApi';
import { detailEl, toast } from './dom.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { fallbackHTML } from './typo.js';
import { refreshCats, renderEpgGrid, tv } from './tv.js';
import { esc } from './util.js';

/** Catégorie de l'écran TV, juste après la catégorie Molotov du direct. */
export const MOLOTOV_REPLAY_CAT = 'Replay Molotov';

/** Replay/VOD du compte connecté ; vide sans compte connecté (ou pendant le chargement). */
let replay = [];
let replayLoading = false;
/** Fiche d'émission ouverte : ses épisodes sont les entrées jouables de la fiche. */
let sheet = null;

/** Nombre de replays (affiché dans la catégorie, absent de l'écran s'il est nul). */
export const replayCount = () => replay.length;

/** Accès refusé (pas de session, pas le profil principal) : pas de catégorie, pas de message. */
const noAccess = (err) => !!err && typeof err === 'object' && (err.status === 401 || err.status === 403);

/** Catalogue replay/VOD du compte connecté (absent : pas de compte, pas de catégorie). */
export async function loadMolotovReplay() {
  if (replayLoading) return;
  replayLoading = true;
  try {
    const status = await getMolotovStatus();
    replay = status.connected ? await getMolotovReplay() : [];
    sheet = null;
  } catch (err) {
    replay = [];
    if (!noAccess(err)) toast("Le replay Molotov n'a pas pu être chargé.");
  } finally {
    replayLoading = false;
    if (state.kind === 'tvlive') {
      // La catégorie vient d'apparaître (ou de disparaître) : la barre de catégories suit.
      refreshCats();
      if (tv.cat === MOLOTOV_REPLAY_CAT) renderEpgGrid();
    }
  }
}

/** Tuile d'un replay : image (ou affiche typographique), titre et sous-titre. */
function tileHTML(item) {
  const label = [item.title, item.subtitle].filter(Boolean).join(', ');
  return '<button type="button" class="card tile tile-land" data-tvreplay="' + esc(item.id) + '" aria-label="' + esc(label) + '">' +
    '<span class="card-media' + (item.image ? '' : ' no-img') + '">' +
    (item.image ? '<img src="' + esc(item.image) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: item.title }) + '</span>' +
    '<span class="card-title" aria-hidden="true">' + esc(item.title) + '</span>' +
    (item.subtitle ? '<span class="card-meta" aria-hidden="true">' + esc(item.subtitle) + '</span>' : '') +
    '</button>';
}

/** Grille des replays dans la zone de la grille TV (`#epg`). */
export function renderReplayGrid(host) {
  if (replayLoading) {
    host.innerHTML = '<p class="row-msg" role="status">Chargement du replay Molotov…</p>';
    return;
  }
  if (!replay.length) {
    host.innerHTML = '<p class="row-msg" role="status">Aucun replay Molotov pour le moment.</p>';
    return;
  }
  host.innerHTML = '<div class="lib-grid replay-grid" role="list">' + replay.map(tileHTML).join('') + '</div>';
}

/** Bouton « Regarder » d'un asset (tuile sans fiche, ou épisode de la fiche). */
function playButton(entry, label) {
  return '<button type="button" class="btn btn-primary" data-tvreplayplay="' + esc(entry.assetId) + '">' + ICON.play + '<span>' + esc(label) + '</span></button>';
}

/** Fiche d'émission : description, lecture directe quand la tuile porte un asset, et épisodes jouables. */
function ficheHTML(item, data) {
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  const image = data.image || item.image;
  return (image ? '<img class="tvd-img" src="' + esc(image) + '" alt="" loading="lazy">' : '') +
    '<div class="tvd-t">' +
    (data.subtitle ? '<p class="tvd-ch">' + esc(data.subtitle) + '</p>' : '') +
    '<h2 class="tvd-title">' + esc(data.title) + '</h2>' +
    (data.description ? '<p class="tvd-desc">' + esc(data.description) + '</p>' : '') +
    (item.assetId ? playButton(item, 'Regarder') : '') +
    episodes.map((ep) => playButton(ep, ep.title)).join('') +
    '</div>';
}

/** Entrée jouable : épisode de la fiche ouverte, sinon le replay lui-même (par identifiant d'asset). */
function entryOf(assetId) {
  const inSheet = sheet !== null && Array.isArray(sheet.episodes) ? sheet.episodes.find((ep) => ep.assetId === assetId) : undefined;
  return inSheet ?? replay.find((item) => item.assetId === assetId) ?? null;
}

/** Lecture d'un replay : la config de lecture vient du serveur, le lecteur en prend soin ensuite. */
async function playEntry(entry, opener) {
  const play = await getMolotovPlayAsset({ assetId: entry.assetId, playUrl: entry.playUrl || undefined });
  const c = {
    id: 'molotov-replay:' + entry.id,
    name: entry.title,
    logo: entry.image || '',
    group: MOLOTOV_REPLAY_CAT,
    cat: MOLOTOV_REPLAY_CAT,
    source: 'molotov',
    molotovId: entry.channelId || entry.id,
    molotovPlay: play,
  };
  // Le lecteur est chargé à la demande : son module referme la boucle d'import de la TV (playerEl).
  const { openPlayer } = await import('./player.js');
  openPlayer(c, [c], opener || null);
}

/** Échec avant l'ouverture du lecteur (config de lecture, réseau) : message dans la ligne d'état. */
function playFail(err) {
  if (!noAccess(err)) toast('Le replay Molotov est indisponible pour le moment.');
}

/**
 * Clic sur une tuile : fiche d'émission quand elle porte un programme (avec ses épisodes), sinon lecture directe de
 * son asset.
 */
export async function openReplayTile(id, opener) {
  const item = replay.find((x) => x.id === id);
  if (!item) return;
  if (item.programId === null || item.programId === undefined) {
    if (item.assetId) await playEntry(item, opener).catch(playFail);
    return;
  }
  const box = detailEl.querySelector('#tv-detail');
  if (box) box.innerHTML = '<p class="tv-detail-hint" role="status">Chargement de la fiche…</p>';
  try {
    const kind = item.kind === 'series' || item.kind === 'program' ? item.kind : undefined;
    sheet = await getMolotovProgram(item.programId, kind);
  } catch (err) {
    sheet = null;
    if (box) box.innerHTML = '<p class="tv-detail-hint" role="status">La fiche n\'a pas pu être chargée.</p>';
    playFail(err);
    return;
  }
  if (box) box.innerHTML = ficheHTML(item, sheet);
}

/** Clic sur « Regarder » (fiche ou tuile) : lecture de l'asset. */
export async function openReplayEntry(assetId, opener) {
  const entry = entryOf(assetId);
  if (entry === null || !entry.assetId) return;
  await playEntry(entry, opener).catch(playFail);
}
