/* Discussions Social v3 (lot F3) : fonctions pures partagées par la fenêtre ancrée, le plein écran mobile et la liste des
 * conversations (résolution d'une conversation, aperçus, jours, heures, emojis, persistance de l'état ouvert).
 * Aucun accès au réseau ; tout texte venant du serveur reste à afficher avec textContent. */
import { hhmm, posLabel } from './socialChat.js';

export { hhmm, posLabel };

/** Réactions rapides (sélecteur au survol / appui long). `name` sert aux libellés d'accessibilité. */
export const QUICK_REACTIONS = [
  { emoji: '🔥', name: 'feu' }, { emoji: '😂', name: 'rire' }, { emoji: '❤️', name: 'cœur' },
  { emoji: '😱', name: 'choc' }, { emoji: '👍', name: 'pouce' },
];

/** Panneau d'emojis (clavier d'emojis de la maquette mobile). « Récents » est rempli à l'exécution. */
export const EMOJI_TABS = [
  { id: 'recent', label: 'Récents', list: [] },
  { id: 'cine', label: 'Ciné', list: ['🍿', '🎬', '📺', '🎞️', '⭐', '👀', '💀', '🎭', '🎥', '📽️', '🎟️', '🏆', '🌟', '🎤', '🎧', '🎶', '🛋️', '🌙', '🔦', '🧨', '💥', '🤫'] },
  { id: 'faces', label: 'Visages', list: ['😍', '🥲', '😴', '🤔', '😮', '🙌', '👍', '😀', '😁', '😅', '😎', '🥹', '😬', '🙄', '😤', '🤗', '😇', '🥳', '😏', '🫠', '😶', '🤭'] },
  { id: 'react', label: 'Réactions', list: ['🔥', '😂', '😱', '🤯', '❤️', '👏', '😭', '💯', '👎', '🙏', '💔', '🤣', '😢', '😡', '🤩', '🫶', '✨', '🎉', '💪', '🤝', '🥵', '🤌'] },
];
export const RECENT_EMOJIS_DEFAULT = ['🔥', '😂', '😱', '🤯', '❤️', '👏', '😭'];

export const GROUP_NAME_MAX = 40;
export const GROUP_MEMBERS_MIN = 2;
export const GROUP_MEMBERS_MAX = 19;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 6;
export const POLL_QUESTION_MAX = 120;
export const POLL_OPTION_MAX = 60;
/** Nombre maximal d'onglets réduits à côté de la fenêtre ouverte. */
export const MAX_TABS = 4;
/** Largeur (px) en dessous de laquelle les discussions passent en plein écran (version Android de la maquette). */
export const MOBILE_MAX = 767;

export const dmConv = (pid) => 'dm:' + pid;
export const isGroup = (conv) => typeof conv === 'string' && conv.startsWith('g:');
export const isConvId = (conv) => typeof conv === 'string' && /^(dm|g):.+/.test(conv);
/** Accepte « dm:<pid> », « g:<id> » ou un pid seul (ancien appel de la barre). */
export const normalizeConv = (x) => (isConvId(x) ? x : typeof x === 'string' && x ? dmConv(x) : '');

/** Couleur d'avatar : seulement une couleur hexadécimale, sinon une couleur neutre. */
export const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3b3750');
export const initialOf = (name) => (Array.from(name || '?')[0] || '?').toUpperCase();

/** Compare sans tenir compte de la casse ni des accents (recherche d'une discussion). */
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const findFriend = (s, pid) => s.friends.find((f) => f.pid === pid) || s.household.find((f) => f.pid === pid) || null;

/**
 * Description d'une conversation depuis l'état du store, ou null si elle est inconnue (ami retiré, groupe quitté).
 * DM : { kind:'dm', pid, name, tag, avatar, avatarColor, status, watching, household, unread, last, friend }.
 * Groupe : { kind:'group', name, members, unread, last }.
 */
export function convInfo(conv, s) {
  if (isGroup(conv)) {
    const g = s.groups.find((x) => x.conv === conv);
    if (!g || !g.group) return null;
    return {
      conv, kind: 'group', id: g.group.id, name: g.group.name, members: g.group.members || [], unread: g.unread || 0, last: g.last || null,
    };
  }
  const pid = conv.slice(3);
  const f = findFriend(s, pid);
  const c = s.conversations.find((x) => x.pid === pid);
  const p = f || c;
  if (!p) return null;
  return {
    conv, kind: 'dm', pid, name: (f && f.nickname) || p.handle.name, tag: p.handle.tag, handle: p.handle,
    avatar: f && f.avatar, avatarColor: p.avatarColor, status: f ? f.status : 'offline', watching: f ? f.watching : undefined,
    household: !!(f && f.household), unread: c ? c.unread : 0, last: c ? c.last || null : null, friend: f,
  };
}

/** Nom affiché de l'auteur d'un message : « Toi », le membre du groupe, ou l'interlocuteur. */
export function authorName(pid, info, s) {
  if (s.me && pid === s.me.pid) return 'Toi';
  if (info && info.kind === 'group') {
    const m = info.members.find((x) => x.pid === pid);
    return m ? m.nickname || m.handle.name : 'Un ancien membre';
  }
  return info ? info.name : '';
}

/** Libellé court d'un message (aperçu de la liste, citation d'une réponse). */
export function messageText(m) {
  switch (m.kind) {
    case 'title': return m.title ? m.title.title : 'un titre';
    case 'moment': return m.moment ? m.moment.title + ' à ' + posLabel(m.moment.pos) : 'un moment';
    case 'party': return m.party ? 'Watch party : ' + m.party.title : 'Watch party';
    case 'poll': return m.poll ? 'Sondage : ' + m.poll.question : 'Sondage';
    default: return m.body || '';
  }
}

/** Aperçu d'une conversation dans la liste : « a partagé : Severance S02 », « Nora : on vote… ». */
export function previewOf(info, s) {
  const m = info.last;
  if (!m) return 'Aucun message';
  const mine = !!(s.me && m.from === s.me.pid);
  let text;
  switch (m.kind) {
    case 'title': text = (mine ? 'tu as partagé : ' : 'a partagé : ') + messageText(m); break;
    case 'moment': text = (mine ? 'tu as partagé un moment : ' : 'a partagé un moment : ') + messageText(m); break;
    case 'party': text = mine ? 'tu as invité à une watch party' : 't’invite à une watch party'; break;
    case 'poll': text = (mine ? 'tu as lancé un ' : 'a lancé un ') + messageText(m).toLowerCase(); break;
    default: text = m.body || '';
  }
  if (info.kind === 'group') return authorName(m.from, info, s) + (m.kind && m.kind !== 'text' ? ' ' : ' : ') + text;
  if (mine) return m.kind && m.kind !== 'text' ? 'Toi, ' + text : 'Toi : ' + text;
  return m.kind && m.kind !== 'text' ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAY = 86_400_000;

/** Heure de la liste : « 21:44 » aujourd'hui, « hier », « dim. » dans la semaine, « 12/03 » au-delà. */
export function listTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const diff = startOfDay(now) - startOfDay(ms);
  if (diff <= 0) return hhmm(ms);
  if (diff < 2 * DAY) return 'hier';
  if (diff < 7 * DAY) return WEEKDAYS[new Date(ms).getDay()];
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
}

/** Séparateur de jour : « Aujourd'hui · 21:42 » (heure du premier message du jour), « Hier », « 3 mars ». */
export function dayLabel(ms, now = Date.now()) {
  const diff = startOfDay(now) - startOfDay(ms);
  if (diff <= 0) return 'Aujourd’hui · ' + hhmm(ms);
  if (diff < 2 * DAY) return 'Hier';
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}

/** Messages chronologiques → éléments { day } et { msg }, un séparateur à chaque changement de jour. */
export function timeline(list, now = Date.now()) {
  const out = [];
  let key = '';
  for (const m of list) {
    const k = Number.isFinite(m.createdAt) ? String(startOfDay(m.createdAt)) : '';
    if (k !== key) {
      key = k;
      if (k) out.push({ day: dayLabel(m.createdAt, now) });
    }
    out.push({ msg: m });
  }
  return out;
}

/** Part d'une option dans le total des votes (0 à 100, entier). */
export function pollShare(poll, option) {
  const total = poll.options.reduce((n, o) => n + (o.votes || 0), 0);
  return total > 0 ? Math.round(((option.votes || 0) / total) * 100) : 0;
}
export const pollTotal = (poll) => poll.options.reduce((n, o) => n + (o.votes || 0), 0);

/** Ligne d'état de l'interlocuteur : « Regarde Dune · 1:14:02 », ou rien. La position vieillit tant que la lecture n'est pas en pause. */
export function watchingLine(w, now = Date.now()) {
  if (!w) return '';
  const base = Number(w.pos) || 0;
  let pos = w.paused ? base : base + Math.max(0, now - (w.at || now)) / 1000;
  if (w.duration) pos = Math.min(pos, Number(w.duration));
  const ep = w.type === 'series' && Number.isInteger(w.season) && Number.isInteger(w.episode)
    ? ' S' + String(w.season).padStart(2, '0') + 'E' + String(w.episode).padStart(2, '0') : '';
  return 'Regarde ' + (w.title || 'un titre') + ep + ' · ' + posLabel(pos) + (w.paused ? ' (en pause)' : '');
}

/** Phrase de saisie : « Léa écrit… », « Léa et Hugo écrivent… », « Léa, Hugo et 2 autres écrivent… ». */
export function typingText(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] + ' écrit…';
  if (names.length === 2) return names[0] + ' et ' + names[1] + ' écrivent…';
  return names[0] + ', ' + names[1] + ' et ' + (names.length - 2) + ' autre' + (names.length > 3 ? 's' : '') + ' écrivent…';
}

/** Couleur du point de présence. */
export const STATUS_COLOR = { online: '#3ddc84', away: '#f5b700', dnd: '#ef4444', offline: '' };

// ---- Persistance (fenêtre ouverte et onglets réduits), par profil ----
const WIN_KEY = 'laststream.social.convwin.';

/** État sauvegardé : { active: conv|null, min: conv[] }. Toujours valide, même si le stockage est vide ou refusé. */
export function loadWinState(profileId) {
  try {
    const raw = JSON.parse(localStorage.getItem(WIN_KEY + (profileId || '')) || 'null');
    if (!raw || typeof raw !== 'object') return { active: null, min: [] };
    const active = isConvId(raw.active) ? raw.active : null;
    const min = Array.isArray(raw.min) ? raw.min.filter(isConvId).filter((c) => c !== active).slice(0, MAX_TABS) : [];
    return { active, min };
  } catch {
    return { active: null, min: [] };
  }
}

export function saveWinState(profileId, st) {
  try {
    localStorage.setItem(WIN_KEY + (profileId || ''), JSON.stringify({ active: st.active, min: st.min }));
  } catch { /* stockage indisponible : l'état ne sera simplement pas retrouvé */ }
}

const RECENT_KEY = 'laststream.social.emoji.recent';

export function loadRecentEmojis() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || 'null');
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').slice(0, 14);
  } catch { /* défaut */ }
  return [...RECENT_EMOJIS_DEFAULT];
}

export function pushRecentEmoji(emoji) {
  const list = [emoji, ...loadRecentEmojis().filter((x) => x !== emoji)].slice(0, 14);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* sans effet */ }
  return list;
}

// ---- Conversation active (lue par la liste pour se surligner) ----
const activeSubs = new Set();
let activeConv = null;
export const getActiveConv = () => activeConv;
export function setActiveConv(conv) {
  if (conv === activeConv) return;
  activeConv = conv;
  activeSubs.forEach((f) => f(conv));
}
export function onActiveConv(fn) {
  activeSubs.add(fn);
  return () => { activeSubs.delete(fn); };
}
