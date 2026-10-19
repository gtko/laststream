/* Page #/admin : console d'administration (propriétaire seulement, profil non enfant).
 * Navigation latérale (même composants que les Réglages), une section à la fois, données chargées à la demande.
 * Les actions destructrices demandent une confirmation explicite, puis le mot de passe si l'élévation manque (adminApi.js). */
import { canAdmin } from '../data/auth';
import * as api from '../data/adminApi';
import { setElevationPrompt } from '../data/adminApi';
import { ACCOUNT_PAGE_LIMIT, CursorPager, daysAgoIso, fmtDateTime, purgeList, scanAccounts } from '../data/adminModel';
import { UserApiError } from '../data/userApi';
import { closeAllLayers, confirmDialog, openLayer, passwordDialog } from './admin-dialog.js';
import {
  accountDetailHTML, accountsHTML, adminErr, auditHTML, cachesHTML, overviewHTML, partiesHTML, moderationHTML, performanceHTML,
  referralsHTML, SECTIONS, settingsHTML, tvHTML,
} from './admin-views.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { shareBase } from './invites.js';
import { SET_ICON } from './settings-ui.js';
import { state } from './state.js';
import { esc } from './util.js';

const idle = () => ({ status: 'idle', value: null, error: '' });
const S = {
  sec: 'overview', range: '1h', updatedAt: 0,
  ov: idle(), acc: idle(), accQuery: { q: '', status: '', order: 'newest' }, accPager: new CursorPager(),
  ref: idle(), perf: idle(), caches: idle(), purges: {}, tv: idle(), rooms: idle(), reports: idle(), repStatus: 'open',
  settings: idle(), audit: idle(), auditPager: new CursorPager(), auditAction: '',
};
const KEYS = { overview: 'ov', accounts: 'acc', referrals: 'ref', performance: 'perf', caches: 'caches', tv: 'tv', parties: 'rooms', moderation: 'reports', settings: 'settings', audit: 'audit' };
const VIEWS = { overview: overviewHTML, accounts: accountsHTML, referrals: referralsHTML, performance: performanceHTML, caches: cachesHTML, tv: tvHTML, parties: partiesHTML, moderation: moderationHTML, settings: settingsHTML, audit: auditHTML };
const REFRESH_MS = 30_000;
let timer = 0;
let hooked = false;
const tokens = {};

const content = () => detailEl.querySelector('#adm-content');
const live = () => state.kind === 'admin' && !!content();

function paint() {
  const el = content();
  if (!el || !live()) return;
  const scroll = window.scrollY;
  const hadFocus = el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = hadFocus && hadFocus.getAttribute ? (hadFocus.getAttribute('data-adm-range') ? '[data-adm-range="' + hadFocus.getAttribute('data-adm-range') + '"]' : '') : '';
  el.innerHTML = VIEWS[S.sec](S);
  if (focusKey) { const n = el.querySelector(focusKey); if (n) n.focus({ preventScroll: true }); }
  window.scrollTo(0, scroll);
}

// ---------- Chargement ----------
const FETCH = {
  async overview() {
    const accounts = await scanAccounts((cursor) => api.listAccounts({ limit: ACCOUNT_PAGE_LIMIT, order: 'newest', cursor }));
    const [signups, metrics, rooms, reports, settings] = await Promise.allSettled([
      api.listAccounts({ createdFrom: daysAgoIso(7), limit: 1 }), api.getMetrics('24h'), api.listRooms(), api.listReports('open'), api.getSettings(),
    ]);
    const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
    return {
      total: accounts.total, active24: accounts.active24, suspended: accounts.suspended, scanned: accounts.scanned, truncated: accounts.truncated,
      signups7: ok(signups) ? ok(signups).total : null, metrics: ok(metrics),
      rooms: ok(rooms) ? ok(rooms).rooms.length : null, reports: ok(reports) ? ok(reports).reports.length : null,
      maintenance: ok(settings) ? !!ok(settings).maintenance.enabled : false,
    };
  },
  accounts: () => api.listAccounts({ ...S.accQuery, limit: 25, cursor: S.accPager.cursor }),
  referrals: () => api.getReferrals(),
  performance: () => api.getMetrics(S.range),
  async caches() {
    const r = await api.getCaches('24h');
    try {
      const jobs = purgeList(await api.getPurges());
      for (const j of jobs) if (j.status === 'running' && !S.purges[j.prefix]) { S.purges[j.prefix] = j; pollPurge(j.prefix, j.id); }
    } catch (_) { /* progression indisponible : la liste reste utile */ }
    return r;
  },
  tv: () => api.getTv(),
  parties: () => api.listRooms(),
  moderation: () => api.listReports(S.repStatus),
  settings: () => api.getSettings(),
  audit: () => api.listAudit({ limit: 50, before: S.auditPager.cursor, action: S.auditAction || undefined }),
};

/** Charge une section ; `quiet` garde l'affichage actuel pendant l'actualisation (pas de « Chargement… »). */
async function load(sec, quiet) {
  const key = KEYS[sec];
  const token = (tokens[sec] = (tokens[sec] || 0) + 1);
  if (!quiet || S[key].status !== 'ready') { S[key] = { status: 'loading', value: null, error: '' }; if (S.sec === sec) paint(); }
  try {
    const value = await FETCH[sec]();
    if (token !== tokens[sec]) return;
    S[key] = { status: 'ready', value, error: '' };
    if (sec === 'performance' || sec === 'overview') S.updatedAt = Date.now();
  } catch (err) {
    if (token !== tokens[sec]) return;
    S[key] = { status: 'error', value: null, error: adminErr(err) };
  }
  if (S.sec === sec) paint();
}

function startTimer() {
  if (timer) return;
  timer = window.setInterval(() => {
    if (!live()) { clearInterval(timer); timer = 0; return; }
    if (document.hidden || S.sec !== 'performance') return; // pause : onglet masqué ou autre section
    load('performance', true);
  }, REFRESH_MS);
}

// ---------- Page ----------
function navHTML() {
  return '<nav class="set-nav adm-nav" aria-label="Sections d’administration"><ul>' + SECTIONS.map((c) =>
    '<li data-nav><button type="button" class="set-nav-i" data-adm-sec="' + c.id + '" aria-current="' + (c.id === S.sec ? 'true' : 'false') + '">' +
    SET_ICON[c.icon] + '<span>' + esc(c.label) + '</span></button></li>').join('') + '</ul></nav>';
}

function pageHTML() {
  return topBar(false) + '<article class="svc-page set-page adm-page" aria-labelledby="adm-title"><header class="set-head"><p class="set-eyebrow">Laststream</p>' +
    '<h1 class="set-title" id="adm-title" tabindex="-1">Administration</h1></header><div class="set-layout adm-layout">' + navHTML() +
    '<div class="set-main adm-main"><section id="adm-content" class="adm-content" aria-live="polite"></section></div></div></article>';
}

export function showAdmin() {
  if (!canAdmin()) { location.replace('#/'); return; }
  teardownFiche();
  state.kind = 'admin';
  document.title = 'Administration · Laststream';
  setElevationPrompt(({ error }) => passwordDialog({ error }));
  if (!hooked) { hooked = true; window.addEventListener('hashchange', closeAllLayers); document.addEventListener('visibilitychange', onVisible); }
  detailEl.innerHTML = pageHTML();
  const h1 = detailEl.querySelector('#adm-title');
  if (h1) h1.focus({ preventScroll: true });
  paint();
  load(S.sec);
  startTimer();
}

function onVisible() {
  if (!document.hidden && live() && S.sec === 'performance' && Date.now() - S.updatedAt > REFRESH_MS) load('performance', true);
}

function setSection(id) {
  if (!KEYS[id] || id === S.sec) return;
  S.sec = id;
  detailEl.querySelectorAll('[data-adm-sec]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.admSec === id)));
  paint();
  load(id, true);
  const h = detailEl.querySelector('#adm-h');
  if (h) h.focus({ preventScroll: true });
}

// ---------- Utilitaires d'action ----------
/** Exécute une action ; gère les erreurs (message dans `say` ou toast). Renvoie true en cas de succès. */
async function attempt(fn, say) {
  try { await fn(); return true; } catch (err) {
    if (err instanceof UserApiError && err.code === 'cancelled') { (say || toast)('Action annulée.'); return false; }
    (say || toast)(adminErr(err));
    return false;
  }
}

async function copyText(text, input) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* repli ci-dessous */ }
  }
  if (input) { input.select(); try { return document.execCommand('copy'); } catch (_) { return false; } }
  return false;
}

// ---------- Compte : panneau de détail ----------
let cur = null; // { layer, id, detail, link, msg }

function renderDetail(busy) {
  if (!cur) return;
  cur.layer.setBody(accountDetailHTML(cur.detail, cur.link, busy));
  const m = cur.layer.el.querySelector('#adm-detail-msg');
  if (m) m.textContent = cur.msg || '';
}

async function openAccount(id) {
  const layer = openLayer({ title: 'Compte', variant: 'drawer', html: '<p class="adm-empty" role="status">Chargement…</p>', onClose: () => { cur = null; } });
  cur = { layer, id, detail: null, link: null, msg: '' };
  try {
    cur.detail = await api.getAccount(id);
    layer.el.querySelector('.adm-sheet-h h2').textContent = cur.detail.account.username;
    renderDetail(false);
  } catch (err) {
    layer.setBody('<div class="adm-error" role="alert"><span>' + esc(adminErr(err)) + '</span></div>');
  }
}

async function refreshAfterAccountChange() {
  if (!cur) return;
  try { cur.detail = await api.getAccount(cur.id); } catch (_) { /* conservé */ }
  renderDetail(false);
  if (S.sec === 'accounts') load('accounts', true);
  else if (S.sec === 'referrals') load('referrals', true);
}

const ACCOUNT_ACTIONS = {
  suspend: (u) => ({ title: 'Suspendre ' + u, message: '<strong>' + esc(u) + '</strong> ne pourra plus se connecter et toutes ses sessions seront révoquées immédiatement. Tu pourras réactiver le compte.', confirmLabel: 'Suspendre', danger: true, run: api.suspendAccount, done: 'Compte suspendu.' }),
  reactivate: (u) => ({ run: api.reactivateAccount, done: 'Compte réactivé.', skipConfirm: true, u }),
  revoke: (u) => ({ title: 'Révoquer les sessions', message: 'Toutes les sessions de <strong>' + esc(u) + '</strong> seront fermées : il devra se reconnecter sur chaque appareil.', confirmLabel: 'Révoquer', danger: true, run: api.revokeSessions, done: 'Sessions révoquées.' }),
  reset: (u) => ({ title: 'Lien de réinitialisation', message: 'Générer un lien à usage unique (24 h) pour <strong>' + esc(u) + '</strong>. Un nouveau lien remplace le précédent. Le lien n’est montré qu’une fois.', confirmLabel: 'Générer le lien', danger: false, run: api.resetLink }),
  delete: (u) => ({ title: 'Supprimer ' + u, message: 'Le compte <strong>' + esc(u) + '</strong>, tous ses profils, sa bibliothèque et ses salons seront supprimés définitivement. Cette action est irréversible.', confirmLabel: 'Supprimer définitivement', danger: true, expect: u, run: api.deleteAccount, done: 'Compte supprimé.' }),
};

async function accountAction(kind) {
  if (!cur || !cur.detail) return;
  const { id } = cur;
  const u = cur.detail.account.username;
  const spec = ACCOUNT_ACTIONS[kind](u);
  if (!spec.skipConfirm && !(await confirmDialog(spec))) return;
  cur.msg = '';
  renderDetail(true);
  let result;
  const say = (t) => { if (cur) cur.msg = t; };
  const ok = await attempt(async () => { result = await spec.run(id); }, say);
  if (!cur) return;
  if (ok && kind === 'reset') {
    cur.link = { expiresAt: result.expiresAt, url: shareBase() + '/#/reset/' + encodeURIComponent(result.token) };
    cur.msg = 'Lien généré.';
  } else if (ok) cur.msg = spec.done;
  if (ok && kind === 'delete') {
    const l = cur.layer; cur = null; l.close(); toast(spec.done);
    if (S.sec === 'accounts') load('accounts', true);
    if (S.sec === 'referrals') load('referrals', true);
    return;
  }
  await refreshAfterAccountChange();
}

// ---------- Purge de cache ----------
async function pollPurge(prefix, id) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!live()) return;
    let job;
    try { job = await api.getPurge(id); } catch (_) { continue; }
    S.purges[prefix] = job;
    if (S.sec === 'caches') paint();
    if (job.status !== 'running') { if (S.sec === 'caches') load('caches', true); return; }
  }
}

async function purge(prefix) {
  if (!(await confirmDialog({ title: 'Vider le cache « ' + prefix + ' »', message: 'Toutes les entrées du cache <strong>' + esc(prefix) + '</strong> seront supprimées par lots, en arrière-plan. Les prochaines requêtes seront plus lentes le temps de le reconstituer.', confirmLabel: 'Vider le cache', danger: true }))) return;
  await attempt(async () => {
    const job = await api.purgeCache(prefix);
    S.purges[prefix] = job;
    paint();
    pollPurge(prefix, job.id);
  });
}

// ---------- Événements ----------
async function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const inLayer = t.closest('.adm-layer');
  if (inLayer) {
    const d = t.closest('[data-adm-do]');
    if (d) { e.preventDefault(); accountAction(d.dataset.admDo); return; }
    if (t.closest('[data-adm-copy]')) {
      const input = inLayer.querySelector('[data-adm-linkval]');
      const ok = input ? await copyText(input.value, input) : false;
      toast(ok ? 'Lien copié' : 'Copie impossible : sélectionne le lien à la main');
    }
    return;
  }
  if (!t.closest('.adm-page')) return;
  const sec = t.closest('[data-adm-sec]');
  if (sec) { e.preventDefault(); setSection(sec.dataset.admSec); return; }
  if (t.closest('[data-adm-reload]')) { e.preventDefault(); load(S.sec); return; }
  const rng = t.closest('[data-adm-range]');
  if (rng) { S.range = rng.dataset.admRange; load('performance'); return; }
  const acc = t.closest('[data-adm-acc]');
  if (acc) { e.preventDefault(); openAccount(acc.dataset.admAcc); return; }
  const pg = t.closest('[data-adm-page]');
  if (pg) {
    const [which, dir] = pg.dataset.admPage.split(':');
    const pager = which === 'acc' ? S.accPager : S.auditPager;
    const data = which === 'acc' ? S.acc.value : S.audit.value;
    if (dir === 'next') { if (!pager.next(data && (data.nextCursor || data.nextBefore))) return; } else if (!pager.prev()) return;
    load(which === 'acc' ? 'accounts' : 'audit');
    return;
  }
  const pu = t.closest('[data-adm-purge]');
  if (pu) { purge(pu.dataset.admPurge); return; }
  if (t.closest('[data-adm-tvrerun]')) { tvRerun(); return; }
  const cr = t.closest('[data-adm-closeroom]');
  if (cr) { closeRoom(cr.dataset.admCloseroom, cr.dataset.title); return; }
  const rs = t.closest('[data-adm-repstatus]');
  if (rs) { S.repStatus = rs.dataset.admRepstatus; load('moderation'); return; }
  const rp = t.closest('[data-adm-rep]');
  if (rp) { const [id, action] = rp.dataset.admRep.split(':'); reportAction(id, action, rp.dataset.who); }
}

async function tvRerun() {
  if (!(await confirmDialog({ title: 'Relancer la tâche TV', message: 'La mise à jour des chaînes va être relancée maintenant, en dehors de son horaire habituel.', confirmLabel: 'Relancer' }))) return;
  const msg = detailEl.querySelector('#adm-tv-msg');
  const say = (t) => { const m = detailEl.querySelector('#adm-tv-msg'); if (m) m.textContent = t; };
  if (msg) msg.textContent = 'Relance en cours…';
  if (await attempt(() => api.rerunTv(), say)) { say('Relance demandée.'); setTimeout(() => { if (S.sec === 'tv') load('tv', true); }, 2500); }
}

async function closeRoom(id, title) {
  if (!(await confirmDialog({ title: 'Fermer le salon', message: 'Le salon <strong>' + esc(title) + '</strong> sera fermé de force : tous les participants seront déconnectés.', confirmLabel: 'Fermer le salon', danger: true }))) return;
  if (await attempt(() => api.closeRoom(id))) { toast('Salon fermé'); load('parties', true); }
}

async function reportAction(id, action, who) {
  if (action === 'delete' && !(await confirmDialog({ title: 'Supprimer le message', message: 'Le message signalé sera retiré du salon pour tous les participants.', confirmLabel: 'Supprimer', danger: true }))) return;
  if (action === 'suspend' && !(await confirmDialog({ title: 'Suspendre l’auteur', message: 'Le compte <strong>' + esc(who || 'de l’auteur') + '</strong> sera suspendu : connexion refusée et sessions révoquées.', confirmLabel: 'Suspendre', danger: true }))) return;
  const ok = await attempt(() => api.reportAction(id, action));
  if (ok) toast(action === 'delete' ? 'Message supprimé' : action === 'suspend' ? 'Auteur suspendu' : 'Signalement ignoré');
  if (ok || S.reports.status === 'ready') load('moderation', true);
}

async function onSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  if (f.matches('[data-adm-accsearch]')) {
    e.preventDefault();
    S.accQuery = { q: f.elements.q.value.trim(), status: f.elements.status.value, order: f.elements.order.value };
    S.accPager.reset();
    load('accounts');
  } else if (f.matches('[data-adm-auditform]')) {
    e.preventDefault();
    S.auditAction = f.elements.action.value.trim();
    S.auditPager.reset();
    load('audit');
  } else if (f.matches('[data-adm-quota]')) {
    e.preventDefault();
    if (!cur) return;
    const quota = Number(f.elements.quota.value);
    if (!Number.isInteger(quota) || quota < 0 || quota > 100) { cur.msg = 'Le quota va de 0 à 100.'; renderDetail(false); return; }
    renderDetail(true);
    const say = (t) => { if (cur) cur.msg = t; };
    if (await attempt(() => api.setInviteQuota(cur.id, quota), say)) cur.msg = 'Quota enregistré.';
    await refreshAfterAccountChange();
  } else if (f.id === 'adm-settings') {
    e.preventDefault();
    saveSettings(f);
  }
}

async function saveSettings(f) {
  const msg = detailEl.querySelector('#adm-settings-msg');
  const say = (t) => { const m = detailEl.querySelector('#adm-settings-msg'); if (m) m.textContent = t; };
  const old = S.settings.value;
  if (!old) return;
  const quota = Number(f.elements.quota.value);
  if (!Number.isInteger(quota) || quota < 0 || quota > 100) { say('Le quota par défaut va de 0 à 100.'); return; }
  const on = (n) => f.elements[n].getAttribute('aria-checked') === 'true';
  const patch = {};
  if (quota !== old.inviteDefaultQuota) patch.inviteDefaultQuota = quota;
  if (on('invitesOpen') !== !!old.invitesOpen) patch.invitesOpen = on('invitesOpen');
  const mEnabled = on('maintenance');
  const mMsg = f.elements.message.value.trim();
  if (mEnabled !== !!old.maintenance.enabled || mMsg !== (old.maintenance.message || '')) patch.maintenance = { enabled: mEnabled, message: mMsg };
  if (!Object.keys(patch).length) { say('Rien à enregistrer.'); return; }
  if (patch.invitesOpen === false && !(await confirmDialog({ title: 'Fermer les inscriptions', message: 'Les liens d’invitation seront refusés : personne ne pourra créer de compte tant que les inscriptions sont fermées.', confirmLabel: 'Fermer les inscriptions', danger: true }))) return;
  if (patch.maintenance && patch.maintenance.enabled && !old.maintenance.enabled && !(await confirmDialog({ title: 'Activer la maintenance', message: '<strong>Tout le serveur répondra « 503 »</strong> à tous les utilisateurs sauf à l’administration. Tu devras confirmer avec ton mot de passe.', confirmLabel: 'Activer la maintenance', danger: true }))) return;
  if (msg) msg.textContent = 'Enregistrement…';
  let res;
  if (await attempt(async () => { res = await api.putSettings(patch); }, say)) {
    S.settings = { status: 'ready', error: '', value: res && res.maintenance ? res : { ...old, ...patch, maintenance: { ...old.maintenance, ...(patch.maintenance || {}) } } };
    paint();
    say('Réglages enregistrés (' + fmtDateTime(Date.now()) + ').');
    toast('Réglages du serveur enregistrés');
  }
}

document.addEventListener('click', onClick);
document.addEventListener('submit', onSubmit);

/** État interne exposé aux tests. */
export const __admin = { S, load, paint };
