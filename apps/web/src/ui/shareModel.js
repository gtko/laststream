/* Social v3 (lot F4) : modèle pur de la fenêtre « Partager », des listes partagées et de la page publique d'un lien.
 * Aucun accès au réseau ni au DOM ; tout texte venant du serveur reste à afficher avec textContent. */
import { fold, posLabel } from './socialConvModel.js';

export { posLabel };

/** Pas de réglage du moment partagé (secondes). */
export const MOMENT_STEP = 10;
export const NOTE_MAX = 140;
export const LIST_NAME_MAX = 40;
export const SHARE_CODE_RE = /^[A-Za-z0-9_-]{10,64}$/;

/** `tv` (interface) devient `series` (serveur) et inversement. */
export const kindOf = (t) => (t === 'tv' || t === 'series' ? 'series' : 'movie');
export const uiTypeOf = (t) => (t === 'series' || t === 'tv' ? 'tv' : 'movie');

/** Média du partage normalisé : { type: 'movie'|'series', tmdbId, title, poster?, season?, episode? } ; null si inutilisable. */
export function normalizeMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const tmdbId = Number(m.tmdbId);
  const title = typeof m.title === 'string' ? m.title.trim() : '';
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !title) return null;
  const out = { type: kindOf(m.type), tmdbId, title };
  if (typeof m.poster === 'string' && m.poster) out.poster = m.poster;
  if (Number.isInteger(m.season)) out.season = m.season;
  if (Number.isInteger(m.episode)) out.episode = m.episode;
  return out;
}

/** Un moment se partage seulement s'il y a une position et un contenu lisible (film, ou épisode précis). */
export function canShareMoment(media, pos) {
  if (!media || typeof pos !== 'number' || !(pos >= 0) || !Number.isFinite(pos)) return false;
  return media.type === 'movie' || (Number.isInteger(media.season) && Number.isInteger(media.episode));
}

/** Position décalée de `delta` secondes, jamais négative, arrondie à la seconde. */
export const shiftPos = (pos, delta) => Math.max(0, Math.round((Number(pos) || 0) + delta));

/**
 * Destinataires possibles : amis (foyer compris, sans doublon) puis groupes.
 * { key: 'p:<pid>' | 'g:<id>', kind, id, name, tag, full, avatar?, avatarColor, members? }
 */
export function buildTargets(s) {
  const out = [];
  const seen = new Set();
  for (const f of [...(s.friends || []), ...(s.household || [])]) {
    if (!f || seen.has(f.pid)) continue;
    seen.add(f.pid);
    out.push({
      key: 'p:' + f.pid, kind: 'friend', id: f.pid, name: f.nickname || f.handle.name, tag: f.handle.tag, full: f.handle.full || f.handle.name + '#' + f.handle.tag,
      avatar: f.avatar, avatarColor: f.avatarColor,
    });
  }
  for (const g of s.groups || []) {
    if (!g || !g.group) continue;
    out.push({
      key: 'g:' + g.group.id, kind: 'group', id: g.group.id, name: g.group.name, tag: '', full: g.group.name,
      avatarColor: g.group.members && g.group.members[0] ? g.group.members[0].avatarColor : undefined,
      members: (g.group.members || []).map((m) => m.pid),
    });
  }
  return out;
}

/** Filtre sur le nom, le pseudo#TAG (accents et casse ignorés). */
export function filterTargets(list, q) {
  const n = fold(q).trim();
  if (!n) return list;
  return list.filter((t) => fold(t.name).includes(n) || fold(t.full).includes(n));
}

/** Clés présélectionnées : pids d'amis (`to`) et conversation (`conv` : « dm:<pid> » ou « g:<id> »), limitées aux destinataires connus. */
export function preselect(targets, to, conv) {
  const keys = [];
  const known = new Set(targets.map((t) => t.key));
  const add = (k) => { if (known.has(k) && !keys.includes(k)) keys.push(k); };
  if (Array.isArray(to)) to.forEach((pid) => add('p:' + pid));
  if (typeof conv === 'string') {
    if (conv.startsWith('dm:')) add('p:' + conv.slice(3));
    else if (conv.startsWith('g:')) add('g:' + conv.slice(2));
  }
  return keys;
}

/** Corps `to` de POST /share. */
export const toOf = (keys) => keys.map((k) => (k.startsWith('g:') ? { group: k.slice(2) } : { pid: k.slice(2) }));

/** Pids d'amis visés (amis choisis et membres des groupes choisis, sans doublon), pour la watch party. */
export function friendPids(targets, keys, mePid) {
  const out = new Set();
  for (const t of targets) {
    if (!keys.includes(t.key)) continue;
    if (t.kind === 'friend') out.add(t.id);
    else (t.members || []).forEach((p) => { if (p !== mePid) out.add(p); });
  }
  return [...out];
}

/** Libellé du bouton d'envoi : « Envoyer à Léa et Hugo », « Envoyer à Léa, Hugo et 2 autres ». */
export function sendLabel(targets, keys) {
  const names = targets.filter((t) => keys.includes(t.key)).map((t) => t.name);
  if (!names.length) return 'Envoyer';
  if (names.length === 1) return 'Envoyer à ' + names[0];
  if (names.length === 2) return 'Envoyer à ' + names[0] + ' et ' + names[1];
  const rest = names.length - 2;
  return 'Envoyer à ' + names[0] + ', ' + names[1] + ' et ' + rest + ' autre' + (rest > 1 ? 's' : '');
}

/** Référence « titre » d'un message (TitleRef). */
export function titleRefOf(media) {
  const t = { type: media.type, tmdbId: media.tmdbId, title: media.title };
  if (media.poster) t.poster = media.poster;
  return t;
}

/** Référence « moment » d'un message (MomentRef). */
export function momentRefOf(media, pos) {
  const m = { type: media.type, tmdbId: media.tmdbId, title: media.title, pos: shiftPos(pos, 0) };
  if (Number.isInteger(media.season)) m.season = media.season;
  if (Number.isInteger(media.episode)) m.episode = media.episode;
  return m;
}

/** Corps de POST /share. `mode` : 'moment' ou 'title'. Renvoie null s'il n'y a pas de destinataire ou de contenu valable. */
export function buildShareInput({ keys, media, mode, pos, body }) {
  if (!keys.length || !media) return null;
  const text = String(body || '').trim();
  const extra = text ? { body: text.slice(0, 1000) } : {};
  if (mode === 'moment' && canShareMoment(media, pos)) return { to: toOf(keys), kind: 'moment', moment: momentRefOf(media, pos), ...extra };
  return { to: toOf(keys), kind: 'title', title: titleRefOf(media), ...extra };
}

/**
 * Corps de POST /share-links.
 * @param {{ media: any, mode?: string, pos?: number, withInvite?: boolean, note?: string }} o
 * @returns {{ type: string, tmdbId: number, withInvite: boolean, pos?: number, note?: string }}
 */
export function buildLinkInput({ media, mode, pos, withInvite, note }) {
  const out = { type: media.type, tmdbId: media.tmdbId, withInvite: !!withInvite };
  if (mode === 'moment' && canShareMoment(media, pos)) out.pos = shiftPos(pos, 0);
  const n = String(note || '').trim();
  if (n) out.note = n.slice(0, NOTE_MAX);
  return out;
}

/** Clé de cache d'un lien créé : le même choix redonne le même lien (sans réserver une autre invitation). */
export const linkKey = (o) => [o.type, o.tmdbId, o.pos === undefined ? '' : o.pos, o.withInvite ? 1 : 0, o.note || ''].join('|');

/** Invitations libres du compte, depuis la réponse de /invites. */
export const freeInvites = (d) => (d && Array.isArray(d.invites) ? d.invites.filter((i) => i.state === 'free').length : 0);

export const invitesText = (n) => (n > 0 ? 'Il en reste ' + n + '.' : 'Il ne t’en reste plus.');

/** Texte qui accompagne le lien dans un message, un e-mail ou le partage système. */
export function shareText(media, pos, mode) {
  return mode === 'moment' && canShareMoment(media, pos)
    ? media.title + ' à ' + posLabel(pos) + ' sur Laststream'
    : media.title + ' sur Laststream';
}

/** Code d'un lien public : `#/t/<code>` ou chemin `/t/<code>` (page servie par le Worker). Chaîne vide sinon. */
export function shareCodeFrom(hash, pathname) {
  const h = /^#\/t\/([A-Za-z0-9_-]{10,64})\/?$/.exec(hash || '');
  if (h) return h[1];
  const p = /^\/t\/([A-Za-z0-9_-]{10,64})\/?$/.exec(pathname || '');
  return p ? p[1] : '';
}

/** Liste partagée : `#/list/<id>`. */
export function listIdFrom(hash) {
  const m = /^#\/list\/([A-Za-z0-9_-]{1,64})\/?$/.exec(hash || '');
  return m ? m[1] : '';
}

/** Adresse de la fiche d'un titre dans l'application. */
export const ficheHash = (type, tmdbId) => '#/' + uiTypeOf(type) + '/' + tmdbId;

/** Lien vers l'inscription existante avec le code d'invitation (`/?invite=<code>`), relatif à l'origine donnée. */
export function signupUrl(origin, code) {
  return String(origin).replace(/\/+$/, '') + '/?invite=' + encodeURIComponent(code);
}

/** Texte « À 1:12:34 » du moment recommandé, ou '' pour un titre entier. */
export const momentNote = (view) => (view && typeof view.pos === 'number' && view.pos > 0 ? 'Recommandé à partir de ' + posLabel(view.pos) : '');

/** Membres d'une liste, sauf moi : « Léa, Hugo ». */
export function memberNames(list, mePid) {
  return (list.members || []).filter((m) => m.pid !== mePid).map((m) => m.nickname || m.handle.name).join(', ');
}

/** Nom de celui qui a ajouté un élément : « toi », le pseudo d'un membre, ou « un ancien membre ». */
export function adderName(pid, list, mePid) {
  if (pid === mePid) return 'toi';
  const m = (list.members || []).find((x) => x.pid === pid);
  return m ? m.nickname || m.handle.name : 'un ancien membre';
}

// ---- Mes liens publics (section « Mes liens » de la fenêtre Partager) ----

const dayMonth = (ms) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/**
 * Textes d'une ligne de « Mes liens » : titre (avec le moment s'il y en a un) et ligne d'état.
 * Un lien expiré (`expired`, ou `expiresAt` passé) n'est plus lisible : on l'indique et on ne propose que « Révoquer ».
 */
export function linkRow(l, now = Date.now()) {
  const expired = !!l.expired || (Number.isFinite(l.expiresAt) && l.expiresAt <= now);
  const at = typeof l.pos === 'number' && l.pos > 0 ? ' · à ' + posLabel(l.pos) : '';
  const made = Number.isFinite(l.createdAt) ? 'Créé le ' + dayMonth(l.createdAt) : '';
  const left = !expired && Number.isFinite(l.expiresAt)
    ? 'expire le ' + dayMonth(l.expiresAt)
    : '';
  return {
    title: (l.title || 'Lien') + at,
    sub: expired ? [made, 'expiré'].filter(Boolean).join(' · ') : [made, left].filter(Boolean).join(' · '),
    expired,
  };
}

/** Message d'une erreur sur « Mes liens » (lecture ou révocation). */
export function linksErrorText(e, action) {
  if (e && e.status === 404 && action === 'revoke') return 'Ce lien n’existe déjà plus.';
  if (e && e.status === 429) return 'Trop de demandes d’un coup : réessaie dans une minute.';
  if (e && (e.status === 0 || e.code === 'network')) return 'Serveur injoignable pour le moment.';
  return action === 'revoke' ? 'Impossible de révoquer le lien pour le moment.' : 'Tes liens ne peuvent pas s’afficher pour le moment.';
}
