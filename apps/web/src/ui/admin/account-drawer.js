/* Fiche d'un compte : panneau latéral (calque « drawer » d'admin-dialog.js) avec les onglets Aperçu, Sessions, Invitations, Activité
 * et la zone sensible (lien de réinitialisation, suspension ou réactivation, suppression). Les actions destructrices passent par
 * confirmDialog ; l'élévation (mot de passe) est gérée par adminApi.js. Les événements sont délégués au calque. */
import * as api from '../../data/adminApi';
import { fmtAgo, fmtDateTime, fmtDay, fmtInt } from '../../data/adminModel';
import { confirmDialog, openLayer } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { shareBase } from '../invites.js';
import { esc } from '../util.js';
import { adminErr, attempt, badge, empty, statusBadge } from './common.js';

const TABS = [['overview', 'Aperçu'], ['sessions', 'Sessions'], ['invites', 'Invitations'], ['activity', 'Activité']];
const INVITE_LABEL = { active: ['Actif', 'ok'], used: ['Utilisé'], expired: ['Expiré'], revoked: ['Révoqué', 'warn'] };
const TIMELINE_KINDS = ['audit', 'signup', 'invite', 'session', 'party'];
const QUOTA_MIN = 0;
const QUOTA_MAX = 100;
const TIMELINE_LIMIT = 50;

const idle = () => ({ status: 'idle', value: null, error: '' });

/** Pastille d'initiale ; la couleur dépend du pseudo (stable d'une vue à l'autre). */
export function avatarHTML(name, large) {
  const n = String(name || '?');
  const code = [...n].reduce((s, c) => s + c.charCodeAt(0), 0);
  return '<span class="adm-av adm-av--' + (code % 4) + (large ? ' adm-av--lg' : '') + '" aria-hidden="true">' + esc(n.charAt(0).toUpperCase()) + '</span>';
}

const ACCOUNT_ACTIONS = {
  suspend: (u) => ({ title: 'Suspendre ' + u, message: '<strong>' + esc(u) + '</strong> ne pourra plus se connecter et toutes ses sessions seront révoquées immédiatement. Tu pourras réactiver le compte.', confirmLabel: 'Suspendre', danger: true, run: api.suspendAccount, done: 'Compte suspendu.' }),
  reactivate: (u) => ({ title: 'Réactiver ' + u, message: '<strong>' + esc(u) + '</strong> pourra de nouveau se connecter.', confirmLabel: 'Réactiver', danger: false, run: api.reactivateAccount, done: 'Compte réactivé.' }),
  revoke: (u) => ({ title: 'Révoquer les sessions', message: 'Toutes les sessions de <strong>' + esc(u) + '</strong> seront fermées : il devra se reconnecter sur chaque appareil.', confirmLabel: 'Révoquer', danger: true, run: api.revokeSessions, done: 'Sessions révoquées.' }),
  reset: (u) => ({ title: 'Lien de réinitialisation', message: 'Générer un lien à usage unique (24 h) pour <strong>' + esc(u) + '</strong>. Un nouveau lien remplace le précédent. Le lien n’est montré qu’une fois.', confirmLabel: 'Générer le lien', danger: false, run: api.resetLink }),
  delete: (u) => ({ title: 'Supprimer ' + u, message: 'Le compte <strong>' + esc(u) + '</strong>, tous ses profils, sa bibliothèque et ses salons seront supprimés définitivement. Cette action est irréversible.', confirmLabel: 'Supprimer définitivement', danger: true, expect: u, run: api.deleteAccount, done: 'Compte supprimé.' }),
};

/** Fiche ouverte : { layer, id, ctx, detail, link, msg, tab, timeline, busy }. `ctx` : section d'origine (rafraîchie après une action). */
let cur = null;

// ---------- Rendu ----------
const dd = (label, value) => '<div><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
const tile = (value, label) => '<div class="adm-tile"><div class="adm-tile-v">' + value + '</div><div class="adm-tile-l">' + esc(label) + '</div></div>';

function listHTML(items, emptyText, line) {
  return items && items.length ? '<ul class="adm-mini">' + items.map(line).join('') + '</ul>' : empty(emptyText);
}

function tabsHTML(me, nSessions) {
  return '<div class="adm-tabs" role="tablist" aria-label="Rubriques de la fiche">' + TABS.map(([id, label]) => {
    const on = me.tab === id;
    return '<button type="button" role="tab" id="adm-tab-' + id + '" aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="adm-tabpanel" tabindex="' + (on ? '0' : '-1') +
      '" data-adm-tab="' + id + '" data-adm-focus="tab:' + id + '">' + esc(label) +
      (id === 'sessions' ? ' <span class="adm-tab-n">' + fmtInt(nSessions) + '</span>' : '') + '</button>';
  }).join('') + '</div>';
}

function overviewHTML(me, dis) {
  const d = me.detail;
  const a = d.account;
  const quotaDown = dis || a.inviteQuota <= QUOTA_MIN ? ' disabled' : '';
  const quotaUp = dis || a.inviteQuota >= QUOTA_MAX ? ' disabled' : '';
  return '<div class="adm-tiles">' + tile(fmtInt(d.profiles.length), 'profils') + tile(fmtInt(d.libraryCount), 'titres en bibliothèque') + tile(fmtInt(d.invitees.length), 'filleuls') + '</div>' +
    '<dl class="adm-dl">' + dd('Créé le', esc(fmtDateTime(a.createdAt))) + dd('Parrain', a.referrer ? esc(a.referrer) : '—') + dd('Dernière activité', esc(fmtAgo(a.lastActivityAt))) +
    (a.suspendedAt ? dd('Suspendu le', esc(fmtDateTime(a.suspendedAt)))  : '') + '</dl>' +
    '<h4 class="adm-sub">Profils</h4>' + listHTML(d.profiles, 'Aucun profil.', (p) => '<li>' + esc(p.name) + ((p.isKid ?? p.kid) ? ' ' + badge('Enfant') : '') + ((p.hasPin ?? p.pin) ? ' ' + badge('PIN') : '') +
      ' <span class="adm-dim">' + fmtInt(p.libraryCount ?? p.library ?? 0) + ' titre(s)</span></li>') +
    '<h4 class="adm-sub">Quota d’invitations</h4>' +
    '<div class="adm-quota"><p class="adm-quota-t"><strong>' + fmtInt(a.invitesUsed) + ' utilisée(s)</strong> sur un quota de ' + fmtInt(a.inviteQuota) + '</p>' +
    '<div class="adm-stepper" role="group" aria-label="Quota d’invitations">' +
    '<button type="button" class="adm-step" data-adm-quota-step="-1" data-adm-focus="quota:-1" aria-label="Retirer une invitation"' + quotaDown + '>−</button>' +
    '<span class="adm-step-v" aria-live="polite">' + fmtInt(a.inviteQuota) + '</span>' +
    '<button type="button" class="adm-step" data-adm-quota-step="1" data-adm-focus="quota:1" aria-label="Ajouter une invitation"' + quotaUp + '>+</button></div></div>';
}

function sessionsHTML(me, dis) {
  const sessions = me.detail.sessions || [];
  const head = '<div class="adm-sess-h"><h4 class="adm-sub">Sessions ouvertes</h4>' +
    (sessions.length ? '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="revoke"' + dis + '>Révoquer toutes</button>' : '') + '</div>';
  if (!sessions.length) return head + empty('Aucune session ouverte.');
  return head + '<ul class="adm-sesslist">' + sessions.map((s) => '<li class="adm-sess"><div class="adm-sess-main"><div class="adm-sess-d">' + esc(s.device || 'Appareil inconnu') + '</div>' +
    '<div class="adm-dim">Créée le ' + esc(fmtDateTime(s.createdAt)) + ' · dernière activité ' + esc(s.lastSeenAt ? fmtAgo(s.lastSeenAt) : 'inconnu') + '</div></div>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-sess="' + esc(s.id) + '" data-adm-focus="sess:' + esc(s.id) + '"' + dis + '>Révoquer</button></li>').join('') + '</ul>';
}

function invitesHTML(me) {
  const d = me.detail;
  const invitees = d.invitees || [];
  const invites = d.invites || [];
  return '<h4 class="adm-sub">Filleuls</h4>' + listHTML(invitees, 'Aucun filleul.', (i) => '<li>' + esc(i.username) +
    (i.usedAt ? ' <span class="adm-dim">inscrit le ' + esc(fmtDay(i.usedAt)) + '</span>' : '') + '</li>') +
    '<h4 class="adm-sub">Liens d’invitation</h4>' + listHTML(invites, 'Aucun lien émis.', (i) => {
      const [label, kind] = INVITE_LABEL[i.status] || [i.status, ''];
      return '<li class="adm-inv">' + badge(label, kind) + ' <span class="adm-dim">créé le ' + esc(fmtDay(i.createdAt)) +
        (i.expiresAt ? ' · expire le ' + esc(fmtDay(i.expiresAt)) : ' · sans expiration') + (i.usedAt ? ' · utilisé le ' + esc(fmtDay(i.usedAt)) : '') + '</span></li>';
    });
}

function activityHTML(me) {
  const tl = me.timeline;
  if (tl.status === 'idle' || tl.status === 'loading') return '<p class="adm-empty" role="status">Chargement…</p>';
  if (tl.status === 'error') return '<div class="adm-error" role="alert"><span>' + esc(tl.error) + '</span><button type="button" class="btn btn-ghost btn-sm" data-adm-tl-reload>Réessayer</button></div>';
  if (!tl.value.length) return empty('Aucune activité récente.');
  return '<ol class="adm-tl-list">' + tl.value.map((e) => {
    const kind = TIMELINE_KINDS.includes(e.kind) ? e.kind : 'audit';
    return '<li class="adm-tl"><span class="adm-tl-dot k-' + kind + '" aria-hidden="true"></span><span class="adm-tl-t">' + esc(e.label) +
      (e.detail ? ' <span class="adm-dim">' + esc(e.detail) + '</span>' : '') + '</span><time class="adm-tl-at">' + esc(fmtDateTime(e.at)) + '</time></li>';
  }).join('') + '</ol>';
}

function panelHTML(me, dis) {
  if (me.tab === 'sessions') return sessionsHTML(me, dis);
  if (me.tab === 'invites') return invitesHTML(me);
  if (me.tab === 'activity') return activityHTML(me);
  return overviewHTML(me, dis);
}

function dangerHTML(me, dis) {
  const a = me.detail.account;
  const owner = a.isOwner;
  return '<section class="adm-zone" aria-labelledby="adm-zone-t"><h3 id="adm-zone-t">Zone sensible</h3>' +
    '<div class="adm-actions">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="reset"' + dis + '>Lien de réinitialisation</button>' +
    (a.status === 'suspended'
      ? '<button type="button" class="btn btn-ghost btn-sm" data-adm-do="reactivate"' + dis + '>Réactiver le compte</button>'
      : '<button type="button" class="btn btn-danger btn-sm" data-adm-do="suspend"' + (owner ? ' disabled' : dis) + '>Suspendre</button>') +
    '<button type="button" class="btn btn-danger btn-sm" data-adm-do="delete"' + (owner ? ' disabled' : dis) + '>Supprimer le compte</button></div>' +
    (owner ? '<p class="set-hint">Le compte propriétaire ne peut être ni suspendu ni supprimé.</p>' : '') +
    (me.link ? '<div class="adm-linkbox" role="status"><p class="set-hint">Lien à usage unique, valable jusqu’au ' + esc(fmtDateTime(me.link.expiresAt)) + '. Il ne sera plus affiché : copie-le maintenant.</p>' +
      '<div class="adm-inline"><input class="set-input" type="text" readonly value="' + esc(me.link.url) + '" aria-label="Lien de réinitialisation" data-adm-linkval><button type="button" class="btn btn-primary btn-sm" data-adm-copy>Copier</button></div></div>' : '') +
    '</section>';
}

/** Contenu complet du panneau : en-tête du compte, onglets, rubrique active, zone sensible, message d'état. */
function drawerHTML(me) {
  const a = me.detail.account;
  const dis = me.busy ? ' disabled' : '';
  return '<div class="adm-detail" data-adm-detail="' + esc(a.id) + '">' +
    '<div class="adm-who-h">' + avatarHTML(a.username, true) + '<div class="adm-who-meta"><div class="adm-detail-top">' + statusBadge(a.status) + (a.isOwner ? badge('Propriétaire') : '') + '</div>' +
    '<p class="adm-dim">Inscrit le ' + esc(fmtDay(a.createdAt)) + (a.referrer ? ' · parrainé par ' + esc(a.referrer) : '') + '</p></div></div>' +
    tabsHTML(me, (me.detail.sessions || []).length) +
    '<div class="adm-tabpanel" role="tabpanel" id="adm-tabpanel" aria-labelledby="adm-tab-' + me.tab + '">' + panelHTML(me, dis) + '</div>' +
    dangerHTML(me, dis) +
    '<p class="set-msg" id="adm-detail-msg" role="status"></p></div>';
}

function renderDetail() {
  if (!cur || !cur.detail) return;
  const body = cur.layer.body;
  const active = document.activeElement;
  const key = active instanceof HTMLElement && body.contains(active) ? active.dataset.admFocus || '' : '';
  cur.layer.setBody(drawerHTML(cur));
  const m = body.querySelector('#adm-detail-msg');
  if (m) m.textContent = cur.msg || '';
  if (key) {
    const n = Array.from(body.querySelectorAll('[data-adm-focus]')).find((x) => x.dataset.admFocus === key);
    if (n && !n.disabled) n.focus({ preventScroll: true });
  }
}

// ---------- Données ----------
/** Ouvre la fiche d'un compte dans le panneau latéral ; `ctx` est celui de la section qui l'a demandée. */
export async function openAccount(ctx, id) {
  const me = { layer: null, id, ctx, detail: null, link: null, msg: '', tab: 'overview', timeline: idle(), busy: false };
  me.layer = openLayer({ title: 'Compte', variant: 'drawer', html: '<p class="adm-empty" role="status">Chargement…</p>', onClose: () => { if (cur === me) cur = null; } });
  cur = me;
  me.layer.el.addEventListener('click', onLayerClick);
  me.layer.el.addEventListener('keydown', onLayerKeydown);
  try {
    const detail = await api.getAccount(id);
    if (cur !== me) return;
    me.detail = detail;
    me.layer.el.querySelector('.adm-sheet-h h2').textContent = detail.account.username;
    renderDetail();
  } catch (err) {
    if (cur !== me) return;
    me.layer.setBody('<div class="adm-error" role="alert"><span>' + esc(adminErr(err)) + '</span></div>');
  }
}

/** Relit la fiche après une action (et la section d'origine) ; l'activité est relue si son onglet est ouvert. */
async function refreshAfterChange(me) {
  try { me.detail = await api.getAccount(me.id); } catch (_) { /* on garde la fiche actuelle */ }
  if (cur !== me) return;
  me.timeline = idle();
  renderDetail();
  if (me.tab === 'activity') loadTimeline(me);
  me.ctx.refresh(true);
}

async function loadTimeline(me) {
  me.timeline = { status: 'loading', value: null, error: '' };
  renderDetail();
  try {
    const r = await api.getTimeline(me.id, TIMELINE_LIMIT);
    if (cur !== me) return;
    me.timeline = { status: 'ready', value: Array.isArray(r.events) ? r.events : [], error: '' };
  } catch (err) {
    if (cur !== me) return;
    me.timeline = { status: 'error', value: null, error: adminErr(err) };
  }
  renderDetail();
}

function selectTab(me, tab) {
  if (me.tab === tab || !TABS.some(([id]) => id === tab)) return;
  me.tab = tab;
  if (tab === 'activity' && me.timeline.status === 'idle') { loadTimeline(me); return; }
  renderDetail();
}

/** Action destructrice ou de confirmation (ACCOUNT_ACTIONS) : confirmation, appel, message, relecture. */
async function accountAction(kind) {
  const me = cur;
  if (!me || !me.detail || me.busy) return;
  const { id } = me;
  const spec = ACCOUNT_ACTIONS[kind](me.detail.account.username);
  if (!(await confirmDialog(spec))) return;
  me.msg = '';
  me.busy = true;
  renderDetail();
  let result;
  const say = (t) => { if (cur === me) me.msg = t; };
  const ok = await attempt(async () => { result = await spec.run(id); }, say);
  me.busy = false;
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
  await refreshAfterChange(me);
}

async function stepQuota(delta) {
  const me = cur;
  if (!me || !me.detail || me.busy) return;
  const next = me.detail.account.inviteQuota + delta;
  if (next < QUOTA_MIN || next > QUOTA_MAX) return;
  me.busy = true;
  me.msg = '';
  renderDetail();
  const say = (t) => { if (cur === me) me.msg = t; };
  const ok = await attempt(() => api.setInviteQuota(me.id, next), say);
  me.busy = false;
  if (ok && cur === me) me.msg = 'Quota enregistré.';
  await refreshAfterChange(me);
}

async function revokeOneSession(sid) {
  const me = cur;
  if (!me || !me.detail || me.busy) return;
  me.busy = true;
  me.msg = '';
  renderDetail();
  const say = (t) => { if (cur === me) me.msg = t; };
  const ok = await attempt(() => api.revokeSession(me.id, sid), say);
  me.busy = false;
  if (ok && cur === me) me.msg = 'Session révoquée.';
  await refreshAfterChange(me);
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

// ---------- Événements (délégués au calque) ----------
function onLayerClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !cur) return;
  const tab = t.closest('[data-adm-tab]');
  if (tab) { e.preventDefault(); selectTab(cur, tab.dataset.admTab); return; }
  const doBtn = t.closest('[data-adm-do]');
  if (doBtn) { e.preventDefault(); accountAction(doBtn.dataset.admDo); return; }
  const step = t.closest('[data-adm-quota-step]');
  if (step) { e.preventDefault(); stepQuota(Number(step.dataset.admQuotaStep)); return; }
  const sess = t.closest('[data-adm-sess]');
  if (sess) { e.preventDefault(); revokeOneSession(sess.dataset.admSess); return; }
  if (t.closest('[data-adm-tl-reload]')) { e.preventDefault(); loadTimeline(cur); return; }
  if (t.closest('[data-adm-copy]')) copyLink();
}

/** Flèches, Début et Fin dans la liste d'onglets (motif ARIA « tabs »). */
function onLayerKeydown(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !cur || !t.closest('[role="tablist"]')) return;
  const ids = TABS.map(([id]) => id);
  const i = ids.indexOf(cur.tab);
  const next = { ArrowRight: (i + 1) % ids.length, ArrowLeft: (i - 1 + ids.length) % ids.length, Home: 0, End: ids.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  const id = ids[next];
  selectTab(cur, id);
  const btn = cur.layer.body.querySelector('[data-adm-tab="' + id + '"]');
  if (btn) btn.focus({ preventScroll: true });
}
