/* Billets de parrainage (Réglages > Profil et compte) : chaque compte a ses billets (quatre par défaut). Un billet libre reçoit
 * un mot et trois coups de cœur tirés de la bibliothèque ; copié ou partagé, il est envoyé (valable 14 jours) ; validé, il affiche
 * le nom du filleul. Un billet révoqué par l'administrateur n'offre aucune action. Le propriétaire du serveur règle le quota d'un compte. */
import '../styles/tickets.css';
import { auth } from '../data/auth';
import { shareBase } from '../data/shareBase';
import { safeImageUrl } from '../data/imageUrl';
import { inviteLink } from '../data/invite';
import { getInvites, markInviteSent, revokeInvite, setInviteQuota, updateInvite } from '../data/socialApi';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { card } from './settings-ui.js';
import { detailEl, toast } from './dom.js';
import { fmtShort } from './dates.js';
import { IMG } from './constants.js';
import { state } from './state.js';
import { esc } from './util.js';

/** Mot du parrain : 280 caractères au plus (unités UTF-16, comme le serveur). */
export const MESSAGE_MAX = 280;
/** Coups de cœur par billet. */
export const PICKS_MAX = 3;
/** Affiches proposées dans le composeur : les plus récentes de la bibliothèque, plus les coups de cœur déjà choisis. */
const PICK_GRID_MAX = 12;
/** Validité d'un billet après l'envoi (le serveur pose `expires_at` = envoi + 14 jours). */
const VALID_DAYS = 14;
const DAY_MS = 86_400_000;

/** État affiché : `null` avant le premier chargement, `'error'` si le serveur ne répond pas. */
let data = null;
let busy = false;
/** Billet ouvert dans le panneau du bas. */
let selectedId = null;
/** Mot tapé et pas encore enregistré, par billet. */
const drafts = new Map();
/** Enregistrements (PUT) mis en file : ils partent l'un après l'autre. */
let chain = Promise.resolve(true);
/** Révision locale par billet : elle monte à chaque modification (mot, coup de cœur). Une réponse de PUT ne s'applique que si elle n'a pas bougé. */
const revs = new Map();
/** Enregistrement en file par billet : révision visée et promesse. Un état déjà en file (même révision) n'est pas renvoyé. */
const queued = new Map();
/** Serveur sans personnalisation (PUT 404 ou 405) : composeur en lecture seule, copie et partage restent possibles. */
let personalisationOff = false;
/** Vrai entre l'ouverture de la carte et l'arrivée des données : les billets se distribuent alors, pas à chaque redessin. */
let dealPending = false;

const revOf = (id) => revs.get(id) || 0;
const bump = (id) => revs.set(id, revOf(id) + 1);

/** Adresse des liens (voir data/shareBase.ts), réexportée pour les écrans qui importent les invitations. */
export { shareBase };

export const linkOf = (inv) => inviteLink(shareBase(), inv.code);

/** Révoqué par l'administrateur (état `revoked`, ou date `revokedAt` renseignée). */
const isRevoked = (inv) => inv.state === 'revoked' || !!inv.revokedAt;
/** Adresse d'image acceptée (https, hôte autorisé : voir data/imageUrl.ts), sinon null. */
const httpsUrl = (u) => safeImageUrl(u) || null;
const pickKey = (p) => p.type + ':' + p.id;
const initialOf = (name) => (Array.from(String(name || '').trim())[0] || '?').toUpperCase();
const shortDate = (iso) => (iso ? fmtShort(iso) : '');
/** Numéro affiché : 4 chiffres. Sans numéro serveur (serveur antérieur), la position dans la liste. */
const ticketNumber = (inv, index) => {
  const n = inv.number;
  return String(n == null || n === '' ? index + 1 : n).padStart(4, '0');
};
const messageOf = (inv) => (drafts.has(inv.id) ? drafts.get(inv.id) : typeof inv.message === 'string' ? inv.message : '');
const dirty = (inv) => drafts.has(inv.id) && drafts.get(inv.id) !== (typeof inv.message === 'string' ? inv.message : '');

/** « expire dans 9 j » / « expire dans 5 h », « expiré » si la date est passée, '' si elle est absente. */
export function expiryText(expiresAt, now = Date.now()) {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return '';
  const ms = end - now;
  if (ms <= 0) return 'expiré';
  // Arrondi au supérieur : 8 j 23 h restantes s'affichent « 9 j », comme la maquette.
  if (ms >= DAY_MS) return 'expire dans ' + Math.ceil(ms / DAY_MS) + ' j';
  if (ms >= 3600000) return 'expire dans ' + Math.ceil(ms / 3600000) + ' h';
  return 'expire dans ' + Math.max(1, Math.ceil(ms / 60000)) + ' min';
}

/**
 * Coup de cœur normalisé pour l'API : identifiant en chaîne (le serveur refuse un nombre), type tel quel, nom, affiche et fond
 * en https ou chaîne vide (le serveur refuse null).
 */
const toPick = (p) => ({ id: String(p.id), type: p.type, name: String(p.name), poster: httpsUrl(p.poster) || '', background: httpsUrl(p.background) || '' });
/** Coups de cœur du billet, limités à 3. Un type inconnu du client est gardé tel quel (16 caractères au plus). */
const picksOf = (inv) =>
  (Array.isArray(inv.picks) ? inv.picks : [])
    .filter((p) => p && p.id != null && typeof p.type === 'string' && p.type.length > 0 && p.type.length <= 16 && typeof p.name === 'string')
    .slice(0, PICKS_MAX)
    .map(toPick);

/** Affiche d'un titre de la bibliothèque du profil actif (même source que « Ma bibliothèque »). */
function libraryPick(entry) {
  const type = entry.type === 'tv' ? 'series' : 'movie';
  const poster = httpsUrl(IMG('w342', entry.poster));
  const known = state.byKey.get(entry.type + ':' + entry.id);
  return { key: type + ':' + entry.id, id: entry.id, type, name: entry.title || 'Sans titre', poster, background: httpsUrl(known && known.backdrop) || poster };
}

/**
 * Affiches du composeur : les plus récentes de la bibliothèque dont l'affiche est une adresse acceptée par le serveur (sinon le
 * PUT serait refusé), puis les coups de cœur déjà choisis qui n'y figurent pas.
 */
function pickOptions(picks) {
  const lib = userStore.getLibrary()
    .slice()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .map(libraryPick)
    .filter((o) => o.poster)
    .slice(0, PICK_GRID_MAX);
  const shown = new Set(lib.map((o) => o.key));
  return lib.concat(picks.filter((p) => !shown.has(pickKey(p))).map((p) => ({ ...p, key: pickKey(p) })));
}

/** Icônes d'état (le texte dit toujours l'état : la couleur et l'icône ne sont qu'un renfort). */
const icon = (d) => '<svg class="tk-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + d + '</svg>';
const ICONS = {
  free: icon('<path d="M12 5v14M5 12h14"></path>'),
  sent: icon('<path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4 20-7z"></path>'),
  used: icon('<path d="M20 6 9 17l-5-5"></path>'),
  revoked: icon('<circle cx="12" cy="12" r="9"></circle><path d="m5.6 5.6 12.8 12.8"></path>'),
};
const CHEVRON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"></path></svg>';
const CLOSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"></path></svg>';
/** Légende sous la rangée : un libellé par état. */
const LEGEND = [
  ['free', 'Disponible'],
  ['sent', 'Envoyé, en attente'],
  ['used', 'Validé'],
  ['revoked', 'Révoqué'],
];

/** Carte repliée par défaut ; ouverte ou repliée, l'état est mémorisé sur l'appareil. */
const OPEN_KEY = 'ls_tickets_open';
const readOpen = () => { try { return globalThis.localStorage?.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const writeOpen = (on) => { try { globalThis.localStorage?.setItem(OPEN_KEY, on ? '1' : '0'); } catch { /* stockage indisponible : l'état n'est pas gardé */ } };
let cardOpen = false;
/** Écran étroit (≤ 640 px) : billets en carrousel, personnalisation en feuille du bas. */
const SHEET_MQ = '(max-width: 640px)';
const media = (q) => (typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false);
const isSheet = () => media(SHEET_MQ);
/** Au-delà, les points de position laissent la place au seul texte « Billet n sur N ». */
const DOTS_MAX = 8;
/** Miniatures de l'en-tête replié. */
const MINIS_MAX = 8;

/** État visuel d'un billet : libellés, classe de couleur et libellé lu par les lecteurs d'écran. */
function ticketView(inv, index) {
  const num = ticketNumber(inv, index);
  if (isRevoked(inv)) return { kind: 'revoked', num, head: 'Révoqué', sub: 'Par l’administrateur', stub: 'Révoqué', aria: 'Révoqué par l’administrateur, ne peut plus être envoyé' };
  if (inv.state === 'used') {
    const since = shortDate(inv.usedAt);
    const who = inv.invitee || 'Compte supprimé';
    return { kind: 'used', num, head: who, sub: since ? 'Validé le ' + since : 'Validé', stub: 'Validé', aria: 'Validé par ' + who + (since ? ' le ' + since : '') };
  }
  if (inv.state === 'sent') {
    const exp = expiryText(inv.expiresAt);
    return { kind: 'sent', num, head: 'En attente', sub: 'Envoyé' + (exp ? ' · ' + exp : ''), stub: 'En route', aria: 'Envoyé, en attente' + (exp ? ', ' + exp : '') };
  }
  return { kind: 'free', num, head: 'Offrir ce billet', sub: 'Une place pour un ami', stub: 'Admis', aria: 'Disponible, à offrir' };
}

/** Billet (design d'origine : dégradé, encoches, talon). Un billet révoqué reste lisible au clavier mais ne s'ouvre pas. */
function ticketHTML(inv, index, selected, deal) {
  const v = ticketView(inv, index);
  const id = esc(inv.id);
  const off = v.kind === 'revoked';
  return '<button type="button" class="tk-ticket tk-is-' + v.kind + (deal ? ' tk-deal' : '') + '"' + (off ? '' : ' data-tk-sel="' + id + '"') +
    ' data-tk-ticket data-tk-focus="ticket:' + id + '"' + (off ? ' aria-disabled="true"' : ' aria-pressed="' + (selected ? 'true' : 'false') + '"') +
    ' aria-label="' + esc('Billet ' + v.num + ' · ' + v.aria) + '">' +
    '<span class="tk-main"><span class="tk-num">Billet N° ' + esc(v.num) + '</span><span class="tk-head">' + esc(v.head) + '</span>' +
    '<span class="tk-sub">' + ICONS[v.kind] + esc(v.sub) + '</span></span>' +
    '<span class="tk-stub"><span class="tk-stub-t">' + esc(v.stub) + '</span></span>' +
    '<span class="tk-notch tk-notch-t" aria-hidden="true"></span><span class="tk-notch tk-notch-b" aria-hidden="true"></span>' +
    (v.kind === 'free' ? '<span class="tk-shine" aria-hidden="true"></span>' : '') + '</button>';
}

function pickHTML(o, picks, off) {
  const on = picks.some((p) => pickKey(p) === o.key);
  const full = picks.length >= PICKS_MAX;
  const key = esc(o.key);
  const img = o.poster
    ? '<img src="' + esc(o.poster) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
    : '<span class="tk-noimg" aria-hidden="true">' + esc(initialOf(o.name)) + '</span>';
  return '<button type="button" class="tk-pick' + (on ? ' is-on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
    (off ? ' disabled' : full && !on ? ' aria-disabled="true"' : '') + ' aria-label="' + esc(o.name) + '" data-tk-pick="' + key + '" data-tk-focus="pick:' + key + '">' + img +
    '<span class="tk-check" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span></button>';
}

/**
 * Composeur d'un billet libre : mot (à gauche), coups de cœur (à droite), copier ou partager. `sheet` : feuille du bas (mobile),
 * fenêtre modale dont Copier et Partager restent collés en bas.
 */
function composerHTML(inv, index, sheet) {
  const id = esc(inv.id);
  const off = personalisationOff;
  // Serveur sans personnalisation : on affiche ce qu'il a, pas le brouillon qui ne peut pas être enregistré.
  const msg = off ? (typeof inv.message === 'string' ? inv.message : '') : messageOf(inv);
  const picks = picksOf(inv);
  const options = pickOptions(picks);
  const grid = options.length
    ? '<div class="tk-grid-picks" role="group" aria-label="Coups de cœur">' + options.map((o) => pickHTML(o, picks, off)).join('') + '</div>'
    : '<p class="tk-note">Ajoute des films ou séries à ta bibliothèque pour les proposer ici.</p>';
  const warn = off
    ? '<p class="tk-note tk-note-warn" role="status">Personnalisation indisponible : ce serveur ne sait pas encore enregistrer le mot ni les coups de cœur. Copier et Partager fonctionnent quand même.</p>'
    : '';
  return (sheet ? '<div class="tk-scrim" data-tk-close aria-hidden="true"></div>' : '') +
    '<section class="tk-compose' + (sheet ? ' is-sheet' : '') + '" aria-labelledby="tk-compose-t"' + (sheet ? ' role="dialog" aria-modal="true" data-tk-sheet' : '') + '>' +
    '<button type="button" class="tk-close" data-tk-close data-tk-focus="close" aria-label="Fermer">' + CLOSE + '</button>' +
    '<div class="tk-compose-l">' +
      '<h3 class="tk-compose-t" id="tk-compose-t">Personnalise le billet N° ' + esc(ticketNumber(inv, index)) + '</h3>' + warn +
      '<label class="tk-label" for="tk-msg">Ton mot, affiché sur sa page d’arrivée</label>' +
      '<textarea id="tk-msg" class="tk-msg" rows="3" maxlength="' + MESSAGE_MAX + '" data-tk-msg="' + id + '" data-tk-focus="msg" aria-describedby="tk-msg-count"' + (off ? ' readonly' : '') + '>' + esc(msg) + '</textarea>' +
      '<div class="tk-count" id="tk-msg-count">' + msg.length + ' / ' + MESSAGE_MAX + '</div>' +
      '<div class="tk-actions"><button type="button" class="tk-btn tk-btn-primary" data-tk-copy="' + id + '" data-tk-focus="copy">Copier le lien</button>' +
      '<button type="button" class="tk-btn" data-tk-share="' + id + '" data-tk-focus="share">Partager…</button></div>' +
      '<p class="tk-note">Valable 14 jours après l’envoi · révocable · le billet revient si personne ne l’utilise</p>' +
    '</div>' +
    '<div class="tk-compose-r">' +
      '<div class="tk-picks-h"><span class="tk-picks-t">Tes 3 coups de cœur à lui faire découvrir</span>' +
      '<span class="tk-picks-n' + (picks.length >= PICKS_MAX ? ' is-full' : '') + '" aria-live="polite">' + picks.length + ' / ' + PICKS_MAX + '</span></div>' +
      '<p class="tk-status" id="tk-pick-status" role="status"></p>' +
      grid +
      '<p class="tk-note">Tirés de ta bibliothèque · fanart HD affiché en fond de son invitation</p>' +
    '</div></section>';
}

/** Panneau du billet ouvert : composeur (libre), nom du filleul (validé), relance ou annulation (envoyé), rien (révoqué). */
function panelHTML(inv, index, sheet) {
  const id = esc(inv.id);
  if (isRevoked(inv)) {
    return '<section class="tk-panel tk-panel-revoked" aria-live="polite"><div class="tk-panel-b">' +
      '<p class="tk-panel-t">Révoqué par l’administrateur</p><p class="tk-panel-d">Ce billet ne peut plus être envoyé.</p></div></section>';
  }
  if (inv.state === 'free') return composerHTML(inv, index, sheet);
  if (inv.state === 'used') {
    const who = inv.invitee ? esc(inv.invitee) + ' a validé ce billet' : 'Billet validé (compte supprimé)';
    const since = shortDate(inv.usedAt);
    const facts = ['Billet N° ' + esc(ticketNumber(inv, index)), since ? 'Validé le ' + since : ''].filter(Boolean).join(' · ');
    return '<section class="tk-panel tk-panel-used" aria-live="polite"><span class="tk-avatar" aria-hidden="true">' + esc(initialOf(inv.invitee)) + '</span>' +
      '<div class="tk-panel-b"><p class="tk-panel-t">' + who + '</p><p class="tk-panel-d">' + facts + '</p></div></section>';
  }
  if (inv.state === 'sent') {
    const sent = shortDate(inv.sentAt);
    const exp = expiryText(inv.expiresAt);
    const title = 'Envoyé' + (sent ? ' le ' + sent : '') + ' · pas encore ouvert';
    const text = (exp ? 'Le lien ' + exp + '. ' : '') + 'Annule-le pour récupérer le billet.';
    const quote = inv.message ? '<p class="tk-quote">« ' + esc(inv.message) + ' »</p>' : '';
    return '<section class="tk-panel tk-panel-sent" aria-live="polite"><div class="tk-panel-b">' +
      '<p class="tk-panel-t">' + esc(title) + '</p><p class="tk-panel-d">' + esc(text) + '</p>' + quote + '</div>' +
      '<div class="tk-panel-btns"><button type="button" class="tk-btn" data-tk-copy="' + id + '" data-tk-focus="copy">Copier à nouveau</button>' +
      '<button type="button" class="tk-btn tk-btn-danger" data-tk-revoke="' + id + '" data-tk-focus="revoke">Annuler le billet</button></div></section>';
  }
  return '';
}

/** Billet ouvert : seulement celui que l'on a choisi (aucun n'est présélectionné). Oublie un choix qui n'existe plus. */
function currentSelection(list) {
  const sel = selectedId == null ? null : list.find((i) => i.id === selectedId) || null;
  if (!sel) selectedId = null;
  return sel;
}

const plural = (n, word) => n + ' ' + word + (n > 1 ? 's' : '');

/** Résumé de l'en-tête : « 4 billets disponibles · 0 validé » (les envoyés s'ajoutent s'il y en a). */
function summaryText(list) {
  if (!list.length) return 'Aucun billet pour le moment';
  const free = list.filter((i) => i.state === 'free' && !isRevoked(i)).length;
  const sent = list.filter((i) => i.state === 'sent' && !isRevoked(i)).length;
  const used = list.filter((i) => i.state === 'used').length;
  const parts = [free ? plural(free, 'billet') + ' disponible' + (free > 1 ? 's' : '') : 'Aucun billet disponible'];
  if (sent) parts.push(plural(sent, 'envoyé'));
  parts.push(plural(used, 'validé'));
  return parts.join(' · ');
}

/** Miniatures de l'en-tête replié : le design des billets en petit, coloré par état (décoratif, le résumé dit tout). */
function minisHTML(list) {
  if (!list.length) return '';
  const minis = list.slice(0, MINIS_MAX).map((inv, n) => '<span class="tk-mini tk-is-' + ticketView(inv, n).kind + '"></span>').join('');
  const more = list.length > MINIS_MAX ? '<span class="tk-mini-more">+' + (list.length - MINIS_MAX) + '</span>' : '';
  return '<span class="tk-minis" aria-hidden="true">' + minis + more + '</span>';
}

/** En-tête de la carte : bouton d'accordéon (titre, résumé, miniatures, chevron). */
function foldHeadHTML(d) {
  const list = d && d !== 'error' ? d.invites : null;
  const sub = d === null ? 'Chargement des billets…' : list ? summaryText(list) : 'Billets indisponibles pour le moment';
  return '<h3 class="tk-fold-hd"><button type="button" class="tk-fold" id="tk-fold-b" aria-expanded="' + (cardOpen ? 'true' : 'false') + '" aria-controls="tk-fold-r" data-tk-fold data-tk-focus="fold">' +
    '<span class="tk-fold-t"><span class="tk-fold-h">Mes billets de parrainage</span><span class="tk-fold-s">' + esc(sub) + '</span></span>' +
    (list ? minisHTML(list) : '') + '<span class="tk-fold-c">' + CHEVRON + '</span></button></h3>';
}

/** Rangée de billets (grille ; carrousel sur mobile), points de position, légende, puis le panneau du billet choisi. */
function inviteTicketsHTML(list) {
  const deal = dealPending;
  dealPending = false;
  const sel = currentSelection(list);
  const at = sel ? list.indexOf(sel) : -1;
  const n = list.length;
  const sheet = !!sel && sel.state === 'free' && !isRevoked(sel) && isSheet();
  const dots = n > 1
    ? '<div class="tk-dots">' + (n <= DOTS_MAX ? '<span class="tk-dots-i" aria-hidden="true">' + list.map((_, i) => '<span class="tk-dot' + (i === 0 ? ' is-on' : '') + '"></span>').join('') + '</span>' : '') +
      '<span class="tk-dots-t' + (n <= DOTS_MAX ? ' sr-only' : '') + '" data-tk-pos>Billet 1 sur ' + n + '</span></div>'
    : '';
  const legend = '<ul class="tk-legend" aria-label="États des billets">' +
    LEGEND.map(([k, t]) => '<li><span class="tk-mini tk-is-' + k + '" aria-hidden="true"></span>' + ICONS[k] + '<span>' + t + '</span></li>').join('') + '</ul>';
  // Seule la rangée est un conteneur de requête : un conteneur englobant ferait de la carte le bloc de référence de la feuille du bas (position: fixed).
  return '<div class="tk-row-wrap"><div class="tk-row" role="group" aria-label="Billets de parrainage" data-tk-row>' +
    list.map((inv, i) => ticketHTML(inv, i, i === at, deal)).join('') + '</div></div>' + dots + legend +
    (sel ? '<div class="tk-pane' + (sheet ? ' is-sheet-host' : '') + '" data-tk-pane data-tk-at="' + at + '">' + panelHTML(sel, at, sheet) + '</div>' : '');
}

/** Corps de la carte : en-tête repliable et région (chargement, erreur, ou billets). */
export function invitesBodyHTML(d) {
  return foldHeadHTML(d) + '<div class="tk-fold-r" id="tk-fold-r" role="region" aria-labelledby="tk-fold-b"' + (cardOpen ? '' : ' hidden') + '>' +
    '<div class="tk-fold-in">' + regionHTML(d) + '</div></div>';
}

function regionHTML(d) {
  if (d === null) return '<p class="set-hint" role="status">Chargement des billets…</p>';
  if (d === 'error') return '<p class="set-hint" role="alert">Billets indisponibles : le serveur ne répond pas. <button type="button" class="link-btn" data-inv-reload>Réessayer</button></p>';
  const list = d.invites;
  const owner = auth.isOwner
    ? '<form class="inv-quota" data-inv-quota><label class="set-row-d" for="inv-q-user">Quota d’un compte (propriétaire du serveur)</label>' +
      '<span class="inv-quota-f"><input class="set-input set-input-sm" id="inv-q-user" name="user" type="text" placeholder="pseudo" value="' + esc(auth.username) + '" autocapitalize="none" required>' +
      '<input class="set-input set-input-sm" name="quota" type="number" min="0" max="100" value="' + d.quota + '" aria-label="Nombre de billets" required>' +
      '<button type="submit" class="btn btn-ghost btn-sm">Appliquer</button></span></form>'
    : '';
  const help = list.length
    ? '<p class="tk-help">Invite tes proches avec un billet personnel : un mot et trois coups de cœur. Choisis un billet disponible pour le personnaliser. ' +
      'Chaque billet ne sert qu’une fois ; ton filleul pourra devenir ton ami en un clic.</p>'
    : '<p class="set-hint">Aucun billet pour le moment.</p>';
  return help + (list.length ? inviteTicketsHTML(list) : '') + owner;
}

/** Carte du panneau « Profil et compte » ; le contenu se met à jour sans redessiner la page. Repliée par défaut, aucun billet choisi. */
export function invitesCard() {
  dealPending = true;
  // Un redessin de la page ne déclenche pas le `change` d'un champ remplacé : on enregistre les mots en cours avant de fermer le composeur.
  if (data && data !== 'error' && Array.isArray(data.invites)) {
    for (const inv of data.invites) if (dirty(inv)) saveDraft(inv.id).catch(() => {});
  }
  // Chaque ouverture des réglages retente la personnalisation (le serveur a pu être mis à jour).
  personalisationOff = false;
  selectedId = null;
  cardOpen = readOpen();
  return card('', '<div id="inv-slot">' + invitesBodyHTML(data) + '</div>', { attrs: 'data-tk-card' });
}

/** Pointe du panneau (bureau) sous le billet choisi, mesurée sur la mise en page réelle. */
function placePointer(slot) {
  const pane = slot.querySelector('[data-tk-pane]');
  const ticket = pane && slot.querySelector('.tk-ticket[aria-pressed="true"]');
  if (!pane || !ticket) return;
  const p = pane.getBoundingClientRect();
  const t = ticket.getBoundingClientRect();
  if (!p.width || !t.width) return;
  const x = Math.min(p.width - 28, Math.max(28, t.left + t.width / 2 - p.left));
  pane.style.setProperty('--tk-ptr', Math.round(x) + 'px');
}

/** Points de position du carrousel (mobile) : billet le plus proche du bord gauche, ou le dernier en fin de défilement. */
function syncDots(slot, row) {
  const items = Array.from(row.querySelectorAll('[data-tk-ticket]'));
  if (!items.length) return;
  const max = row.scrollWidth - row.clientWidth;
  let n = 0;
  if (max > 0 && row.scrollLeft >= max - 2) n = items.length - 1;
  else {
    const base = items[0].offsetLeft;
    let best = Infinity;
    items.forEach((el, i) => {
      const gap = Math.abs(el.offsetLeft - base - row.scrollLeft);
      if (gap < best) { best = gap; n = i; }
    });
  }
  slot.querySelectorAll('.tk-dot').forEach((dot, i) => dot.classList.toggle('is-on', i === n));
  const pos = slot.querySelector('[data-tk-pos]');
  const text = 'Billet ' + (n + 1) + ' sur ' + items.length;
  if (pos && pos.textContent !== text) pos.textContent = text;
}

/**
 * Redessine le panneau. `focus` (valeur de `data-tk-focus`) rend le focus à cet élément ; sans valeur, le focus déjà dans le panneau est gardé.
 * La position du carrousel est conservée ; une feuille du bas ouverte reçoit le focus (fenêtre modale).
 */
function paint(focus) {
  const slot = detailEl.querySelector('#inv-slot');
  if (!slot) return;
  const active = slot.contains(document.activeElement) ? document.activeElement.dataset.tkFocus : undefined;
  const oldRow = slot.querySelector('[data-tk-row]');
  const x = oldRow ? oldRow.scrollLeft : 0;
  slot.innerHTML = invitesBodyHTML(data);
  const row = slot.querySelector('[data-tk-row]');
  if (row) {
    if (x) row.scrollLeft = x;
    syncDots(slot, row);
  }
  placePointer(slot);
  const target = focus || active;
  if (target) {
    const el = Array.from(slot.querySelectorAll('[data-tk-focus]')).find((n) => n.dataset.tkFocus === target);
    if (el) el.focus({ preventScroll: true });
  }
  const sheet = slot.querySelector('[data-tk-sheet]');
  if (sheet && !sheet.contains(document.activeElement)) {
    const close = sheet.querySelector('.tk-close');
    if (close) close.focus({ preventScroll: true });
  }
}

/** Ouvre ou replie la carte (accordéon) sans redessiner : le focus reste sur l'en-tête. */
let foldAnim = null;
function toggleCard() {
  const slot = detailEl.querySelector('#inv-slot');
  const btn = slot && slot.querySelector('[data-tk-fold]');
  const region = slot && slot.querySelector('#tk-fold-r');
  if (!btn || !region) return;
  cardOpen = !cardOpen;
  writeOpen(cardOpen);
  btn.setAttribute('aria-expanded', cardOpen ? 'true' : 'false');
  const open = cardOpen;
  if (foldAnim) { const prev = foldAnim; foldAnim = null; prev.cancel(); }
  region.style.overflow = '';
  if (open) region.hidden = false;
  if (open) {
    placePointer(slot);
    const row = slot.querySelector('[data-tk-row]');
    if (row) syncDots(slot, row);
  }
  if (typeof region.animate !== 'function' || media('(prefers-reduced-motion: reduce)')) {
    region.hidden = !open;
    return;
  }
  const h = region.scrollHeight;
  region.style.overflow = 'hidden';
  const anim = region.animate(
    [{ height: (open ? 0 : h) + 'px', opacity: open ? 0 : 1 }, { height: (open ? h : 0) + 'px', opacity: open ? 1 : 0 }],
    { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
  foldAnim = anim;
  anim.onfinish = () => {
    if (foldAnim !== anim) return;
    foldAnim = null;
    region.style.overflow = '';
    if (!open) region.hidden = true;
  };
}

/** Charge les invitations du compte (à l'ouverture des réglages). */
export async function refreshInvites() {
  try {
    data = await getInvites();
  } catch {
    data = 'error';
  }
  paint();
  return data;
}

const find = (id) => (data && data !== 'error' ? data.invites.find((i) => i.id === id) : undefined);

/** Premier lien encore utilisable (libre ou envoyé) : bloc « Inviter quelqu’un » de la barre latérale des amis. */
export const usableInvite = () => (data && data !== 'error' ? data.invites.find((i) => i.state !== 'used' && !isRevoked(i)) ?? null : null);
const patch = (inv) => { data.invites = data.invites.map((i) => (i.id === inv.id ? { ...i, ...inv } : i)); };

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* repli ci-dessous */ }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { field.remove(); }
}

async function markSent(inv) {
  if (inv.state !== 'free') return;
  try {
    await markInviteSent(inv.id, true);
    const now = Date.now();
    patch({ id: inv.id, state: 'sent', sentAt: new Date(now).toISOString(), expiresAt: new Date(now + VALID_DAYS * DAY_MS).toISOString() });
    const slot = detailEl.querySelector('#inv-slot');
    paint(slot && slot.contains(document.activeElement) ? 'copy' : null);
  } catch { /* indicatif : l'état « envoyé » n'est pas essentiel */ }
}

export async function copyInvite(id) {
  const inv = find(id);
  if (!inv) return false;
  const ok = await copyText(linkOf(inv));
  toast(ok ? 'Lien copié' : 'Copie impossible : sélectionne le lien et copie-le');
  if (ok) await markSent(inv);
  return ok;
}

export async function shareInvite(id) {
  const inv = find(id);
  if (!inv) return false;
  const url = linkOf(inv);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Invitation Laststream', text: 'Rejoins-moi sur Laststream :', url });
      await markSent(inv);
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false; // partage annulé
    }
  }
  return copyInvite(id);
}

export async function revokeOne(id) {
  const inv = find(id);
  if (!inv || inv.state === 'used') return false;
  try {
    const res = await revokeInvite(id);
    const fresh = res && res.invite ? res.invite : { ...inv, state: 'free', sentAt: null, expiresAt: null };
    data.invites = data.invites.map((i) => (i.id === id ? fresh : i));
    paint('ticket:' + id);
    toast('Billet annulé : il est de nouveau libre');
    return true;
  } catch (err) {
    const code = err instanceof UserApiError ? err.code : '';
    if (code === 'invite_revoked') toast('Ce billet a été révoqué par l’administrateur : il ne peut plus être régénéré.');
    else toast(code === 'invite_used' ? 'Ce billet est déjà validé' : 'Annulation impossible');
    if (code === 'invite_used' || code === 'invite_revoked') refreshInvites();
    return false;
  }
}

export async function applyQuota(user, quota) {
  try {
    const res = await setInviteQuota(user.trim().toLowerCase(), quota);
    toast('Quota de ' + res.username + ' : ' + res.quota);
    if (res.username === auth.username) await refreshInvites();
    return true;
  } catch (err) {
    toast(err instanceof UserApiError && err.code === 'account_not_found' ? 'Compte introuvable' : err instanceof UserApiError && err.code === 'owner_only' ? 'Réservé au propriétaire du serveur' : 'Quota non modifié');
    return false;
  }
}

/**
 * Enregistre mot et coups de cœur d'un billet libre (PUT /user/invites/:id), à la suite des enregistrements en cours.
 * Un état déjà en file (même révision) n'est pas renvoyé : un seul PUT en vol ou en attente par état et par billet.
 */
function saveDraft(id) {
  const rev = revOf(id);
  const pending = queued.get(id);
  if (pending && pending.rev === rev) return pending.promise;
  const entry = { rev, promise: null };
  entry.promise = chain.then(() => doSave(id)).then((ok) => {
    // Échec : l'état n'est plus en file, un nouveau copier ou un nouveau blur peut réessayer.
    if (!ok && queued.get(id) === entry) queued.delete(id);
    return ok;
  });
  queued.set(id, entry);
  chain = entry.promise.catch(() => false);
  return entry.promise;
}

/**
 * Envoie l'état courant du billet. La réponse du serveur ne s'applique que si le billet n'a pas été modifié entre-temps :
 * sinon la modification locale est plus récente, et le PUT suivant (déjà en file) l'enverra.
 */
async function doSave(id) {
  const inv = find(id);
  if (!inv || inv.state !== 'free' || isRevoked(inv) || personalisationOff) return true;
  const rev = revOf(id);
  const message = messageOf(inv).slice(0, MESSAGE_MAX);
  const picks = picksOf(inv);
  try {
    const srv = await updateInvite(id, { message, picks });
    if (revOf(id) === rev) {
      if (srv && typeof srv === 'object') {
        patch({ id, message: typeof srv.message === 'string' ? srv.message : message, picks: Array.isArray(srv.picks) ? picksOf(srv) : picks });
      }
      drafts.delete(id);
    }
    return true;
  } catch (err) {
    // Serveur ancien : pas de personnalisation, le billet reste copiable tel quel.
    if (err instanceof UserApiError && (err.status === 404 || err.status === 405)) {
      personalisationOff = true;
      paint();
      return true;
    }
    toast('Billet non enregistré : réessaie');
    if (revOf(id) === rev) await reloadTicket(id);
    return false;
  }
}

/** Après un échec, le billet reprend l'état du serveur (pas d'ancien tableau de coups de cœur rétabli). Une modification plus récente l'emporte. */
async function reloadTicket(id) {
  const rev = revOf(id);
  let fresh;
  try {
    fresh = await getInvites();
  } catch {
    return;
  }
  if (revOf(id) !== rev || !data || data === 'error' || !fresh || !Array.isArray(fresh.invites)) return;
  const server = fresh.invites.find((i) => i.id === id);
  if (!server) return;
  data.invites = data.invites.map((i) => (i.id === id ? server : i));
  paint();
}

/** Avant de copier ou partager : le mot tapé est enregistré, pour que le filleul voie ce qu'on a écrit. */
async function flush(id) {
  if (personalisationOff) return true;
  const inv = find(id);
  if (inv && dirty(inv)) return saveDraft(id);
  await chain;
  return true;
}

async function copyTicket(id) {
  if (!(await flush(id))) return false;
  return copyInvite(id);
}

async function shareTicket(id) {
  if (!(await flush(id))) return false;
  return shareInvite(id);
}

/** Choisit un billet (son panneau s'ouvre) ; choisi à nouveau, il se referme. Un billet révoqué ne s'ouvre pas. */
function selectTicket(id) {
  const inv = find(id);
  if (!inv || isRevoked(inv)) return;
  if (id === selectedId) { closePanel(); return; }
  selectedId = id;
  paint('ticket:' + id);
}

/** Ferme le panneau ou la feuille du bas ; le mot tapé est enregistré et le focus revient au billet. */
function closePanel() {
  const id = selectedId;
  if (id == null) return;
  const inv = find(id);
  if (inv && !personalisationOff && dirty(inv)) saveDraft(id).catch(() => {});
  selectedId = null;
  paint('ticket:' + id);
}

/** Tab reste dans la feuille du bas (fenêtre modale). */
function trapTab(e, sheet) {
  const items = Array.from(sheet.querySelectorAll('button:not([disabled]), textarea, input, [href]'));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function setPickStatus(text) {
  const el = detailEl.querySelector('#tk-pick-status');
  if (el) el.textContent = text;
}

/** Ajoute ou retire un coup de cœur du billet ouvert ; au-delà de 3, le choix est refusé sans appel réseau. */
async function togglePick(key) {
  const inv = find(selectedId);
  if (!inv || inv.state !== 'free' || isRevoked(inv) || personalisationOff) return;
  const id = inv.id;
  const picks = picksOf(inv);
  let next;
  if (picks.some((p) => pickKey(p) === key)) {
    next = picks.filter((p) => pickKey(p) !== key);
  } else {
    if (picks.length >= PICKS_MAX) {
      setPickStatus('Trois coups de cœur au maximum : retire-en un pour en choisir un autre.');
      return;
    }
    const option = pickOptions(picks).find((o) => o.key === key);
    if (!option) return;
    next = picks.concat([toPick(option)]);
  }
  bump(id);
  patch({ id, picks: next });
  paint('pick:' + key);
  // Échec : doSave recharge l'état du serveur ; l'ancien tableau n'est pas rétabli ici.
  await saveDraft(id);
}

detailEl.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest('[data-tk-fold]')) { toggleCard(); return; }
  if (t.closest('[data-tk-close]')) { closePanel(); return; }
  const sel = t.closest('[data-tk-sel]');
  if (sel) { selectTicket(sel.dataset.tkSel); return; }
  const pick = t.closest('[data-tk-pick]');
  if (pick) { await togglePick(pick.dataset.tkPick); return; }
  if (busy) return;
  const run = async (fn) => { busy = true; try { await fn(); } finally { busy = false; } };
  const copy = t.closest('[data-tk-copy]');
  if (copy) { e.preventDefault(); await run(() => copyTicket(copy.dataset.tkCopy)); return; }
  const share = t.closest('[data-tk-share]');
  if (share) { e.preventDefault(); await run(() => shareTicket(share.dataset.tkShare)); return; }
  const rev = t.closest('[data-tk-revoke]');
  if (rev) {
    e.preventDefault();
    if (!window.confirm('Annuler ce billet ? Son lien cessera de fonctionner et le billet redevient libre.')) return;
    await run(() => revokeOne(rev.dataset.tkRevoke));
    return;
  }
  if (t.closest('[data-inv-reload]')) { e.preventDefault(); data = null; paint(); refreshInvites(); }
});

detailEl.addEventListener('input', (e) => {
  const field = e.target instanceof HTMLTextAreaElement && e.target.dataset.tkMsg ? e.target : null;
  if (!field) return;
  if (field.value.length > MESSAGE_MAX) field.value = field.value.slice(0, MESSAGE_MAX);
  bump(field.dataset.tkMsg);
  drafts.set(field.dataset.tkMsg, field.value);
  const count = field.parentElement && field.parentElement.querySelector('.tk-count');
  if (count) count.textContent = field.value.length + ' / ' + MESSAGE_MAX;
});

detailEl.addEventListener('change', (e) => {
  const field = e.target instanceof HTMLTextAreaElement && e.target.dataset.tkMsg ? e.target : null;
  if (!field) return;
  const inv = find(field.dataset.tkMsg);
  if (inv && dirty(inv)) saveDraft(inv.id).catch(() => {});
});

const ROW_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

/** Clavier : Échap ferme le panneau ou la feuille, Tab reste dans la feuille, flèches (Début, Fin) dans la rangée de billets. */
detailEl.addEventListener('keydown', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const slot = t && t.closest('#inv-slot');
  if (!slot) return;
  if (e.key === 'Escape' && cardOpen && selectedId != null) {
    // Avant la navigation globale (events.js), qui reviendrait à la page précédente.
    e.preventDefault();
    e.stopPropagation();
    closePanel();
    return;
  }
  const sheet = t.closest('[data-tk-sheet]');
  if (e.key === 'Tab' && sheet) { trapTab(e, sheet); return; }
  if (!ROW_KEYS.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey || !t.matches('[data-tk-ticket]')) return;
  const all = Array.from(slot.querySelectorAll('[data-tk-ticket]'));
  const i = all.indexOf(t);
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : i + (e.key === 'ArrowRight' ? 1 : -1);
  e.preventDefault();
  e.stopPropagation();
  const next = all[Math.max(0, Math.min(all.length - 1, j))];
  if (next && next !== t) next.focus();
});

/** Défilement du carrousel : points de position et pointe du panneau suivent (une fois par image). */
let scrollFrame = 0;
detailEl.addEventListener('scroll', (e) => {
  const row = e.target instanceof Element && e.target.matches('[data-tk-row]') ? e.target : null;
  if (!row || scrollFrame) return;
  const run = () => {
    scrollFrame = 0;
    const slot = row.closest('#inv-slot');
    if (!slot) return;
    syncDots(slot, row);
    placePointer(slot);
  };
  if (typeof requestAnimationFrame === 'function') scrollFrame = requestAnimationFrame(run);
  else run();
}, { capture: true, passive: true });

/** Redimensionnement : la pointe se recale ; en passant le seuil mobile, le composeur bascule entre panneau et feuille du bas. */
if (typeof window.matchMedia === 'function') {
  const mq = window.matchMedia(SHEET_MQ);
  const onChange = () => { if (selectedId != null) paint(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
}
window.addEventListener('resize', () => {
  const slot = detailEl.querySelector('#inv-slot');
  if (slot) placePointer(slot);
}, { passive: true });

detailEl.addEventListener('submit', (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-inv-quota]') : null;
  if (!f) return;
  e.preventDefault();
  applyQuota(f.elements.user.value, Number(f.elements.quota.value));
});
