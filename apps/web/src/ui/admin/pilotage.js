/* Espace Pilotage : tableau de bord (santé des services, chiffres clés, trafic, « En direct » rafraîchi toutes les 30 s)
 * et « À traiter » (liste des actions, groupée par sévérité). Chaque donnée se charge à part (ctx.fetch) : un échec
 * d'un appel n'empêche pas l'affichage des autres. */
import '../../styles/admin-pilotage.css';
import * as api from '../../data/adminApi';
import {
  ACCOUNT_PAGE_LIMIT, daysAgoIso, deltaTone, feedRows, fmtAgo, fmtDelta, fmtInt, fmtMs, fmtPct, fmtRate, healthTiles, inboxGroups,
  inboxSeverity, inboxWithout, routeSection, scanAccounts, seriesLabels, summarize,
} from '../../data/adminModel';
import { lineChart, sparkline } from '../admin-charts.js';
import { confirmDialog } from '../admin-dialog.js';
import { esc } from '../util.js';
import { admCard, adminErr, attempt, empty, loaded, sectionHead } from './common.js';

const LIVE_MS = 30_000;
const TODO_PREVIEW = 4;
const RANGES = [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 j']];
const RANGE_NAME = { '1h': '1 heure', '24h': '24 heures', '7d': '7 jours' };
/** Marque d'un item de « À traiter » selon sa nature (pastille à gauche). */
const KIND_MARK = { report: '!', provider: '~', errors5xx: '5xx', quota: '+', cron: 'TV', purge: 'C' };
const SEV_CLASS = { critical: 'is-critical', warn: 'is-warn', info: 'is-info' };
const IDLE = { status: 'idle', value: null, error: '' };

// État propre à la vue (la donnée elle-même vit dans S, via ctx.fetch).
let dashRange = '24h';
let liveAt = 0;
let liveTimer = 0;

// ---------- Chargement ----------
/** Vue d'ensemble : comptes (balayage des plus récents : total, actifs 24 h, suspendus), inscriptions sur 7 jours, maintenance, salons, signalements. */
async function fetchOverview() {
  const scan = await scanAccounts((cursor) => api.listAccounts({ limit: ACCOUNT_PAGE_LIMIT, order: 'newest', cursor }));
  const [signups, settings, rooms, reports] = await Promise.allSettled([
    api.listAccounts({ createdFrom: daysAgoIso(7), limit: 1 }), api.getSettings(), api.listRooms(), api.listReports('open'),
  ]);
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  return {
    total: scan.total, active24: scan.active24, suspended: scan.suspended, scanned: scan.scanned, truncated: scan.truncated,
    signups7: ok(signups) ? ok(signups).total : null,
    maintenance: !!ok(settings)?.maintenance?.enabled,
    rooms: Array.isArray(ok(rooms)?.rooms) ? ok(rooms).rooms.length : null,
    reports: Array.isArray(ok(reports)?.reports) ? ok(reports).reports.length : null,
  };
}

/** Trafic : résumé des métriques et série (sparklines, variations, graphiques). Un des deux appels peut échouer sans masquer l'autre. */
async function fetchTraffic(range) {
  const [metrics, series] = await Promise.allSettled([api.getMetrics(range), api.getOverviewSeries(range)]);
  if (metrics.status === 'rejected' && series.status === 'rejected') throw metrics.reason;
  return {
    range,
    metrics: metrics.status === 'fulfilled' ? metrics.value : null,
    series: series.status === 'fulfilled' ? series.value : null,
    seriesErr: series.status === 'rejected' ? adminErr(series.reason) : '',
  };
}

/** « En direct » : le relevé sert aussi d'horodatage affiché dans l'en-tête. */
async function fetchLive() {
  const v = await api.getLive();
  liveAt = Date.now();
  return v;
}

function loadOverview(ctx, quiet) {
  ctx.fetch('health', () => api.getStatus(), quiet);
  ctx.fetch('ov', fetchOverview, quiet);
  ctx.fetch('traffic', () => fetchTraffic(dashRange), quiet);
  ctx.fetch('live', fetchLive, quiet);
  ctx.fetch('inbox', () => api.getInbox(), quiet);
}

// ---------- « En direct » : rafraîchi toutes les 30 s, seulement section affichée et onglet visible ----------
function startLive(ctx) {
  if (liveTimer) return;
  liveTimer = setInterval(() => {
    if (!ctx.isCurrent()) { stopLive(); return; }
    if (document.hidden) return;
    ctx.fetch('live', fetchLive, true);
  }, LIVE_MS);
}

/** Arrête le rafraîchissement de « En direct » (appelé quand la section n'est plus affichée ; exporté pour les tests). */
export function stopLive() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
}

// ---------- Rendu : tableau de bord ----------
const pill = (v, l) => '<button type="button" class="pill" data-adm-dashrange="' + v + '" data-adm-focus="dashrange:' + v + '" aria-pressed="' + (dashRange === v) + '">' + l + '</button>';

function healthHTML(d) {
  return '<section class="adm-health-wrap" aria-label="Santé des services">' + loaded(d, (report) =>
    '<ul class="adm-health">' + healthTiles(report).map((t) =>
      '<li class="adm-health-t is-' + t.tone + '">' +
      '<div class="adm-health-h"><span class="adm-health-n"><i class="adm-dot" aria-hidden="true"></i>' + esc(t.name) + '</span>' +
      '<span class="adm-health-st">' + esc(t.statusLabel) + '</span></div>' +
      '<strong class="adm-health-v">' + esc(t.value) + '</strong><span class="adm-health-s">' + esc(t.sub) + '</span></li>').join('') + '</ul>') + '</section>';
}

/** Une ligne de « À traiter » : pastille, titre, détail et âge, « Marquer vu » et l'action propre à l'item. */
function todoItemHTML(i) {
  const k = esc(i.key);
  const at = i.at ? ' · ' + fmtAgo(i.at) : '';
  return '<li class="adm-todo"><span class="adm-todo-k ' + (SEV_CLASS[inboxSeverity(i)] || '') + '" aria-hidden="true">' + esc(KIND_MARK[i.kind] || '•') + '</span>' +
    '<div class="adm-todo-b"><span class="adm-todo-t">' + esc(i.title) + '</span><span class="adm-todo-s">' + esc(i.detail) + esc(at) + '</span></div>' +
    '<div class="adm-todo-a"><button type="button" class="btn btn-ghost btn-sm" data-adm-inbox-seen="' + k + '">Marquer vu</button>' +
    '<button type="button" class="btn btn-primary btn-sm" data-adm-inbox-act="' + k + '">' + esc(i.action && i.action.label ? i.action.label : 'Ouvrir') + '</button></li>';
}

/** Liste groupée par sévérité ; `limit` borne le nombre d'items affichés (aperçu du tableau de bord). */
function inboxHTML(inb, limit = Infinity) {
  const items = Array.isArray(inb.items) ? inb.items : [];
  if (!items.length) {
    return '<div class="adm-inbox-empty" role="status"><p class="adm-inbox-empty-t">Rien à traiter.</p>' +
      '<p class="adm-dim">Les signalements, alertes et quotas apparaîtront ici.</p></div>';
  }
  let left = limit;
  const groups = inboxGroups(items).map((g) => {
    const shown = g.items.slice(0, left);
    left -= shown.length;
    return { ...g, shown };
  }).filter((g) => g.shown.length > 0);
  const shownCount = groups.reduce((s, g) => s + g.shown.length, 0);
  const more = items.length - shownCount;
  return groups.map((g) => '<div class="adm-todo-g"><h4 class="adm-todo-gt">' + esc(g.label) + ' · ' + fmtInt(g.items.length) + '</h4>' +
    '<ul class="adm-todo-list">' + g.shown.map(todoItemHTML).join('') + '</ul></div>').join('') +
    (more > 0 ? '<p class="adm-dim adm-todo-more">' + fmtInt(more) + ' autre(s) élément(s) dans « À traiter ».</p>' : '');
}

function todoCardHTML(d) {
  const count = d && d.status === 'ready' ? fmtInt(d.value.total) + ' élément(s)' : '';
  return admCard('À traiter', loaded(d, (inb) => inboxHTML(inb, TODO_PREVIEW)), {
    desc: count, aside: '<button type="button" class="adm-link" data-adm-go="inbox">Tout voir</button>',
  });
}

function feedHTML(feed) {
  const rows = feedRows(feed);
  if (!rows.length) return empty('Aucun événement récent.');
  return '<ul class="adm-feed" aria-label="Derniers événements">' + rows.map((r) =>
    '<li><span class="adm-feed-t">' + esc(r.at) + '</span><span class="adm-feed-x">' +
    (r.target ? '<strong>' + esc(r.target) + '</strong> ' : '') + esc(r.label) + '</span></li>').join('') + '</ul>';
}

function liveCardHTML(d) {
  return admCard('En direct', loaded(d, (l) =>
    '<ul class="adm-live-counts" aria-label="Activité en direct">' +
    '<li><strong>' + fmtInt(l.online) + '</strong><span>en ligne</span></li>' +
    '<li><strong>' + fmtInt(l.watching) + '</strong><span>en lecture</span></li>' +
    '<li><strong>' + fmtInt(l.parties) + '</strong><span>watch parties</span></li></ul>' + feedHTML(l.feed)), {
    aside: '<span class="adm-live-tag"><i class="adm-dot" aria-hidden="true"></i>Live</span>',
  });
}

/** Carte d'indicateur : libellé, valeur, indication, variation (ton) facultative, mini-courbe facultative. */
function kpiCard(label, value, hint, delta, spark) {
  return '<li class="adm-kpi"><span class="adm-kpi-l">' + esc(label) + '</span><strong class="adm-kpi-v">' + esc(value) + '</strong>' +
    (hint ? '<span class="adm-kpi-h">' + esc(hint) + '</span>' : '') +
    (delta ? '<span class="adm-kpi-d is-' + delta.tone + '">' + esc(delta.text) + '</span>' : '') + (spark || '') + '</li>';
}

/** Chiffres clés : comptes (balayage) et trafic (métriques, courbes, variations). Chaque bloc garde son état. */
function kpisHTML(ov, tr) {
  const o = ov.status === 'ready' ? ov.value : null;
  const t = tr.status === 'ready' ? tr.value : null;
  const m = t && t.metrics ? summarize(t.metrics) : null;
  const pts = t && t.series && Array.isArray(t.series.points) ? t.series.points : [];
  const dl = t && t.series && t.series.deltas ? t.series.deltas : {};
  const name = RANGE_NAME[t ? t.range : dashRange] || '';
  const pending = (d) => (d.status === 'error' ? '—' : '…');
  const acc = (fn) => (o ? fn(o) : pending(ov));
  const accHint = (fn) => (o ? fn(o) : ov.status === 'error' ? 'Indisponible' : '');
  const traf = m ? null : pending(tr);
  const delta = (pct, goodWhenUp) => (pct == null || !Number.isFinite(pct) ? null : { text: fmtDelta(pct) + ' vs période précédente', tone: deltaTone(pct, goodWhenUp) });
  return '<ul class="adm-kpis adm-kpis-dash" aria-label="Indicateurs">' +
    kpiCard('Comptes', acc((x) => fmtInt(x.total)), accHint((x) => (x.suspended != null ? fmtInt(x.suspended) + ' suspendu(s)' : ''))) +
    kpiCard('Actifs 24 h', acc((x) => (x.truncated ? '≥ ' : '') + fmtInt(x.active24)), accHint((x) => (x.truncated ? 'sur les ' + fmtInt(x.scanned) + ' derniers comptes' : 'dernière activité sur 24 h'))) +
    kpiCard('Inscriptions 7 j', acc((x) => fmtInt(x.signups7)), accHint(() => 'nouveaux comptes')) +
    kpiCard('Requêtes / min', m ? fmtRate(m.rpm) : traf, m ? fmtInt(m.requests) + ' sur ' + name : '', m ? delta(dl.requests, true) : null,
      sparkline(pts.map((p) => p.requests), 'Requêtes par tranche, sur ' + name)) +
    kpiCard('Erreurs 5xx', m ? fmtPct(m.errorRate, 2) : traf, m ? 'réponses 5xx' : '', m ? delta(dl.errors5xx, false) : null,
      sparkline(pts.map((p) => (p.requests > 0 ? p.errors5xx / p.requests : 0)), 'Taux d’erreur 5xx, sur ' + name, 'is-bad')) +
    kpiCard('Latence p95', m ? fmtMs(m.p95) : traf, m ? 'médiane ' + fmtMs(m.p50) : '', m ? delta(dl.p95, false) : null,
      sparkline(pts.map((p) => p.p95), 'Latence p95, sur ' + name, 'is-alt')) +
    kpiCard('Salons actifs', acc((x) => (x.rooms != null ? fmtInt(x.rooms) : '—')), accHint((x) => (x.rooms == null ? 'indisponible' : ''))) +
    kpiCard('Signalements en attente', acc((x) => (x.reports != null ? fmtInt(x.reports) : '—')), accHint((x) => (x.reports == null ? 'indisponible' : ''))) +
    '</ul>';
}

/** Trafic et latence : deux courbes sur la période choisie, avec les mêmes chiffres en tableau ailleurs (KPI). */
function trafficHTML(d) {
  return loaded(d, (t) => {
    const name = RANGE_NAME[t.range] || t.range;
    const pts = t.series && Array.isArray(t.series.points) ? t.series.points : [];
    const labels = seriesLabels(pts, t.range);
    const notice = t.seriesErr ? '<p class="adm-banner" role="status">Courbes indisponibles : ' + esc(t.seriesErr) + '</p>' : '';
    const traffic = pts.length
      ? lineChart({
        series: [
          { name: 'Requêtes', values: pts.map((p) => p.requests), cls: 'adm-s1', area: true },
          { name: 'Erreurs 5xx', values: pts.map((p) => p.errors5xx), cls: 'adm-s4' },
        ],
        labels, yFmt: (v) => fmtInt(v), description: 'Requêtes et erreurs 5xx par tranche, sur ' + name,
      })
      : empty('Pas encore de série sur cette période.');
    const latency = pts.length
      ? lineChart({ series: [{ name: 'p95', values: pts.map((p) => p.p95), cls: 'adm-s2' }], labels, yFmt: (v) => fmtMs(v), description: 'Latence p95 par tranche, sur ' + name })
      : empty('Pas encore de série sur cette période.');
    return notice + '<div class="adm-grid2">' + admCard('Trafic et erreurs · ' + name, traffic) + admCard('Latence p95 · ' + name, latency) + '</div>';
  });
}

/** Tableau de bord : bandeau de maintenance, santé des services, « À traiter » et « En direct », chiffres clés, trafic. */
export function overviewHTML(S) {
  const at = (k) => S[k] || IDLE;
  const ov = at('ov');
  const updated = liveAt ? '<p class="adm-live" role="status">Dernier relevé « En direct » : ' + new Date(liveAt).toLocaleTimeString('fr-FR') + ' · actualisé toutes les 30 s.</p>' : '';
  return sectionHead('Tableau de bord', 'Ce qui demande ton attention, puis l’état du serveur en un coup d’œil.',
    '<div class="adm-head-tools"><div class="pills adm-ranges" role="group" aria-label="Période" data-nav>' + RANGES.map(([v, l]) => pill(v, l)).join('') + '</div>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button></div>') +
    (ov.status === 'ready' && ov.value.maintenance ? '<p class="adm-banner is-warn" role="status">Mode maintenance activé : seuls les administrateurs accèdent au serveur.</p>' : '') +
    updated + healthHTML(at('health')) +
    '<div class="adm-dash">' + todoCardHTML(at('inbox')) + liveCardHTML(at('live')) + '</div>' +
    kpisHTML(ov, at('traffic')) + trafficHTML(at('traffic'));
}

// ---------- Rendu : « À traiter » (page) ----------
export function inboxPageHTML(S) {
  return sectionHead('À traiter', 'Ce qui demande une action : signalements, alertes, quotas.',
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    loaded(S.inbox || IDLE, (inb) => admCard('Éléments', inboxHTML(inb), {
      desc: fmtInt(inb.total) + ' élément(s), par sévérité.',
    }));
}

// ---------- Actions : « Marquer vu », action propre à l'item ----------
const findItem = (ctx, key) => {
  const inb = ctx.S.inbox.value;
  return inb ? inb.items.find((i) => i.key === key) || null : null;
};

function focusHeading() {
  const h = document.getElementById('adm-h');
  if (h) h.focus({ preventScroll: true });
}

/** Retrait optimiste : l'item disparaît tout de suite, `dismissInbox` part ensuite ; en cas d'échec, il revient avec un message. */
async function markSeen(ctx, key) {
  const before = ctx.S.inbox;
  const beforeTodo = ctx.S.badges.todo;
  if (!before.value || !findItem(ctx, key)) return;
  const next = inboxWithout(before.value, key);
  ctx.S.inbox = { status: 'ready', value: next, error: '' };
  ctx.S.badges = { ...ctx.S.badges, todo: next.total };
  ctx.badges();
  ctx.paint();
  focusHeading();
  try {
    await api.dismissInbox(key);
  } catch (err) {
    ctx.S.inbox = before;
    ctx.S.badges = { ...ctx.S.badges, todo: beforeTodo };
    ctx.badges();
    ctx.paint();
    ctx.toast(adminErr(err));
  }
}

/** Action d'un item : relance de la TV (après confirmation), ou navigation vers la section de la route. */
async function runInboxAction(ctx, key) {
  const item = findItem(ctx, key);
  if (!item || !item.action) return;
  if (item.action.call === 'tv-rerun') {
    if (!(await confirmDialog({ title: 'Relancer la tâche TV', message: 'La mise à jour des chaînes va être relancée maintenant, en dehors de son horaire habituel.', confirmLabel: 'Relancer' }))) return;
    if (await attempt(() => api.rerunTv(), ctx.toast)) ctx.toast('Relance demandée.');
    return;
  }
  const sid = routeSection(item.action.route);
  if (!sid || !ctx.go(sid)) ctx.toast('Cette section n’est pas encore disponible.');
}

function bindInbox(root, ctx) {
  root.querySelectorAll('[data-adm-inbox-act]').forEach((b) => b.addEventListener('click', () => runInboxAction(ctx, b.dataset.admInboxAct)));
  root.querySelectorAll('[data-adm-inbox-seen]').forEach((b) => b.addEventListener('click', () => markSeen(ctx, b.dataset.admInboxSeen)));
}

function bindOverview(root, ctx) {
  root.querySelectorAll('[data-adm-dashrange]').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.admDashrange;
    if (r === dashRange) return;
    dashRange = r;
    ctx.fetch('traffic', () => fetchTraffic(dashRange), false);
  }));
  root.querySelectorAll('[data-adm-go]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); ctx.go(b.dataset.admGo); }));
  bindInbox(root, ctx);
  startLive(ctx);
}

export const pilotageSections = [
  { id: 'overview', group: 'pilotage', label: 'Tableau de bord', icon: 'grid', render: overviewHTML, bind: bindOverview, load: loadOverview },
  {
    id: 'inbox', group: 'pilotage', label: 'À traiter', icon: 'inbox', render: inboxPageHTML, bind: bindInbox,
    load: (ctx, quiet) => ctx.fetch('inbox', () => api.getInbox(), quiet),
  },
];
