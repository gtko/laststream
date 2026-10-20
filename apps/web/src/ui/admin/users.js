/* Espace Utilisateurs : comptes (recherche, pagination, fiche avec actions), invitations et parrainages (arbre), en ligne (à venir).
 * La fiche d’un compte s’ouvre dans un panneau latéral. Ses actions destructrices passent par une confirmation (et le mot de passe
 * si l’élévation manque, cf. adminApi.js). */
import * as api from '../../data/adminApi';
import { countDescendants, fmtAgo, fmtDateTime, fmtDay, fmtInt, treeDepth } from '../../data/adminModel';
import { confirmDialog, openLayer } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { shareBase } from '../invites.js';
import { esc } from '../util.js';
import { admCard, adminErr, attempt, badge, bindPager, empty, loaded, pager, sectionHead, soonCard, soonPage, statusBadge, table } from './common.js';

// ---------- Comptes : liste ----------
export function accountsHTML(S) {
  const q = S.accQuery;
  const bar = '<form class="adm-toolbar" data-adm-accsearch role="search" data-nav>' +
    '<label class="adm-field adm-grow"><span class="sr-only">Rechercher un pseudo</span><input class="set-input" type="search" name="q" value="' + esc(q.q) + '" placeholder="Rechercher un pseudo" autocomplete="off" autocapitalize="none"></label>' +
    '<label class="adm-field"><span class="sr-only">Statut</span><select class="set-input" name="status"><option value="">Tous les statuts</option><option value="active"' + (q.status === 'active' ? ' selected' : '') + '>Actifs</option><option value="suspended"' + (q.status === 'suspended' ? ' selected' : '') + '>Suspendus</option></select></label>' +
    '<label class="adm-field"><span class="sr-only">Ordre</span><select class="set-input" name="order"><option value="newest"' + (q.order === 'newest' ? ' selected' : '') + '>Plus récents</option><option value="oldest"' + (q.order === 'oldest' ? ' selected' : '') + '>Plus anciens</option></select></label>' +
    '<button type="submit" class="btn btn-primary btn-sm">Rechercher</button></form>';
  return sectionHead('Comptes', 'Tous les comptes du serveur. Ouvre un compte pour agir dessus.') + bar +
    loaded(S.acc, (r) => {
      if (!r.accounts.length) return empty('Aucun compte ne correspond.');
      const rows = r.accounts.map((a) => ({
        cells: [
          '<button type="button" class="adm-link" data-adm-acc="' + esc(a.id) + '" data-nav>' + esc(a.username) + '</button>' + (a.isOwner ? ' ' + badge('Propriétaire') : ''),
          statusBadge(a.status), esc(fmtDay(a.createdAt)), a.referrer ? esc(a.referrer) : '—', esc(fmtAgo(a.lastActivityAt)),
          fmtInt(a.profileCount), fmtInt(a.libraryCount), fmtInt(a.invitesUsed) + ' / ' + fmtInt(a.inviteQuota),
        ],
      }));
      const p = S.accPager;
      return '<p class="adm-count" role="status">' + fmtInt(r.total) + ' compte' + (r.total > 1 ? 's' : '') + ' · page ' + p.page + '</p>' +
        table('Comptes', ['Pseudo', 'Statut', 'Créé le', 'Parrain', 'Dernière activité', { label: 'Profils', num: true }, { label: 'Bibliothèque', num: true }, { label: 'Invitations', num: true }], rows) +
        pager('acc', p.hasPrev, !!r.nextCursor);
    });
}

// ---------- Fiche d’un compte (panneau latéral) ----------
/** Contenu du panneau latéral d’un compte. `link` : dernier lien de réinitialisation généré (affiché une seule fois). */
export function accountDetailHTML(d, link, busy) {
  const a = d.account;
  const owner = a.isOwner;
  const dis = busy ? ' disabled' : '';
  const list = (items, empty0, fn) => (items && items.length ? '<ul class="adm-mini">' + items.map(fn).join('') + '</ul>' : '<p class="set-hint">' + empty0 + '</p>');
  return '<div class="adm-detail" data-adm-detail="' + esc(a.id) + '">' +
    '<div class="adm-detail-top"><h3>' + esc(a.username) + '</h3>' + statusBadge(a.status) + (owner ? badge('Propriétaire') : '') + '</div>' +
    '<dl class="adm-dl"><div><dt>Créé le</dt><dd>' + esc(fmtDateTime(a.createdAt)) + '</dd></div><div><dt>Parrain</dt><dd>' + (a.referrer ? esc(a.referrer) : '—') + '</dd></div>' +
    '<div><dt>Dernière activité</dt><dd>' + esc(fmtAgo(a.lastActivityAt)) + '</dd></div>' +
    (a.suspendedAt ? '<div><dt>Suspendu le</dt><dd>' + esc(fmtDateTime(a.suspendedAt)) + '</dd></div>' : '') + '</dl>' +
    '<h4 class="adm-sub">Profils</h4>' + list(d.profiles, 'Aucun profil.', (p) => '<li>' + esc(p.name) + ((p.isKid ?? p.kid) ? ' ' + badge('Enfant') : '') + ((p.hasPin ?? p.pin) ? ' ' + badge('PIN') : '') +
      ' <span class="adm-dim">' + fmtInt(p.libraryCount ?? p.library ?? 0) + ' titre(s)</span></li>') +
    '<h4 class="adm-sub">Filleuls</h4>' + list(d.invitees, 'Aucun filleul.', (i) => '<li>' + esc(i.username) + (i.usedAt ? ' <span class="adm-dim">inscrit le ' + esc(fmtDay(i.usedAt)) + '</span>' : '') + '</li>') +
    '<h4 class="adm-sub">Sessions</h4>' + list(d.sessions, 'Aucune session ouverte.', (s) => '<li>' + esc(s.device || 'Appareil inconnu') + ' <span class="adm-dim">· créée le ' + esc(fmtDay(s.createdAt)) + ' · dernière activité ' + esc(fmtAgo(s.lastSeenAt)) + '</span></li>') +
    '<h4 class="adm-sub">Quota d’invitations</h4>' +
    '<form class="adm-inline" data-adm-quota="' + esc(a.id) + '"><label class="adm-field"><span class="sr-only">Quota de liens</span><input class="set-input set-input-sm" type="number" name="quota" min="0" max="100" value="' + esc(a.inviteQuota) + '" required></label>' +
    '<span class="adm-dim">' + fmtInt(a.invitesUsed) + ' utilisée(s)</span><button type="submit" class="btn btn-ghost btn-sm"' + dis + '>Enregistrer</button></form>' +
    '<h4 class="adm-sub">Actions</h4>' +
    (owner ? '<p class="set-hint">Le compte propriétaire ne peut être ni suspendu ni supprimé.</p>' : '') +
    '<div class="adm-actions">' +
    (a.status === 'suspended'
      ? '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="reactivate"' + dis + '>Réactiver le compte</button>'
      : '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="suspend"' + (owner ? ' disabled' : dis) + '>Suspendre</button>') +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="revoke"' + dis + '>Révoquer les sessions</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="reset"' + dis + '>Lien de réinitialisation</button>' +
    '<button type="button" class="btn btn-danger btn-sm" data-adm-do="delete"' + (owner ? ' disabled' : dis) + '>Supprimer le compte</button></div>' +
    (link ? '<div class="adm-linkbox" role="status"><p class="set-hint">Lien à usage unique, valable jusqu’au ' + esc(fmtDateTime(link.expiresAt)) + '. Il ne sera plus affiché : copie-le maintenant.</p>' +
      '<div class="adm-inline"><input class="set-input" type="text" readonly value="' + esc(link.url) + '" aria-label="Lien de réinitialisation" data-adm-linkval><button type="button" class="btn btn-primary btn-sm" data-adm-copy>Copier</button></div></div>' : '') +
    '<p class="set-msg" id="adm-detail-msg" role="status"></p></div>';
}

const ACCOUNT_ACTIONS = {
  suspend: (u) => ({ title: 'Suspendre ' + u, message: '<strong>' + esc(u) + '</strong> ne pourra plus se connecter et toutes ses sessions seront révoquées immédiatement. Tu pourras réactiver le compte.', confirmLabel: 'Suspendre', danger: true, run: api.suspendAccount, done: 'Compte suspendu.' }),
  reactivate: (u) => ({ run: api.reactivateAccount, done: 'Compte réactivé.', skipConfirm: true, u }),
  revoke: (u) => ({ title: 'Révoquer les sessions', message: 'Toutes les sessions de <strong>' + esc(u) + '</strong> seront fermées : il devra se reconnecter sur chaque appareil.', confirmLabel: 'Révoquer', danger: true, run: api.revokeSessions, done: 'Sessions révoquées.' }),
  reset: (u) => ({ title: 'Lien de réinitialisation', message: 'Générer un lien à usage unique (24 h) pour <strong>' + esc(u) + '</strong>. Un nouveau lien remplace le précédent. Le lien n’est montré qu’une fois.', confirmLabel: 'Générer le lien', danger: false, run: api.resetLink }),
  delete: (u) => ({ title: 'Supprimer ' + u, message: 'Le compte <strong>' + esc(u) + '</strong>, tous ses profils, sa bibliothèque et ses salons seront supprimés définitivement. Cette action est irréversible.', confirmLabel: 'Supprimer définitivement', danger: true, expect: u, run: api.deleteAccount, done: 'Compte supprimé.' }),
};

/** Fiche ouverte : { layer, id, detail, link (dernier lien généré), msg (message d’état), ctx (section d’origine) }. */
let cur = null;

function renderDetail(busy) {
  if (!cur || !cur.detail) return;
  cur.layer.setBody(accountDetailHTML(cur.detail, cur.link, busy));
  const m = cur.layer.el.querySelector('#adm-detail-msg');
  if (m) m.textContent = cur.msg || '';
}

/** Ouvre la fiche d’un compte ; `ctx` est celui de la section qui l’a demandée (rafraîchissement après action). */
async function openAccount(ctx, id) {
  const me = { layer: null, id, detail: null, link: null, msg: '', ctx };
  me.layer = openLayer({ title: 'Compte', variant: 'drawer', html: '<p class="adm-empty" role="status">Chargement…</p>', onClose: () => { if (cur === me) cur = null; } });
  cur = me;
  me.layer.el.addEventListener('click', onLayerClick);
  me.layer.el.addEventListener('submit', onLayerSubmit);
  try {
    const detail = await api.getAccount(id);
    if (cur !== me) return;
    me.detail = detail;
    me.layer.el.querySelector('.adm-sheet-h h2').textContent = detail.account.username;
    renderDetail(false);
  } catch (err) {
    if (cur !== me) return;
    me.layer.setBody('<div class="adm-error" role="alert"><span>' + esc(adminErr(err)) + '</span></div>');
  }
}

async function refreshAfterAccountChange() {
  const me = cur;
  if (!me) return;
  try { me.detail = await api.getAccount(me.id); } catch (_) { /* conservé */ }
  if (cur !== me) return;
  renderDetail(false);
  me.ctx.refresh(true);
}

async function accountAction(kind) {
  const me = cur;
  if (!me || !me.detail) return;
  const { id } = me;
  const u = me.detail.account.username;
  const spec = ACCOUNT_ACTIONS[kind](u);
  if (!spec.skipConfirm && !(await confirmDialog(spec))) return;
  me.msg = '';
  renderDetail(true);
  let result;
  const say = (t) => { if (cur === me) me.msg = t; };
  const ok = await attempt(async () => { result = await spec.run(id); }, say);
  if (cur !== me) return;
  if (ok && kind === 'reset') {
    me.link = { expiresAt: result.expiresAt, url: shareBase() + '/#/reset/' + encodeURIComponent(result.token) };
    me.msg = 'Lien généré.';
  } else if (ok) me.msg = spec.done;
  if (ok && kind === 'delete') {
    cur = null;
    me.layer.close();
    toast(spec.done);
    me.ctx.refresh(true);
    return;
  }
  await refreshAfterAccountChange();
}

async function copyText(text, input) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* repli ci-dessous */ }
  }
  if (input) { input.select(); try { return document.execCommand('copy'); } catch (_) { return false; } }
  return false;
}

async function copyLink() {
  const input = cur ? cur.layer.el.querySelector('[data-adm-linkval]') : null;
  const ok = input ? await copyText(input.value, input) : false;
  toast(ok ? 'Lien copié' : 'Copie impossible : sélectionne le lien à la main');
}

function onLayerClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !cur) return;
  const d = t.closest('[data-adm-do]');
  if (d) { e.preventDefault(); accountAction(d.dataset.admDo); return; }
  if (t.closest('[data-adm-copy]')) copyLink();
}

async function onLayerSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !f.matches('[data-adm-quota]')) return;
  e.preventDefault();
  const me = cur;
  if (!me || !me.detail) return;
  const quota = Number(f.elements.quota.value);
  if (!Number.isInteger(quota) || quota < 0 || quota > 100) { me.msg = 'Le quota va de 0 à 100.'; renderDetail(false); return; }
  renderDetail(true);
  const say = (t) => { if (cur === me) me.msg = t; };
  if (await attempt(() => api.setInviteQuota(me.id, quota), say)) me.msg = 'Quota enregistré.';
  await refreshAfterAccountChange();
}

// ---------- Liaisons ----------
function bindOpenAccount(root, ctx) {
  root.querySelectorAll('[data-adm-acc]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openAccount(ctx, b.dataset.admAcc); }));
}

function bindAccounts(root, ctx) {
  const form = root.querySelector('[data-adm-accsearch]');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ctx.S.accQuery = { q: form.elements.q.value.trim(), status: form.elements.status.value, order: form.elements.order.value };
      ctx.S.accPager.reset();
      ctx.refresh(false);
    });
  }
  bindOpenAccount(root, ctx);
  bindPager(root, (which, dir) => {
    if (which !== 'acc') return;
    const data = ctx.S.acc.value;
    if (dir === 'next') { if (!ctx.S.accPager.next(data && data.nextCursor)) return; } else if (!ctx.S.accPager.prev()) return;
    ctx.refresh(false);
  });
}

// ---------- Invitations et parrainages (arbre) ----------
function nodeHTML(n) {
  const kids = n.children || [];
  const n2 = countDescendants(n);
  const head = '<span class="adm-node"><button type="button" class="adm-link" data-adm-acc="' + esc(n.id) + '" data-nav>' + esc(n.username) + '</button>' +
    (n.status === 'suspended' ? ' ' + badge('Suspendu', 'warn') : '') + ' <span class="adm-dim">' + esc(fmtDay(n.createdAt)) + (n2 ? ' · ' + n2 + ' filleul' + (n2 > 1 ? 's' : '') : '') + '</span></span>';
  if (!kids.length) return '<li class="adm-leaf">' + head + '</li>';
  return '<li><details open><summary>' + head + '</summary><ul class="adm-tree">' + kids.map(nodeHTML).join('') + '</ul></details></li>';
}

export function invitesHTML(S) {
  return sectionHead('Invitations et parrainages', 'Qui a invité qui. Les branches se replient.') +
    loaded(S.ref, (r) => (!r.roots.length ? empty('Aucun compte.') : admCard('Arbre de parrainage',
      '<p class="adm-count" role="status">' + fmtInt(r.total) + ' compte' + (r.total > 1 ? 's' : '') + ' · profondeur ' + treeDepth(r.roots) + (r.truncated ? ' · arbre tronqué par le serveur' : '') + '</p>' +
      '<ul class="adm-tree is-root" aria-label="Arbre de parrainage">' + r.roots.map(nodeHTML).join('') + '</ul>'))) +
    soonCard('Liste des invitations', 'Bientôt disponible : liens émis, utilisés, expirés et révoqués.');
}

export const usersSections = [
  {
    id: 'accounts', group: 'users', label: 'Comptes', icon: 'users', render: accountsHTML, bind: bindAccounts,
    load: (ctx, quiet) => ctx.fetch('acc', () => api.listAccounts({ ...ctx.S.accQuery, limit: 25, cursor: ctx.S.accPager.cursor }), quiet),
  },
  {
    id: 'invites', group: 'users', label: 'Invitations et parrainages', icon: 'tree', render: invitesHTML, bind: bindOpenAccount,
    load: (ctx, quiet) => ctx.fetch('ref', () => api.getReferrals(), quiet),
  },
  { id: 'online', group: 'users', label: 'En ligne', icon: 'online', render: () => soonPage('En ligne', 'Qui est connecté maintenant et ce qu’il regarde.') },
];
