/* Espace Plateforme : sources et addons (à venir), performance (1 h, 24 h, 7 j), caches et stockage (purge), tâches planifiées (TV). */
import * as api from '../../data/adminApi';
import { alldebridRows, fmtDateTime, fmtInt, fmtMs, fmtPct, fmtRate, groupRows, purgeList, purgeView, STATUS_KEYS, summarize, toMs, upstreamRows } from '../../data/adminModel';
import { lineChart, simpleBar, stackedBar } from '../admin-charts.js';
import { confirmDialog } from '../admin-dialog.js';
import { esc } from '../util.js';
import { admCard, attempt, empty, kpi, loaded, sectionHead, soonCard, soonPage, table } from './common.js';

// ---------- Performance ----------
const RANGES = [['1h', '1 heure'], ['24h', '24 heures'], ['7d', '7 jours']];
const rangeLabel = (r) => (RANGES.find((x) => x[0] === r) || [0, r])[1];

function timeLabels(series, range) {
  return series.map((s) => {
    const d = new Date(toMs(s.t));
    return range === '7d' ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  });
}

const PROVIDER_LABEL = new Map([['tmdb', 'TMDB'], ['tvdb', 'TVDB'], ['openrouter', 'OpenRouter'], ['cinemeta', 'Cinemeta'], ['mdblist', 'MDBList'], ['fanart', 'Fanart.tv']]);

/** Totaux 30 jours par fournisseur (`providers.totals`) ; carte absente si le serveur ne publie pas `providers`. */
function providersCard(m) {
  if (!m.providers) return '';
  const rows = m.providers.totals || [];
  return admCard('Appels par fournisseur', rows.length ? table('Appels par fournisseur', ['Fournisseur', { label: 'Appels', num: true }, { label: 'Mémoire', num: true }, { label: 'KV', num: true }, { label: 'Périmé', num: true }, { label: 'Jointes', num: true }, { label: 'Fiches R2', num: true }, { label: '304', num: true }, { label: 'Taux de hit', num: true }],
    rows.map((p) => ({ cells: [esc(PROVIDER_LABEL.get(p.provider) ?? p.provider), esc(fmtInt(p.calls)), esc(fmtInt(p.l1Hits)), esc(fmtInt(p.l2Hits)), esc(fmtInt(p.stale)), esc(fmtInt(p.coalesced)), esc(fmtInt(p.r2Hits)), esc(fmtInt(p.notModified)), esc(fmtPct(p.hitRate, 1))] }))) : empty('Aucun appel fournisseur sur les 30 derniers jours.'),
  { desc: '30 derniers jours (UTC), indépendants de la période choisie. Taux de hit : lectures servies sans appel sortant.' });
}

function upstreamsCard(m) {
  const rows = upstreamRows(m);
  return admCard('Santé des addons amont', rows.length ? table('Addons amont', ['Hôte', { label: 'Appels', num: true }, { label: 'Échecs', num: true }, { label: 'Timeouts', num: true }, { label: 'Latence moy.', num: true }],
    rows.map((u) => ({ cells: [esc(u.host), fmtInt(u.calls), fmtInt(u.failures) + (u.failures ? ' <span class="adm-dim">(' + fmtPct(u.failureRate, 0) + ')</span>' : ''), fmtInt(u.timeouts), fmtMs(u.avgMs)] }))) : empty('Aucun appel amont sur cette période.'),
  { desc: 'Un hôte par addon, sans chemin ni jeton.' });
}

function alldebridCard(m) {
  const rows = alldebridRows(m);
  return admCard('AllDebrid', rows.length ? table('Appels AllDebrid', ['Appel', { label: 'Succès', num: true }, { label: 'Erreurs', num: true }, { label: 'Taux de succès', num: true }, 'Codes d’erreur'],
    rows.map((r) => ({ cells: [esc(r.label), fmtInt(r.ok), fmtInt(r.errTotal), fmtPct(r.successRate, 1), r.errors.length ? r.errors.map((e) => '<code>' + esc(e.code) + '</code> × ' + fmtInt(e.n)).join(', ') : '—'] }))) : empty('Aucun appel AllDebrid sur cette période.'));
}

function errorsCard(m) {
  const errs = m.errors || [];
  return admCard('Dernières erreurs 5xx', errs.length ? table('Dernières erreurs', ['Quand', 'Route', { label: 'Statut', num: true }, 'Message'],
    errs.slice(0, 50).map((e) => ({ cells: [esc(fmtDateTime(e.at)), '<code>' + esc(e.route) + '</code>', esc(e.status), esc(e.message)] }))) : empty('Aucune erreur 5xx récente.'), { desc: '100 dernières au plus ; messages épurés par le serveur.' });
}

export function performanceHTML(S) {
  const picker = '<div class="pills adm-ranges" role="group" aria-label="Période" data-nav>' + RANGES.map(([v, l]) =>
    '<button type="button" class="pill" data-adm-range="' + v + '" data-adm-focus="range:' + v + '" aria-pressed="' + (S.range === v) + '">' + l + '</button>').join('') + '</div>';
  const upd = '<p class="adm-live" role="status">' + (S.updatedAt ? 'Mis à jour à ' + new Date(S.updatedAt).toLocaleTimeString('fr-FR') + ' · actualisation automatique toutes les 30 s (en pause si l’onglet est masqué).' : '') + '</p>';
  return sectionHead('Performance', 'Trafic, erreurs et latences du serveur.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') + picker + upd +
    loaded(S.perf, (m) => {
      const s = summarize(m);
      const series = m.series || [];
      const labels = timeLabels(series, m.range);
      const rows = groupRows(m);
      const maxReq = Math.max(1, ...rows.map((r) => r.requests));
      const maxLat = Math.max(1, ...rows.map((r) => r.p95));
      return '<ul class="adm-kpis is-compact" aria-label="Résumé">' + kpi('Requêtes', fmtInt(s.requests), fmtRate(s.rpm) + ' / min') + kpi('Erreurs 5xx', fmtPct(s.errorRate, 2), '') +
        kpi('p50', fmtMs(s.p50), '') + kpi('p95', fmtMs(s.p95), '') + '</ul>' +
        '<div class="adm-grid2">' +
        admCard('Requêtes dans le temps', lineChart({ series: [{ name: 'Requêtes', values: series.map((x) => x.requests), cls: 'adm-s1', area: true }, { name: 'Erreurs 5xx', values: series.map((x) => x.errors5xx), cls: 'adm-s4' }], labels, yFmt: (v) => fmtInt(v), description: 'Requêtes et erreurs 5xx par tranche, sur ' + rangeLabel(m.range) }), { desc: 'Tranches de ' + Math.round((m.stepSec || 300) / 60) + ' min.' }) +
        admCard('Latence p95', lineChart({ series: [{ name: 'p95', values: series.map((x) => x.p95), cls: 'adm-s2' }], labels, yFmt: (v) => fmtMs(v), description: 'Latence p95 par tranche, sur ' + rangeLabel(m.range) })) + '</div>' +
        admCard('Groupes de routes', (rows.length ? '<div class="adm-grid2 adm-bars">' +
          '<div><h4 class="adm-sub">Requêtes par groupe</h4><ul class="adm-hbars">' + rows.map((g) => '<li><span class="adm-hl">' + esc(g.label) + '</span>' + simpleBar(g.requests / maxReq, 'adm-s1', g.label + ' : ' + g.requests + ' requêtes') + '<span class="adm-hv">' + fmtInt(g.requests) + '</span></li>').join('') + '</ul></div>' +
          '<div><h4 class="adm-sub">Statuts</h4><ul class="adm-hbars">' + rows.map((g) => '<li><span class="adm-hl">' + esc(g.label) + '</span>' + stackedBar(STATUS_KEYS.map((k) => ({ value: g.status[k], cls: 'adm-st-' + k, label: k })), g.label + ' : ' + STATUS_KEYS.map((k) => g.status[k] + ' ' + k).join(', ')) + '<span class="adm-hv">' + fmtPct(g.errorRate, 1) + '</span></li>').join('') + '</ul>' +
          '<ul class="adm-legend" aria-hidden="true">' + STATUS_KEYS.map((k) => '<li><i class="adm-key adm-st-' + k + '"></i>' + k + '</li>').join('') + '</ul></div>' +
          '<div><h4 class="adm-sub">Latences p50 / p95</h4><ul class="adm-hbars is-pair">' + rows.map((g) => '<li><span class="adm-hl">' + esc(g.label) + '</span><span class="adm-pair">' + simpleBar(g.p50 / maxLat, 'adm-s3', 'p50 ' + fmtMs(g.p50)) + simpleBar(g.p95 / maxLat, 'adm-s2', 'p95 ' + fmtMs(g.p95)) + '</span><span class="adm-hv">' + fmtMs(g.p50) + ' · ' + fmtMs(g.p95) + '</span></li>').join('') + '</ul>' +
          '<ul class="adm-legend" aria-hidden="true"><li><i class="adm-key adm-s3"></i>p50</li><li><i class="adm-key adm-s2"></i>p95</li></ul></div></div>' : empty('Aucune requête sur cette période.')) +
          table('Détail par groupe de routes', ['Groupe', { label: 'Requêtes', num: true }, { label: '2xx', num: true }, { label: '3xx', num: true }, { label: '4xx', num: true }, { label: '5xx', num: true }, { label: 'p50', num: true }, { label: 'p95', num: true }],
            rows.map((g) => ({ cells: [esc(g.label), fmtInt(g.requests), fmtInt(g.status['2xx']), fmtInt(g.status['3xx']), fmtInt(g.status['4xx']), fmtInt(g.status['5xx']), fmtMs(g.p50), fmtMs(g.p95)] })))) +
        upstreamsCard(m) + providersCard(m) + alldebridCard(m) + errorsCard(m);
    });
}

function bindPerformance(root, ctx) {
  root.querySelectorAll('[data-adm-range]').forEach((b) => b.addEventListener('click', () => {
    ctx.S.range = b.dataset.admRange;
    ctx.refresh(false);
  }));
}

// ---------- Caches et stockage ----------
/** Liste des caches, puis reprise du suivi des purges encore en cours (prises en charge par cette vue). */
async function fetchCaches(ctx) {
  const r = await api.getCaches('24h');
  try {
    const jobs = purgeList(await api.getPurges());
    for (const j of jobs) if (j.status === 'running' && !ctx.S.purges[j.prefix]) { ctx.S.purges[j.prefix] = j; pollPurge(ctx, j.prefix, j.id); }
  } catch (_) { /* progression indisponible : la liste reste utile */ }
  return r;
}

async function pollPurge(ctx, prefix, id) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!ctx.alive()) return;
    let job;
    try { job = await api.getPurge(id); } catch (_) { continue; }
    ctx.S.purges[prefix] = job;
    if (ctx.isCurrent()) ctx.paint();
    if (job.status !== 'running') { if (ctx.isCurrent()) ctx.refresh(true); return; }
  }
}

async function purge(ctx, prefix) {
  if (!(await confirmDialog({ title: 'Vider le cache « ' + prefix + ' »', message: 'Toutes les entrées du cache <strong>' + esc(prefix) + '</strong> seront supprimées par lots, en arrière-plan. Les prochaines requêtes seront plus lentes le temps de le reconstituer.', confirmLabel: 'Vider le cache', danger: true }))) return;
  await attempt(async () => {
    const job = await api.purgeCache(prefix);
    ctx.S.purges[prefix] = job;
    ctx.paint();
    pollPurge(ctx, prefix, job.id);
  }, ctx.toast);
}

export function cachesHTML(S) {
  return sectionHead('Caches et stockage', 'Entrées gardées côté serveur. Vider un cache est sans danger mais ralentit les premières requêtes.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    loaded(S.caches, (r) => {
      if (!r.caches.length) return empty('Aucun cache.');
      return table('Caches', ['Préfixe', { label: 'Clés', num: true }, { label: 'Succès', num: true }, { label: 'Échecs', num: true }, { label: 'Taux de succès', num: true }, 'Purge'],
        r.caches.map((c) => {
          const job = S.purges[c.prefix];
          const v = job ? purgeView(job, c.keys) : null;
          const running = v && v.state === 'running';
          const prog = v ? '<div class="adm-purge is-' + v.state + '"><div class="adm-progress" role="progressbar" aria-label="Purge de ' + esc(c.prefix) + '" aria-valuemin="0" aria-valuemax="100"' + (v.pct !== null ? ' aria-valuenow="' + v.pct + '"' : '') + '><i style="width:' + (v.pct === null ? (running ? 40 : 100) : v.pct) + '%"' + (v.pct === null && running ? ' class="is-indet"' : '') + '></i></div><span class="adm-dim" role="status">' + esc(v.label) + '</span></div>' : '';
          return { cells: ['<code>' + esc(c.prefix) + '</code>', (c.exact ? '' : '≥ ') + fmtInt(c.keys), fmtInt(c.hits), fmtInt(c.misses), fmtPct(c.hitRate, 1),
            '<button type="button" class="btn btn-danger btn-sm" data-adm-purge="' + esc(c.prefix) + '"' + (running ? ' disabled' : '') + '>Vider</button>' + prog] };
        }));
    });
}

function bindCaches(root, ctx) {
  root.querySelectorAll('[data-adm-purge]').forEach((b) => b.addEventListener('click', () => purge(ctx, b.dataset.admPurge)));
}

// ---------- Tâches planifiées (TV) ----------
const CRON_LABELS = {
  at: 'Date', startedAt: 'Début', finishedAt: 'Fin', status: 'Statut', ok: 'Réussi', durationMs: 'Durée', channels: 'Chaînes',
  programmes: 'Programmes EPG', epgOk: 'EPG reconstruit', error: 'Erreur', count: 'Éléments',
};
function cronRows(v) {
  if (v == null) return [];
  if (typeof v !== 'object') return [['Dernier passage', Number.isFinite(toMs(v)) ? fmtDateTime(v) : String(v)]];
  return Object.entries(v).filter(([, x]) => x == null || typeof x !== 'object').map(([k, x]) => {
    const isDate = /(^|[a-z])(At|at|Date)$/.test(k) && Number.isFinite(toMs(x));
    return [CRON_LABELS[k] || k, k === 'durationMs' ? fmtMs(Number(x)) : isDate ? fmtDateTime(x) : typeof x === 'boolean' ? (x ? 'oui' : 'non') : typeof x === 'number' ? fmtInt(x) : String(x ?? '—')];
  });
}

export function tasksHTML(S) {
  return sectionHead('Tâches planifiées', 'Passages automatiques du serveur. La mise à jour des chaînes TV est la seule tâche suivie pour l’instant.') +
    loaded(S.tv, (r) => {
      const rows = cronRows(r.lastCron);
      return admCard('Dernier passage',
        (rows.length ? '<dl class="adm-dl">' + rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>' : empty('Aucun passage enregistré.')) +
        '<div class="set-actions"><button type="button" class="btn btn-primary btn-sm" data-adm-tvrerun>Relancer maintenant</button></div><p class="set-msg" id="adm-tv-msg" role="status"></p>',
        { desc: 'Mise à jour des chaînes TV.' });
    }) +
    soonCard('Autres tâches', 'Bientôt disponible : purges programmées et contrôles réguliers.');
}

async function tvRerun(root, ctx) {
  if (!(await confirmDialog({ title: 'Relancer la tâche TV', message: 'La mise à jour des chaînes va être relancée maintenant, en dehors de son horaire habituel.', confirmLabel: 'Relancer' }))) return;
  const say = (t) => { const m = root.querySelector('#adm-tv-msg'); if (m) m.textContent = t; };
  say('Relance en cours…');
  if (await attempt(() => api.rerunTv(), say)) {
    say('Relance demandée.');
    setTimeout(() => { if (ctx.isCurrent()) ctx.refresh(true); }, 2500);
  }
}

function bindTasks(root, ctx) {
  const btn = root.querySelector('[data-adm-tvrerun]');
  if (btn) btn.addEventListener('click', () => tvRerun(root, ctx));
}

export const platformSections = [
  { id: 'sources', group: 'platform', label: 'Sources et addons', icon: 'plug', render: () => soonPage('Sources et addons', 'Santé et réglages des addons amont et des fournisseurs.') },
  {
    id: 'performance', group: 'platform', label: 'Performance', icon: 'chart', render: performanceHTML, bind: bindPerformance,
    load: (ctx, quiet) => ctx.fetch('perf', () => api.getMetrics(ctx.S.range), quiet),
  },
  {
    id: 'caches', group: 'platform', label: 'Caches et stockage', icon: 'database', render: cachesHTML, bind: bindCaches,
    load: (ctx, quiet) => ctx.fetch('caches', () => fetchCaches(ctx), quiet),
  },
  {
    id: 'tasks', group: 'platform', label: 'Tâches planifiées', icon: 'clock', render: tasksHTML, bind: bindTasks,
    load: (ctx, quiet) => ctx.fetch('tv', () => api.getTv(), quiet),
  },
];
