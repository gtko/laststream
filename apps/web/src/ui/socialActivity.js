/* Onglet « Activité » de la barre latérale : fil des amis (socialStore.activity, GET /activity), le plus récent d'abord. */
import { ago, avatarHTML, episodeCode, nameHTML, posterBox } from './socialFmt.js';
import { esc } from './util.js';

const VERB = {
  started: 'a commencé',
  finished: 'a terminé',
  rated: 'a noté',
  noted: 'a posé une note sur',
  favorited: 'a mis en favori',
  listed: 'a ajouté à une liste',
};

/** Phrase d'un événement : « a commencé Severance · S02E03 ». */
export function activityText(it) {
  const m = it.media || {};
  const ep = episodeCode({ type: m.type === 'tv' || m.type === 'series' ? 'series' : 'movie', season: m.season, episode: m.episode });
  return (VERB[it.kind] || 'a une activité sur') + ' ' + (m.title || 'un titre') + (ep ? ' · ' + ep : '') +
    (it.kind === 'rated' && it.rating != null ? ' · ★ ' + String(it.rating).replace('.', ',') : '');
}

function rowHTML(it) {
  const who = { handle: it.handle, avatarColor: it.avatarColor };
  const m = it.media || {};
  return '<li class="ss-item"><button type="button" class="ss-row" data-ss-act="open" data-pid="' + esc(it.pid) + '" data-fk="act:' + esc(it.id) + '">' +
    avatarHTML(who) + '<span class="ss-row-t"><span class="ss-name">' + nameHTML(who) + '</span>' +
    '<span class="ss-sub ss-sub-wrap">' + esc(activityText(it)) + '</span>' +
    '<span class="ss-sub">' + esc(ago(it.at)) + '</span></span>' +
    (m.poster ? posterBox(m.poster, m.title, 'ss-poster-s') : '') + '</button></li>';
}

/** Contenu du fil. `status` : 'loading' | 'error' | 'ok'. */
export function activityHTML(items, status) {
  if (status === 'error') return '<p class="ss-empty" role="alert">Activité indisponible. <button type="button" class="ss-link" data-ss-act="act-retry">Réessayer</button></p>';
  if (!items.length) {
    return status === 'loading' ? '<p class="ss-empty" role="status">Chargement…</p>'
      : '<p class="ss-empty">Rien pour l’instant. Ce que regardent et notent tes amis apparaîtra ici.</p>';
  }
  return '<ul class="ss-list">' + items.map(rowHTML).join('') + '</ul>';
}
