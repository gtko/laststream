/* Aides d'affichage partagées par la barre latérale des amis, la fiche ami et le fil d'activité (Social v3, lot F1) :
 * formats de durée, noms, avatars (rendu par collections avec repli lettre colorée), affiches. Tout texte venant du serveur
 * ou de l'utilisateur passe par esc() ; la couleur d'avatar est filtrée (aucun texte serveur dans un style). */
import { safeTmdbImage } from './safeImg.js';
import { UserApiError } from '../data/userApi';
import { avatarAttrs } from './avatar-art.js';
import { esc } from './util.js';

export const STATUS_OPTIONS = [['online', 'En ligne'], ['away', 'Absent'], ['dnd', 'Ne pas déranger'], ['invisible', 'Invisible']];
export const SEEN_LABEL = { online: 'En ligne', away: 'Absent', dnd: 'Ne pas déranger', offline: 'Hors ligne' };
export const PRES_COLOR = { online: '#3ddc84', away: '#f5b942', dnd: '#ff4d5e', offline: '#6f6a7d', invisible: '#6f6a7d' };

export const ADD_ERRORS = {
  invalid_handle: 'Pseudo invalide : écris Nom#TAG (2 à 20 caractères, puis # et 4 caractères).',
  handle_not_found: 'Aucun profil avec ce pseudo exact.',
  already_friends: 'Vous êtes déjà amis.',
  already_requested: 'Une demande est déjà en attente.',
  self: 'Tu ne peux pas t’ajouter toi-même.',
  friend_limit_reached: 'Limite d’amis atteinte.',
  rate_limited: 'Trop de tentatives, réessaie dans un instant.',
  forbidden: 'Action refusée.',
};

/** Message lisible d'une erreur de l'API sociale (les codes inconnus restent visibles pour le diagnostic). */
export function socialErrorMessage(err) {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  if (err.status === 0 || err.code === 'network') return 'Serveur injoignable pour le moment.';
  return ADD_ERRORS[err.code] || 'Erreur (' + err.code + ').';
}

const pad = (n) => String(n).padStart(2, '0');

/** « S01E03 » pour une série avec saison et épisode ; chaîne vide sinon. */
export function episodeCode(w) {
  return w && w.type === 'series' && w.season != null && w.episode != null ? 'S' + pad(w.season) + 'E' + pad(w.episode) : '';
}

/** Durée d'une position en secondes : « 34:12 », ou « 1:02:03 » à partir d'une heure. */
export function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

/** Position estimée à `now` : le relevé vieillit tant que la lecture n'est pas en pause (plafonnée à la durée). */
export function livePos(w, now = Date.now()) {
  const base = Number(w.pos) || 0;
  if (w.paused) return base;
  const p = base + Math.max(0, now - (w.at || now)) / 1000;
  return w.duration ? Math.min(p, Number(w.duration)) : p;
}

/** « S01E03 · 34:12 » (ou « 1:02:03 » pour un film), suffixe « en pause » si la lecture est arrêtée. */
export function watchLine(w) {
  return [episodeCode(w), clock(livePos(w)), w.paused ? 'en pause' : ''].filter(Boolean).join(' · ');
}

/** Part de la durée déjà vue, en pourcentage entier (0 si la durée est inconnue). */
export function progressPct(w) {
  const d = Number(w.duration) || 0;
  return d > 0 ? Math.max(0, Math.min(100, Math.round((livePos(w) / d) * 100))) : 0;
}

/** Durée écoulée depuis `ts` (epoch ms) : « 12 min », « 3 h », « 2 j ». Chaîne vide si inconnue. */
export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return 'à l’instant';
  if (m < 60) return m + ' min';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h';
  return Math.round(h / 24) + ' j';
}

/** Couleur d'avatar : seulement une couleur hexadécimale, sinon une couleur neutre. */
export const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3b3750');
/** Nom#TAG complet. */
export const nameOf = (p) => (p && p.handle && p.handle.full) || '?';
/** Nom affiché : le surnom privé s'il existe, sinon le nom. */
export const shortName = (p) => (p && (p.nickname || (p.handle && p.handle.name))) || '?';
export const tagOf = (p) => (p && p.handle && p.handle.tag ? '#' + p.handle.tag : '');
export const initialOf = (p) => (Array.from(shortName(p))[0] || '?').toUpperCase();
export const byName = (a, b) => shortName(a).localeCompare(shortName(b), 'fr');

/** Nom et #TAG en HTML (le tag en gris). */
export const nameHTML = (p) => esc(shortName(p)) + (tagOf(p) ? '<span class="ss-tag">' + esc(tagOf(p)) + '</span>' : '');

/** Affiche d'une source : URL https telle quelle, chemin TMDB converti ; sinon rien. */
export function posterSrc(p) {
  return safeTmdbImage(p, 'w342') || '';
}

/** Couleur de repli d'une affiche sans image, stable pour un titre. */
export function posterTint(title) {
  const tints = ['#a0552a', '#2d5d73', '#3c4a5c', '#7a2e2e', '#2f5a3e', '#5b3a7a'];
  let h = 0;
  for (const c of String(title || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return tints[h % tints.length];
}

/** Affiche : image si la source est valide, sinon bloc coloré avec le début du titre. `cls` dimensionne (ss-poster-*). */
export function posterBox(src, title, cls) {
  const url = posterSrc(src);
  if (url) return '<span class="ss-poster ' + cls + '"><img src="' + esc(url) + '" alt="" loading="lazy"></span>';
  return '<span class="ss-poster ' + cls + '" style="background:' + posterTint(title) + '" aria-hidden="true">' + esc(String(title || '').slice(0, 14).toUpperCase()) + '</span>';
}

/**
 * Avatar : illustration de la collection du profil (lettre colorée tant qu'elle n'est pas posée ou en repli), pastille de
 * présence facultative (`status` : online, away, dnd, offline). `size` : classe de taille (ss-av-m, ss-av-l, ss-av-xl).
 */
export function avatarHTML(p, size = '', status = '') {
  const dot = status ? '<i class="ss-pdot is-' + esc(status) + '" aria-hidden="true"></i>' : '';
  return '<span class="ss-av ' + size + '"' + avatarAttrs(p && p.avatar, colorOf(p && p.avatarColor)) + '>' +
    '<span class="ss-ini" aria-hidden="true">' + esc(initialOf(p)) + '</span>' + dot + '</span>';
}

/** Libellé de statut personnalisé : « 🍿 Soirée SF », ou chaîne vide. Ignoré s'il est expiré. */
export function customStatusText(cs, now = Date.now()) {
  if (!cs || (cs.expiresAt && cs.expiresAt < now)) return '';
  return [cs.emoji, cs.text].filter(Boolean).join(' ');
}
