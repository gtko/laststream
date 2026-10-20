/* Tableau de bord « Mes invitations » (Réglages > Profil et compte) : les liens de parrainage du compte, avec leur état
 * (libre, envoyé, utilisé par …), copie, partage et révocation. Le propriétaire du serveur peut régler le quota d'un compte. */
import { auth } from '../data/auth';
import { shareBase } from '../data/shareBase';
import { inviteLink } from '../data/invite';
import { getInvites, markInviteSent, revokeInvite, setInviteQuota } from '../data/socialApi';
import { UserApiError } from '../data/userApi';
import { card } from './settings-ui.js';
import { detailEl, toast } from './dom.js';
import { esc } from './util.js';

/** État affiché : `null` avant le premier chargement, `'error'` si le serveur ne répond pas. */
let data = null;
let busy = false;

/** Adresse des liens (voir data/shareBase.ts), réexportée pour les écrans qui importent les invitations. */
export { shareBase };

export const linkOf = (inv) => inviteLink(shareBase(), inv.code);

const STATE_LABEL = { free: 'Libre', sent: 'Envoyé', used: 'Utilisé', revoked: 'Révoqué' };
/** Révoqué par l'administrateur (état `revoked`, ou date `revokedAt` renseignée). */
const isRevoked = (inv) => inv.state === 'revoked' || !!inv.revokedAt;

export function inviteRowHTML(inv) {
  const used = inv.state === 'used';
  // Révoqué par l'administrateur : ni lien, ni copie, ni partage, ni régénération.
  const revoked = isRevoked(inv);
  const who = used ? (inv.invitee ? 'par ' + esc(inv.invitee) : '(compte supprimé)') : '';
  let link;
  if (used) link = '<span class="inv-link is-used">Lien consommé</span>';
  else if (revoked) link = '<span class="inv-link is-revoked">Révoqué par l\'administrateur</span>';
  else link = '<input class="set-input inv-link" type="text" readonly value="' + esc(linkOf(inv)) + '" aria-label="Lien d’invitation" data-inv-input>';
  const actions = used || revoked ? '' : '<span class="inv-btns"><button type="button" class="btn btn-ghost btn-sm" data-inv-copy="' + esc(inv.id) + '">Copier</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-inv-share="' + esc(inv.id) + '">Partager</button>' +
    (inv.state === 'sent' ? '<button type="button" class="btn btn-ghost btn-sm" data-inv-unsent="' + esc(inv.id) + '">Remettre en libre</button>' : '') +
    '<button type="button" class="btn btn-ghost btn-sm" data-inv-revoke="' + esc(inv.id) + '">Révoquer</button></span>';
  return '<li class="inv-row is-' + inv.state + '" data-inv-row="' + esc(inv.id) + '">' +
    '<span class="inv-state">' + STATE_LABEL[inv.state] + (who ? ' <em>' + who + '</em>' : '') + '</span>' +
    link + actions + '</li>';
}

export function invitesBodyHTML(d) {
  if (d === null) return '<p class="set-hint" role="status">Chargement des invitations…</p>';
  if (d === 'error') return '<p class="set-hint" role="alert">Invitations indisponibles : le serveur ne répond pas. <button type="button" class="link-btn" data-inv-reload>Réessayer</button></p>';
  const used = d.invites.filter((i) => i.state === 'used').length;
  const owner = auth.isOwner
    ? '<form class="inv-quota" data-inv-quota><label class="set-row-d" for="inv-q-user">Quota d’un compte (propriétaire du serveur)</label>' +
      '<span class="inv-quota-f"><input class="set-input set-input-sm" id="inv-q-user" name="user" type="text" placeholder="pseudo" value="' + esc(auth.username) + '" autocapitalize="none" required>' +
      '<input class="set-input set-input-sm" name="quota" type="number" min="0" max="100" value="' + d.quota + '" aria-label="Nombre de liens" required>' +
      '<button type="submit" class="btn btn-ghost btn-sm">Appliquer</button></span></form>'
    : '';
  return '<p class="set-hint">' + used + ' sur ' + d.invites.length + ' lien' + (d.invites.length > 1 ? 's' : '') + ' utilisé' + (used > 1 ? 's' : '') +
    '. Chaque lien ne sert qu’une fois ; ton filleul devient automatiquement ton ami.</p>' +
    '<ul class="inv-list">' + d.invites.map(inviteRowHTML).join('') + '</ul>' + owner;
}

/** Carte du panneau « Profil et compte » ; le contenu se met à jour sans redessiner la page. */
export function invitesCard() {
  return card('Mes invitations', '<div id="inv-slot">' + invitesBodyHTML(data) + '</div>', { desc: 'Invite tes proches avec un lien de parrainage personnel.' });
}

function paint() {
  const slot = detailEl.querySelector('#inv-slot');
  if (slot) slot.innerHTML = invitesBodyHTML(data);
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
  const input = detailEl.querySelector('[data-inv-input]');
  if (input) { input.select(); try { return document.execCommand('copy'); } catch { return false; } }
  return false;
}

async function markSent(inv) {
  if (inv.state !== 'free') return;
  try {
    await markInviteSent(inv.id, true);
    patch({ id: inv.id, state: 'sent', sentAt: new Date().toISOString() });
    paint();
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
    data.invites = data.invites.map((i) => (i.id === id ? res.invite : i));
    paint();
    toast('Lien révoqué : un nouveau lien est disponible');
    return true;
  } catch (err) {
    const code = err instanceof UserApiError ? err.code : '';
    if (code === 'invite_revoked') toast('Ce lien a été révoqué par l’administrateur : il ne peut plus être régénéré.');
    else toast(code === 'invite_used' ? 'Ce lien est déjà utilisé' : 'Révocation impossible');
    if (code === 'invite_used' || code === 'invite_revoked') refreshInvites();
    return false;
  }
}

async function unsend(id) {
  try {
    await markInviteSent(id, false);
    patch({ id, state: 'free', sentAt: null });
    paint();
  } catch { toast('Action impossible'); }
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

detailEl.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || busy) return;
  const run = async (fn) => { busy = true; try { await fn(); } finally { busy = false; } };
  const copy = t.closest('[data-inv-copy]');
  if (copy) { e.preventDefault(); await run(() => copyInvite(copy.dataset.invCopy)); return; }
  const share = t.closest('[data-inv-share]');
  if (share) { e.preventDefault(); await run(() => shareInvite(share.dataset.invShare)); return; }
  const rev = t.closest('[data-inv-revoke]');
  if (rev) {
    e.preventDefault();
    if (!window.confirm('Révoquer ce lien ? L’ancien lien cessera de fonctionner et un nouveau sera créé.')) return;
    await run(() => revokeOne(rev.dataset.invRevoke));
    return;
  }
  const un = t.closest('[data-inv-unsent]');
  if (un) { e.preventDefault(); await run(() => unsend(un.dataset.invUnsent)); return; }
  if (t.closest('[data-inv-reload]')) { e.preventDefault(); data = null; paint(); refreshInvites(); }
});

detailEl.addEventListener('submit', (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-inv-quota]') : null;
  if (!f) return;
  e.preventDefault();
  applyQuota(f.elements.user.value, Number(f.elements.quota.value));
});
