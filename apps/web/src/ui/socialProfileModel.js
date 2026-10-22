/* Modèle de l'édition du profil social (Social v3, lot F2) : brouillon, validation, différences à envoyer, cooldown du tag,
 * réordonnancement des favoris. Fonctions pures, sans DOM ni réseau : le formulaire (socialProfile.js) les appelle. */
import { validateHandle } from '../data/socialV2Api';

export const BIO_MAX = 140;
export const STATUS_TEXT_MAX = 60;
export const FAVORITES_MAX = 4;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Couleurs d'avatar proposées (maquette). */
export const COLORS = [['#ff5a36', 'Corail'], ['#7b5cff', 'Violet'], ['#1f9d77', 'Vert'], ['#3b82c4', 'Bleu'], ['#e0912f', 'Ambre'], ['#c2417f', 'Rose']];
export const PRESENCE = [['online', 'En ligne', '#3ddc84'], ['away', 'Absent', '#f5b700'], ['dnd', 'Ne pas déranger', '#ff5a6a'], ['invisible', 'Invisible', '#6b6778']];
export const EXPIRIES = [['4h', 'dans 4 h'], ['tonight', 'ce soir'], ['never', 'jamais']];
/** Emojis proposés pour le statut personnalisé (écran Profil et éditeur de la sidebar). */
export const EMOJIS = ['🍿', '🎬', '🎥', '📺', '🛋️', '🌙', '☕', '🎧', '😴', '🤩', '😎', '🥳', '🤔', '🔥', '❤️', '👀', '🧠', '👾', '🚀', '🦇', '🧙', '🐉', '🎮', '🌧️'];

export const PREF_CHOICES = {
  activityVisibility: [['friends', 'Amis'], ['favorites', 'Favoris'], ['nobody', 'Personne']],
  watchWith: [['open', 'Libre'], ['ask', 'Me demander'], ['never', 'Jamais']],
  libraryVisibility: [['friends', 'Amis'], ['household', 'Foyer'], ['private', 'Privée']],
  messagesFrom: [['friends', 'Amis'], ['favorites', 'Favoris'], ['household', 'Foyer']],
  playbackSocial: [['all', 'Tout'], ['messages', 'Messages seuls'], ['cinema', 'Mode cinéma']],
};

/** Nombre de caractères (graphèmes) d'un texte. */
export function charCount(s) {
  const t = String(s || '');
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return Array.from(new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(t)).length;
  return Array.from(t).length;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Brouillon depuis les données du serveur. `avatar` : avatar illustré du profil (auth), `status` : présence.
 * `expiry` vaut 'keep' (échéance déjà posée, conservée), '4h', 'tonight' ou 'never'.
 */
export function makeDraft(profile, prefs, status, avatar) {
  const cs = profile.customStatus || {};
  return {
    name: profile.handle.name,
    avatarColor: profile.avatarColor,
    avatar: avatar || null,
    bio: profile.bio || '',
    presence: status || 'online',
    emoji: cs.emoji || '',
    statusText: cs.text || '',
    expiry: cs.expiresAt ? 'keep' : 'never',
    expiresAt: cs.expiresAt,
    banner: profile.banner ? clone(profile.banner) : null,
    favorites: clone(profile.favorites || []),
    prefs: clone(prefs),
  };
}

export const cloneDraft = clone;

/** Échéance (epoch ms) d'un choix « dans 4 h » / « ce soir » / « jamais » ; undefined pour jamais. */
function expiryAt(choice, now = Date.now()) {
  if (choice === '4h') return now + 4 * HOUR_MS;
  if (choice === 'tonight') {
    const d = new Date(now);
    d.setHours(23, 59, 0, 0);
    return d.getTime() > now ? d.getTime() : now + 4 * HOUR_MS;
  }
  return undefined;
}

/** Erreurs de validation par champ ({} si le brouillon est valide). */
export function validateDraft(d) {
  const errors = {};
  const name = d.name.trim();
  if (!validateHandle(name + '#AAAA')) errors.name = 'Le pseudo fait de 2 à 20 caractères : lettres, chiffres, espace, _ ou -.';
  if (charCount(d.bio) > BIO_MAX) errors.bio = 'La bio fait ' + BIO_MAX + ' caractères au plus.';
  if (charCount(d.statusText) > STATUS_TEXT_MAX) errors.status = 'Le statut fait ' + STATUS_TEXT_MAX + ' caractères au plus.';
  if (d.favorites.length > FAVORITES_MAX) errors.favorites = 'Quatre favoris au plus.';
  return errors;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Statut personnalisé à envoyer : objet, ou null pour l'effacer. */
export function customStatusOf(d, now) {
  const text = d.statusText.trim();
  if (!d.emoji && !text) return null;
  const out = {};
  if (d.emoji) out.emoji = d.emoji;
  if (text) out.text = text;
  const at = d.expiry === 'keep' ? d.expiresAt : expiryAt(d.expiry, now);
  if (at) out.expiresAt = at;
  return out;
}

/**
 * Ce qui a changé entre `base` et `draft`, réparti selon les routes : { profile, avatar, prefs, presence }. Chaque entrée
 * n'existe que si elle change ; `profile` est le corps partiel de PUT /profile, `prefs` celui de PUT /prefs.
 */
export function diffDraft(base, draft, now = Date.now()) {
  const out = {};
  const profile = {};
  const name = draft.name.trim();
  if (name !== base.name) profile.name = name;
  if (draft.avatarColor.toLowerCase() !== base.avatarColor.toLowerCase()) profile.avatarColor = draft.avatarColor;
  const bio = draft.bio.trim();
  if (bio !== base.bio.trim()) profile.bio = bio === '' ? null : bio;
  const baseHas = Boolean(base.emoji || base.statusText.trim());
  const statusChanged = draft.emoji !== base.emoji || draft.statusText.trim() !== base.statusText.trim() || draft.expiry !== base.expiry;
  if (statusChanged) {
    const after = customStatusOf(draft, now);
    if (after !== null || baseHas) profile.customStatus = after;
  }
  if (!sameJson(base.banner, draft.banner)) profile.banner = draft.banner;
  if (!sameJson(base.favorites, draft.favorites)) profile.favorites = draft.favorites;
  if (Object.keys(profile).length) out.profile = profile;
  if ((draft.avatar || null) !== (base.avatar || null)) out.avatar = draft.avatar;
  if (draft.presence !== base.presence) out.presence = draft.presence;
  const prefs = {};
  for (const k of Object.keys(draft.prefs)) {
    if (k === 'notify') continue;
    if (draft.prefs[k] !== base.prefs[k]) prefs[k] = draft.prefs[k];
  }
  const notify = {};
  for (const k of Object.keys(draft.prefs.notify)) if (draft.prefs.notify[k] !== base.prefs.notify[k]) notify[k] = draft.prefs.notify[k];
  if (Object.keys(notify).length) prefs.notify = notify;
  if (Object.keys(prefs).length) out.prefs = prefs;
  return out;
}

/** Temps restant avant le prochain tirage de tag : { locked, ms, label }. */
export function tagCooldown(profile, now = Date.now()) {
  const at = profile && profile.tagChangeableAt;
  if (!at || at <= now) return { locked: false, ms: 0, label: '' };
  const ms = at - now;
  const days = Math.ceil(ms / DAY_MS);
  const label = days > 1 ? 'Nouveau tag possible dans ' + days + ' jours' : ms > HOUR_MS ? 'Nouveau tag possible dans ' + Math.ceil(ms / HOUR_MS) + ' h' : 'Nouveau tag possible dans moins d’une heure';
  return { locked: true, ms, label };
}

/** Déplace le favori `from` à la position `to` (nouvelle liste ; l'ancienne reste intacte). */
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list.slice();
  const next = list.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** Ajoute un titre aux favoris (refusé si déjà présent ou si la liste est pleine). */
export function addFavorite(list, fav) {
  if (list.length >= FAVORITES_MAX || list.some((f) => f.tmdbId === fav.tmdbId && f.type === fav.type)) return list;
  return [...list, fav];
}

/** Cadrage vertical de la bannière en % (0 = haut de l'image, 100 = bas) ; 50 quand il n'est pas réglé. */
export function bannerPosY(banner) {
  const y = banner && Number(banner.posY);
  return Number.isFinite(y) ? Math.min(100, Math.max(0, Math.round(y))) : 50;
}

/** Valeur CSS de `background-position` pour une bannière. */
export const bannerPosCss = (banner) => 'center ' + bannerPosY(banner) + '%';

/** Nouveau cadrage après un glissé de `dy` px (l'image suit le doigt) sur une zone `w`×`h` ; les backdrops TMDB sont en 16/9. */
export function panBannerY(startY, dy, w, h) {
  const range = Math.max(h, w * 9 / 16) - h;
  if (!(range > 0)) return startY;
  return Math.min(100, Math.max(0, Math.round(startY - (dy / range) * 100)));
}

/** Titre TMDB (search/multi) -> { type, tmdbId, title, poster, backdrop } ; null pour une personne ou un résultat sans id. */
export function mediaOf(r) {
  if (!r || (r.media_type !== 'movie' && r.media_type !== 'tv') || !r.id) return null;
  return {
    type: r.media_type === 'tv' ? 'series' : 'movie',
    tmdbId: r.id,
    title: r.title || r.name || '',
    poster: r.poster_path || '',
    backdrop: r.backdrop_path || '',
  };
}
