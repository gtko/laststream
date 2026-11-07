/* Espace Utilisateurs : comptes (filtres avec compteurs, recherche, sélection et actions groupées, export CSV), invitations et
 * parrainages (arbre et liste des liens révocables), en ligne (présence actualisée toutes les 30 s quand l'onglet est visible).
 * La fiche d'un compte s'ouvre dans un panneau latéral (account-drawer.js). */
import '../../styles/admin-users.css';
import * as api from '../../data/adminApi';
import { pad2 } from '../../data/format';
import { countDescendants, csvOfAccounts, fmtAgo, fmtDay, fmtInt, treeDepth } from '../../data/adminModel';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { esc } from '../util.js';
import { admCard, attempt, badge, bindPager, empty, loaded, pager, sectionHead, statusBadge, table } from './common.js';
import { avatarHTML, openAccount } from './account-drawer.js';

const ACCOUNT_PAGE = 25;
const ACCOUNT_FILTERS = [['all', 'Tous'], ['online', 'En ligne'], ['inactive30', 'Inactifs 30 j'], ['suspended', 'Suspendus'], ['noInvites', 'Sans invitation']];
const ACCOUNT_FILTER_HINT = { noInvites: 'Comptes sans lien d’invitation restant' };
const INVITE_FILTERS = [['', 'Tous'], ['active', 'Actifs'], ['used', 'Utilisés'], ['expired', 'Expirés'], ['revoked', 'Révoqués']];
const INVITE_LABEL = { active: ['Actif', 'ok'], used: ['Utilisé'], expired: ['Expiré'], revoked: ['Révoqué', 'warn'] };
const BULK_LABEL = { quota: 'Quota mis à jour', 'revoke-sessions': 'Sessions révoquées', suspend: 'Comptes suspendus' };
const BULK_ERROR = { cannot_target_owner: 'propriétaire, non concerné', not_found: 'introuvable' };
const ONLINE_MS = 30_000;

/** Un envoi groupé est en cours : les boutons de la barre restent inactifs. */
let bulkBusy = false;
let onlineTimer = 0;

const plural = (n, word) => fmtInt(n) + ' ' + word + (n > 1 ? 's' : '');
const accountsOf = (S) => (S.acc.status === 'ready' && S.acc.value ? S.acc.value.accounts : []);
const nameOf = (S, id) => {
  const a = accountsOf(S).find((x) => x.id === id);
  return a ? a.username : id;
};

// ---------- Comptes : liste ----------
function filtersHTML(S) {
  const counts = S.acc.status === 'ready' && S.acc.value ? S.acc.value.counts : null;
  return '<div class="adm-chips" role="group" aria-label="Filtrer les comptes">' + ACCOUNT_FILTERS.map(([v, l]) => {
    const n = counts && counts[v] != null ? ' <span class="adm-chip-n">' + fmtInt(counts[v]) + '</span>' : '';
    return '<button type="button" class="adm-chip" aria-pressed="' + (S.accQuery.filter === v ? 'true' : 'false') + '"' +
      (ACCOUNT_FILTER_HINT[v] ? ' title="' + esc(ACCOUNT_FILTER_HINT[v]) + '"' : '') + ' data-adm-filter="' + v + '" data-adm-focus="filter:' + v + '">' + esc(l) + n + '</button>';
  }).join('') + '</div>';
}

function searchHTML(q) {
  return '<form class="adm-toolbar" data-adm-accsearch role="search" data-nav>' +
    '<label class="adm-field adm-grow"><span class="sr-only">Rechercher un pseudo</span><input class="set-input" type="search" name="q" value="' + esc(q.q) + '" placeholder="Rechercher un pseudo" autocomplete="off" autocapitalize="none" data-adm-focus="acc:q"></label>' +
    '<label class="adm-field"><span class="sr-only">Statut</span><select class="set-input" name="status" data-adm-focus="acc:status"><option value="">Tous les statuts</option><option value="active"' + (q.status === 'active' ? ' selected' : '') + '>Actifs</option><option value="suspended"' + (q.status === 'suspended' ? ' selected' : '') + '>Suspendus</option></select></label>' +
    '<label class="adm-field"><span class="sr-only">Ordre</span><select class="set-input" name="order" data-adm-focus="acc:order"><option value="newest"' + (q.order === 'newest' ? ' selected' : '') + '>Plus récents</option><option value="oldest"' + (q.order === 'oldest' ? ' selected' : '') + '>Plus anciens</option></select></label>' +
    '<button type="submit" class="btn btn-primary btn-sm">Rechercher</button></form>';
}

/** Barre d'actions groupées, visible dès qu'un compte est coché. */
function bulkBarHTML(n) {
  if (!n) return '';
  const dis = bulkBusy ? ' disabled' : '';
  return '<div class="adm-bulk" role="region" aria-label="Actions groupées">' +
    '<span class="adm-bulk-n" aria-live="polite">' + plural(n, 'sélectionné') + '</span>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-bulk="quota" data-delta="1"' + dis + '>+1 invitation</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-bulk="quota" data-delta="-1"' + dis + '>−1 invitation</button>' +
    '<form class="adm-inline adm-bulk-quota" data-adm-bulk-quota><label class="adm-field">Quota<input class="set-input set-input-sm" type="number" name="quota" min="0" max="100" step="1" required data-adm-focus="bulk:quota"' + dis + '></label>' +
    '<button type="submit" class="btn btn-ghost btn-sm"' + dis + '>Définir</button></form>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-bulk="revoke-sessions"' + dis + '>Révoquer les sessions</button>' +
    '<button type="button" class="btn btn-danger btn-sm" data-adm-bulk="suspend"' + dis + '>Suspendre</button>' +
    '<button type="button" class="btn btn-ghost btn-sm adm-bulk-clear" data-adm-bulk-clear' + dis + '>Désélectionner</button></div>';
}

function accountsTable(accounts, sel) {
  const allOn = accounts.every((a) => sel.has(a.id));
  const head = '<tr><th scope="col" class="adm-sel"><input type="checkbox" data-adm-selall data-adm-focus="selall" aria-label="Tout sélectionner"' + (allOn ? ' checked' : '') + '></th>' +
    '<th scope="col">Compte</th><th scope="col">Statut</th><th scope="col">Dernière activité</th><th scope="col">Parrain</th>' +
    '<th scope="col" class="is-num">Invitations</th><th scope="col" class="is-num">Sessions</th></tr>';
  const rows = accounts.map((a, i) => {
    const on = sel.has(a.id);
    return '<tr data-adm-row="' + esc(a.id) + '"' + (on ? ' class="is-selected"' : '') + '>' +
      '<td class="adm-sel" data-label="Sélection"><input type="checkbox" data-adm-sel="' + esc(a.id) + '" data-adm-focus="sel:' + esc(a.id) + '" aria-label="Sélectionner ' + esc(a.username) + '"' + (on ? ' checked' : '') + '></td>' +
      '<td data-label="Compte"><span class="adm-who">' + avatarHTML(a.username, false) + '<span><button type="button" class="adm-link" data-adm-acc="' + esc(a.id) + '">' + esc(a.username) + '</button>' +
      (a.isOwner ? ' ' + badge('Propriétaire') : '') + ' <span class="adm-dim">· ' + plural(a.profileCount, 'profil') + '</span></span></span></td>' +
      '<td data-label="Statut">' + statusBadge(a.status) + '</td>' +
      '<td data-label="Dernière activité">' + (a.online ? '<span class="adm-online"><span class="adm-online-dot" aria-hidden="true"></span>en ligne</span>' : esc(fmtAgo(a.lastActivityAt))) + '</td>' +
      '<td data-label="Parrain">' + (a.referrer ? esc(a.referrer) : '—') + '</td>' +
      '<td data-label="Invitations" class="is-num">' + fmtInt(a.invitesUsed) + ' / ' + fmtInt(a.inviteQuota) + '</td>' +
      '<td data-label="Sessions" class="is-num">' + fmtInt(a.sessionCount) + '</td></tr>';
  }).join('');
  return '<div class="adm-table-wrap adm-accounts" role="region" aria-label="Comptes" tabindex="0"><table class="adm-table"><caption class="sr-only">Comptes</caption>' +
    '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
}

function accountsHTML(S) {
  const q = S.accQuery;
  const sel = S.accSel;
  return sectionHead('Comptes', 'Tous les comptes du serveur. Clique une ligne pour ouvrir la fiche ; coche plusieurs comptes pour agir en lot.',
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-export>Exporter CSV</button>') +
    filtersHTML(S) + searchHTML(q) + bulkBarHTML(sel.size) +
    loaded(S.acc, (r) => {
      if (!r.accounts.length) return empty('Aucun compte ne correspond.');
      const p = S.accPager;
      return '<p class="adm-count" role="status">' + fmtInt(r.total) + ' compte' + (r.total > 1 ? 's' : '') + ' · page ' + p.page + '</p>' +
        accountsTable(r.accounts, sel) + pager('acc', p.hasPrev, !!r.nextCursor);
    });
}

/** Télécharge un texte CSV (le BOM est déjà dans `text`) sous le nom donné. */
function downloadCsv(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const localDay = (d = new Date()) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

/** Export CSV des comptes du filtre et de la recherche courants (fichier laststream-comptes-AAAA-MM-JJ.csv, BOM UTF-8 pour Excel). */
async function exportCsv(ctx) {
  const q = ctx.S.accQuery;
  let r = null;
  const ok = await attempt(async () => { r = await api.exportAccounts({ filter: q.filter, q: q.q }); }, toast);
  if (!ok || !r) return;
  const n = r.accounts.length;
  downloadCsv('﻿' + csvOfAccounts(r.accounts), 'laststream-comptes-' + localDay() + '.csv');
  toast(r.truncated ? 'Export tronqué par le serveur : ' + fmtInt(n) + ' comptes exportés.' : fmtInt(n) + ' compte' + (n > 1 ? 's' : '') + ' exporté' + (n > 1 ? 's' : '') + '.', { ms: 3500 });
}

/**
 * Action groupée sur les comptes cochés. `body` : { action, delta | quota } ; `confirm(n)` donne la confirmation si l'action
 * est destructrice. Le résumé (faits / échecs) part en toast ; les comptes en échec restent cochés pour un nouvel essai.
 */
async function runBulk(ctx, body, confirm) {
  const S = ctx.S;
  const ids = Array.from(S.accSel);
  if (!ids.length || bulkBusy) return;
  if (confirm && !(await confirmDialog(confirm(ids.length)))) return;
  bulkBusy = true;
  ctx.paint();
  let res = null;
  const ok = await attempt(async () => { res = await api.bulkAccounts({ ids, ...body }); }, toast);
  bulkBusy = false;
  if (ok && res) {
    const failed = Array.isArray(res.failed) ? res.failed : [];
    const skipped = Array.isArray(res.skipped) ? res.skipped : [];
    const head = (BULK_LABEL[body.action] || 'Action') + ' : ' + fmtInt(res.done ?? 0) + ' sur ' + fmtInt(ids.length);
    const detail = failed.map((f) => nameOf(S, f.id) + ' (' + (BULK_ERROR[f.error] || 'erreur') + ')').join(', ');
    const skippedNote = skipped.length ? ' · ' + (skipped.length === 1 ? 'propriétaire ignoré' : fmtInt(skipped.length) + ' propriétaires ignorés') : '';
    const end = failed.length ? ' · ' + plural(failed.length, 'échec') + ' : ' + detail : '.';
    toast(head + skippedNote + end, { ms: failed.length || skipped.length ? 7000 : 3000 });
    S.accSel.clear();
    failed.forEach((f) => S.accSel.add(f.id));
    ctx.paint();
    ctx.refresh(true);
    return;
  }
  ctx.paint();
}

function bindSelection(root, ctx) {
  const S = ctx.S;
  root.querySelectorAll('[data-adm-sel]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) S.accSel.add(cb.dataset.admSel);
    else S.accSel.delete(cb.dataset.admSel);
    ctx.paint();
  }));
  const all = root.querySelector('[data-adm-selall]');
  if (!all) return;
  const rows = accountsOf(S);
  const on = rows.filter((a) => S.accSel.has(a.id)).length;
  all.indeterminate = on > 0 && on < rows.length;
  all.addEventListener('change', () => {
    rows.forEach((a) => { if (all.checked) S.accSel.add(a.id); else S.accSel.delete(a.id); });
    ctx.paint();
  });
}

function bindBulk(root, ctx) {
  const S = ctx.S;
  root.querySelectorAll('[data-adm-bulk]').forEach((b) => b.addEventListener('click', () => {
    const action = b.dataset.admBulk;
    if (action === 'quota') { runBulk(ctx, { action: 'quota', delta: Number(b.dataset.delta) }); return; }
    if (action === 'revoke-sessions') {
      runBulk(ctx, { action }, (n) => ({ title: 'Révoquer les sessions', message: 'Les sessions de ' + plural(n, 'compte') + ' seront fermées : chacun devra se reconnecter sur chaque appareil.', confirmLabel: 'Révoquer', danger: true }));
      return;
    }
    if (action === 'suspend') {
      runBulk(ctx, { action }, (n) => ({ title: 'Suspendre ' + plural(n, 'compte'), message: 'Les comptes sélectionnés ne pourront plus se connecter et leurs sessions seront révoquées immédiatement. Le propriétaire ne peut pas être suspendu.', confirmLabel: 'Suspendre', danger: true }));
    }
  }));
  const form = root.querySelector('[data-adm-bulk-quota]');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = Number(form.elements.quota.value);
      if (!Number.isInteger(v) || v < 0 || v > 100) { toast('Le quota va de 0 à 100.'); return; }
      runBulk(ctx, { action: 'quota', quota: v });
    });
  }
  const clear = root.querySelector('[data-adm-bulk-clear]');
  if (clear) clear.addEventListener('click', () => { S.accSel.clear(); ctx.paint(); });
}

function bindOpenAccount(root, ctx) {
  root.querySelectorAll('[data-adm-acc]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openAccount(ctx, b.dataset.admAcc); }));
}

function bindAccounts(root, ctx) {
  const S = ctx.S;
  const form = root.querySelector('[data-adm-accsearch]');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      S.accQuery = { ...S.accQuery, q: form.elements.q.value.trim(), status: form.elements.status.value, order: form.elements.order.value };
      S.accPager.reset();
      S.accSel.clear();
      ctx.refresh(false);
    });
  }
  root.querySelectorAll('[data-adm-filter]').forEach((b) => b.addEventListener('click', () => {
    S.accQuery = { ...S.accQuery, filter: b.dataset.admFilter };
    S.accPager.reset();
    S.accSel.clear();
    ctx.paint();
    ctx.refresh(true);
  }));
  const exp = root.querySelector('[data-adm-export]');
  if (exp) exp.addEventListener('click', () => exportCsv(ctx));
  bindSelection(root, ctx);
  bindBulk(root, ctx);
  bindOpenAccount(root, ctx);
  root.querySelectorAll('tr[data-adm-row]').forEach((tr) => tr.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('input, button, a, label')) return;
    openAccount(ctx, tr.dataset.admRow);
  }));
  bindPager(root, (which, dir) => {
    if (which !== 'acc') return;
    const data = S.acc.value;
    if (dir === 'next') { if (!S.accPager.next(data && data.nextCursor)) return; } else if (!S.accPager.prev()) return;
    S.accSel.clear();
    ctx.refresh(false);
  });
}

// ---------- Invitations et parrainages ----------
function nodeHTML(n) {
  const kids = n.children || [];
  const n2 = countDescendants(n);
  const head = '<span class="adm-node"><button type="button" class="adm-link" data-adm-acc="' + esc(n.id) + '" data-nav>' + esc(n.username) + '</button>' +
    (n.status === 'suspended' ? ' ' + badge('Suspendu', 'warn') : '') + ' <span class="adm-dim">' + esc(fmtDay(n.createdAt)) + (n2 ? ' · ' + n2 + ' filleul' + (n2 > 1 ? 's' : '') : '') + '</span></span>';
  if (!kids.length) return '<li class="adm-leaf">' + head + '</li>';
  return '<li><details open><summary>' + head + '</summary><ul class="adm-tree">' + kids.map(nodeHTML).join('') + '</ul></details></li>';
}

function invitesCardHTML(S) {
  const current = S.invStatus || '';
  const filters = '<div class="adm-chips" role="group" aria-label="Statut des liens">' + INVITE_FILTERS.map(([v, l]) =>
    '<button type="button" class="adm-chip" aria-pressed="' + (current === v ? 'true' : 'false') + '" data-adm-invstatus="' + v + '" data-adm-focus="inv:' + (v || 'all') + '">' + esc(l) + '</button>').join('') + '</div>';
  return admCard('Liens d’invitation', filters + loaded(S.inv, (r) => {
    if (!r.invites.length) return empty('Aucun lien dans ce filtre.');
    const rows = r.invites.map((i) => {
      const [label, kind] = INVITE_LABEL[i.status] || [i.status, ''];
      return {
        cells: [
          esc(i.ownerUsername),
          badge(label, kind),
          esc(fmtDay(i.createdAt)),
          i.expiresAt ? esc(fmtDay(i.expiresAt)) : 'jamais',
          i.usedBy ? esc(i.usedBy) + (i.usedAt ? ' · ' + esc(fmtDay(i.usedAt)) : '') : '—',
          i.status === 'active'
            ? '<button type="button" class="btn btn-danger btn-sm" data-adm-revoke="' + esc(i.id) + '" data-owner="' + esc(i.ownerUsername) + '" data-adm-focus="rev:' + esc(i.id) + '">Révoquer</button>'
            : '—',
        ],
      };
    });
    return '<p class="adm-count" role="status">' + plural(r.invites.length, 'lien') + '</p>' +
      table('Liens d’invitation', ['Émis par', 'Statut', 'Créé le', 'Expire le', 'Utilisé par', 'Action'], rows);
  }), { desc: 'Révoque un lien actif pour qu’il ne serve plus. Les comptes déjà inscrits ne sont pas touchés.' });
}

function invitesHTML(S) {
  return sectionHead('Invitations et parrainages', 'Qui a invité qui, et les liens d’invitation émis par chaque compte.') +
    loaded(S.ref, (r) => (!r.roots.length ? empty('Aucun compte.') : admCard('Arbre de parrainage',
      '<p class="adm-count" role="status">' + fmtInt(r.total) + ' compte' + (r.total > 1 ? 's' : '') + ' · profondeur ' + treeDepth(r.roots) + (r.truncated ? ' · arbre tronqué par le serveur' : '') + '</p>' +
      '<ul class="adm-tree is-root" aria-label="Arbre de parrainage">' + r.roots.map(nodeHTML).join('') + '</ul>'))) +
    invitesCardHTML(S);
}

async function revokeInvite(ctx, id, owner) {
  if (!(await confirmDialog({ title: 'Révoquer le lien', message: 'Ce lien d’invitation de <strong>' + esc(owner || 'ce compte') + '</strong> ne pourra plus créer de compte. Les comptes déjà inscrits ne sont pas touchés.', confirmLabel: 'Révoquer', danger: true }))) return;
  if (await attempt(() => api.revokeInvite(id), toast)) toast('Lien révoqué.');
  ctx.refresh(true);
}

function bindInvites(root, ctx) {
  bindOpenAccount(root, ctx);
  root.querySelectorAll('[data-adm-invstatus]').forEach((b) => b.addEventListener('click', () => {
    ctx.S.invStatus = b.dataset.admInvstatus;
    ctx.paint();
    ctx.refresh(true);
  }));
  root.querySelectorAll('[data-adm-revoke]').forEach((b) => b.addEventListener('click', () => revokeInvite(ctx, b.dataset.admRevoke, b.dataset.owner)));
}

// ---------- En ligne ----------
function onlineHTML(S) {
  return sectionHead('En ligne', 'Comptes présents en ce moment. Actualisé toutes les 30 secondes quand l’onglet est visible.',
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    loaded(S.online, (r) => {
      if (!r.accounts.length) return empty('Personne n’est connecté en ce moment.');
      const rows = r.accounts.map((a) => ({
        cells: [
          '<button type="button" class="adm-link" data-adm-acc="' + esc(a.id) + '">' + esc(a.username) + '</button>',
          esc(fmtAgo(a.lastSeenAt)),
          a.watching ? esc(a.watching.title) + (a.watching.mediaType ? ' <span class="adm-dim">' + esc(a.watching.mediaType) + '</span>' : '') : '<span class="adm-dim">Rien pour le moment</span>',
        ],
      }));
      return '<p class="adm-count" role="status">' + plural(r.accounts.length, 'compte') + ' en ligne</p>' +
        table('Comptes en ligne', ['Pseudo', 'Dernière présence', 'En lecture'], rows);
    });
}

/** Actualisation de la liste « En ligne » toutes les 30 s, seulement onglet visible et section toujours affichée. */
function ensureOnlineTimer(ctx) {
  if (onlineTimer) return;
  onlineTimer = setInterval(() => {
    if (!ctx.isCurrent()) { clearInterval(onlineTimer); onlineTimer = 0; return; }
    if (document.hidden) return;
    ctx.refresh(true);
  }, ONLINE_MS);
}

function bindOnline(root, ctx) {
  bindOpenAccount(root, ctx);
  ensureOnlineTimer(ctx);
}

export const usersSections = [
  {
    id: 'accounts', group: 'users', label: 'Comptes', icon: 'users', render: accountsHTML, bind: bindAccounts,
    load: (ctx, quiet) => ctx.fetch('acc', () => api.listAccounts({ ...ctx.S.accQuery, limit: ACCOUNT_PAGE, cursor: ctx.S.accPager.cursor }), quiet),
  },
  {
    id: 'invites', group: 'users', label: 'Invitations', icon: 'tree', render: invitesHTML, bind: bindInvites,
    load: (ctx, quiet) => Promise.all([
      ctx.fetch('ref', () => api.getReferrals(), quiet),
      ctx.fetch('inv', () => api.listInvites({ status: ctx.S.invStatus || undefined }), quiet),
    ]),
  },
  {
    id: 'online', group: 'users', label: 'En ligne', icon: 'online', render: onlineHTML, bind: bindOnline,
    load: (ctx, quiet) => ctx.fetch('online', () => api.listOnline(), quiet),
  },
];
