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

/** Coup de cœur normalisé pour l'API : identifiant, type tel quel, nom, affiche et fond en https ou null. */
const toPick = (p) => ({ id: p.id, type: p.type, name: String(p.name), poster: httpsUrl(p.poster), background: httpsUrl(p.background) });
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

/** Affiches du composeur : les plus récentes de la bibliothèque, puis les coups de cœur déjà choisis qui n'y figurent pas. */
function pickOptions(picks) {
  const lib = userStore.getLibrary().slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, PICK_GRID_MAX).map(libraryPick);
  const shown = new Set(lib.map((o) => o.key));
  return lib.concat(picks.filter((p) => !shown.has(pickKey(p))).map((p) => ({ ...p, key: pickKey(p) })));
}

/** État visuel d'un billet : libellés et classe de couleur. */
function ticketView(inv, index) {
  const num = ticketNumber(inv, index);
  if (isRevoked(inv)) return { kind: 'revoked', num, head: 'Révoqué', sub: 'Par l’administrateur', stub: 'Révoqué' };
  if (inv.state === 'used') {
    const since = shortDate(inv.usedAt);
    return { kind: 'used', num, head: inv.invitee || 'Compte supprimé', sub: since ? 'Validé le ' + since : 'Validé', stub: 'Validé' };
  }
  if (inv.state === 'sent') {
    const exp = expiryText(inv.expiresAt);
    return { kind: 'sent', num, head: 'En attente', sub: 'Envoyé' + (exp ? ' · ' + exp : ''), stub: 'En route' };
  }
  return { kind: 'free', num, head: 'Offrir ce billet', sub: 'Une place pour un ami', stub: 'Admis' };
}

function ticketHTML(inv, index, selected, deal) {
  const v = ticketView(inv, index);
  const id = esc(inv.id);
  return '<button type="button" class="tk-ticket tk-is-' + v.kind + (deal ? ' tk-deal' : '') + '" data-tk-sel="' + id + '" data-tk-focus="ticket:' + id + '"' +
    ' aria-pressed="' + (selected ? 'true' : 'false') + '" aria-label="' + esc('Billet ' + v.num + ' : ' + v.head) + '">' +
    '<span class="tk-main"><span class="tk-num">Billet N° ' + esc(v.num) + '</span><span class="tk-head">' + esc(v.head) + '</span>' +
    '<span class="tk-sub">' + esc(v.sub) + '</span></span>' +
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

/** Composeur d'un billet libre : mot (à gauche), coups de cœur (à droite), copier ou partager. */
function composerHTML(inv, index) {
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
  return '<section class="tk-compose" aria-labelledby="tk-compose-t">' +
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
function panelHTML(inv, index) {
  const id = esc(inv.id);
  if (isRevoked(inv)) {
    return '<section class="tk-panel tk-panel-revoked" aria-live="polite"><div class="tk-panel-b">' +
      '<p class="tk-panel-t">Révoqué par l’administrateur</p><p class="tk-panel-d">Ce billet ne peut plus être envoyé.</p></div></section>';
  }
  if (inv.state === 'free') return composerHTML(inv, index);
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

/** Billet ouvert : celui choisi, sinon le premier libre, sinon le premier billet. Met à jour `selectedId`. */
function currentSelection(list) {
  let sel = list.find((i) => i.id === selectedId);
  if (!sel) sel = list.find((i) => i.state === 'free' && !isRevoked(i)) || list.find((i) => !isRevoked(i)) || list[0];
  selectedId = sel ? sel.id : null;
  return sel || null;
}

function inviteTicketsHTML(list) {
  const deal = dealPending;
  dealPending = false;
  const sel = currentSelection(list);
  return '<div class="tk-grid" role="group" aria-label="Billets de parrainage">' +
    list.map((inv, n) => ticketHTML(inv, n, !!sel && inv.id === sel.id, deal)).join('') + '</div>' +
    (sel ? panelHTML(sel, list.indexOf(sel)) : '');
}

export function invitesBodyHTML(d) {
  if (d === null) return '<p class="set-hint" role="status">Chargement des billets…</p>';
  if (d === 'error') return '<p class="set-hint" role="alert">Billets indisponibles : le serveur ne répond pas. <button type="button" class="link-btn" data-inv-reload>Réessayer</button></p>';
  const list = d.invites;
  const used = list.filter((i) => i.state === 'used').length;
  const owner = auth.isOwner
    ? '<form class="inv-quota" data-inv-quota><label class="set-row-d" for="inv-q-user">Quota d’un compte (propriétaire du serveur)</label>' +
      '<span class="inv-quota-f"><input class="set-input set-input-sm" id="inv-q-user" name="user" type="text" placeholder="pseudo" value="' + esc(auth.username) + '" autocapitalize="none" required>' +
      '<input class="set-input set-input-sm" name="quota" type="number" min="0" max="100" value="' + d.quota + '" aria-label="Nombre de billets" required>' +
      '<button type="submit" class="btn btn-ghost btn-sm">Appliquer</button></span></form>'
    : '';
  const summary = list.length
    ? '<p class="set-hint">' + used + ' billet' + (used > 1 ? 's' : '') + ' validé' + (used > 1 ? 's' : '') + ' sur ' + list.length +
      '. Chaque billet ne sert qu’une fois. Ton filleul pourra devenir ton ami en un clic.</p>'
    : '<p class="set-hint">Aucun billet pour le moment.</p>';
  return summary + inviteTicketsHTML(list) + owner;
}

/** Carte du panneau « Profil et compte » ; le contenu se met à jour sans redessiner la page. */
export function invitesCard() {
  dealPending = true;
  // Chaque ouverture des réglages retente la personnalisation (le serveur a pu être mis à jour).
  personalisationOff = false;
  return card('Mes billets de parrainage', '<div id="inv-slot">' + invitesBodyHTML(data) + '</div>', {
    desc: 'Invite tes proches avec un billet personnel : un mot et trois coups de cœur.',
    attrs: 'data-tk-card',
  });
}

/** Redessine le panneau. `focus` (valeur de `data-tk-focus`) rend le focus à cet élément ; sans valeur, le focus déjà dans le panneau est gardé. */
function paint(focus) {
  const slot = detailEl.querySelector('#inv-slot');
  if (!slot) return;
  const active = slot.contains(document.activeElement) ? document.activeElement.dataset.tkFocus : undefined;
  slot.innerHTML = invitesBodyHTML(data);
  const target = focus || active;
  if (target) {
    const el = Array.from(slot.querySelectorAll('[data-tk-focus]')).find((n) => n.dataset.tkFocus === target);
    if (el) el.focus({ preventScroll: true });
  }
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

function selectTicket(id) {
  if (id === selectedId || !find(id)) return;
  selectedId = id;
  paint('ticket:' + id);
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
  if (inv && dirty(inv)) saveDraft(inv.id);
});

detailEl.addEventListener('submit', (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-inv-quota]') : null;
  if (!f) return;
  e.preventDefault();
  applyQuota(f.elements.user.value, Number(f.elements.quota.value));
});
