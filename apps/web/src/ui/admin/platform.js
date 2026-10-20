/* Espace Plateforme : sources et addons (santé et test des fournisseurs amont, addons amont), performance (1 h, 24 h, 7 j),
 * caches et stockage (purge, KV, R2, base du Durable Object), tâches planifiées (cron TV, purges avec progression).
 * Les données passent par `loadInto` (view-state.js) ; l'état des tests de fournisseurs vit dans `ctx.S.providerTests`. */
import * as api from '../../data/adminApi';
import { alldebridRows, fmtAgo, fmtDateTime, fmtInt, fmtMs, fmtPct, groupRows, purgeList, purgeView, serviceStatusLabel, STATUS_KEYS, summarize, toMs, upstreamRows } from '../../data/adminModel';
import { UserApiError } from '../../data/userApi';
import '../../styles/admin-platform.css';
import { lineChart, simpleBar, stackedBar } from '../admin-charts.js';
import { confirmDialog } from '../admin-dialog.js';
import { esc } from '../util.js';
import { admCard, adminErr, attempt, badge, empty, kpi, loaded, sectionHead, table } from './common.js';
import { loadInto } from './view-state.js';

// ---------- Performance ----------
const RANGES = [['1h', '1 h', '1 heure'], ['24h', '24 h', '24 heures'], ['7d', '7 j', '7 jours']];
const rangeLabel = (r) => (RANGES.find((x) => x[0] === r) || [0, 0, r])[2];

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
  const picker = '<div class="adm-seg" role="group" aria-label="Période" data-nav>' + RANGES.map(([v, short]) =>
    '<button type="button" class="adm-seg-b" data-adm-range="' + v + '" data-adm-focus="range:' + v + '" aria-pressed="' + (S.range === v) + '">' + short + '</button>').join('') + '</div>';
  const upd = '<p class="adm-live" role="status">' + (S.updatedAt ? 'Mis à jour à ' + new Date(S.updatedAt).toLocaleTimeString('fr-FR') + ' · actualisation automatique toutes les 30 s (en pause si l’onglet est masqué).' : '') + '</p>';
  return sectionHead('Performance', 'Trafic, erreurs et latences du serveur.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    '<div class="adm-perf-bar">' + picker + upd + '</div>' +
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

function fmtRate(n) {
  return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('fr-FR');
}

function bindPerformance(root, ctx) {
  root.querySelectorAll('[data-adm-range]').forEach((b) => b.addEventListener('click', () => {
    ctx.S.range = b.dataset.admRange;
    ctx.refresh(false);
  }));
}

// ---------- Sources et addons ----------
const TEST_CONCURRENCY = 2;
const TEST_ERROR = { rejected: 'refusé par le fournisseur', http: 'erreur HTTP', timeout: 'délai dépassé', network: 'réseau injoignable' };
/** Classe de couleur selon l'état d'un fournisseur (les autres états restent neutres). */
const PROVIDER_KIND = { ok: 'ok', degraded: 'warn', down: 'bad' };

const providersOf = (S) => (S.providers && S.providers.status === 'ready' && S.providers.value && S.providers.value.providers) || [];
const testsOf = (S) => S.providerTests || { rows: {}, note: '' };
const isBusy = (t) => !!t && (t.state === 'queued' || t.state === 'running');

/** Identifiants testables qui ne sont pas déjà en cours de test. */
const testableIds = (S) => providersOf(S).filter((p) => p.testable && !isBusy(testsOf(S).rows[p.id])).map((p) => p.id);

/** Tracé d'une courbe 24 h (valeurs de 0 à 1, ou null). Un null coupe le tracé : une heure sans donnée n'est jamais interpolée. */
export function sparkPath(values, width = 100, height = 24) {
  const pts = Array.isArray(values) ? values : [];
  const n = pts.length;
  const ok = (i) => i >= 0 && i < n && typeof pts[i] === 'number' && Number.isFinite(pts[i]);
  const x = (i) => ((n > 1 ? (i * width) / (n - 1) : width / 2)).toFixed(2);
  const y = (i) => (height - 1 - Math.min(1, Math.max(0, pts[i])) * (height - 2)).toFixed(2);
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    if (!ok(i)) continue;
    if (ok(i - 1)) parts.push('L' + x(i) + ' ' + y(i));
    else parts.push('M' + x(i) + ' ' + y(i) + (ok(i + 1) ? '' : ' l0.01 0'));
  }
  return parts.join(' ');
}

function curveHTML(p) {
  const spark = Array.isArray(p.spark) ? p.spark : [];
  const known = spark.filter((v) => typeof v === 'number' && Number.isFinite(v)).length;
  if (!known) return '<span class="adm-dim">—</span>';
  const kind = PROVIDER_KIND[p.status] || 'unknown';
  return '<svg class="adm-curve is-' + kind + '" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="Taux de succès sur 24 h : ' + known + ' heure(s) avec données sur ' + spark.length + '">' +
    '<path class="adm-curve-l" d="' + sparkPath(spark) + '"></path></svg>';
}

function testButton(p, t) {
  const id = esc(p.id);
  return '<button type="button" class="btn btn-ghost btn-sm" data-adm-test="' + id + '" data-adm-focus="test:' + id + '"' + (isBusy(t) ? ' aria-busy="true"' : '') + (p.testable ? '' : ' disabled title="Pas de sonde configurée pour ce fournisseur sur ce serveur."') + '>Tester</button>';
}

function testNote(t) {
  if (!t) return '';
  switch (t.state) {
    case 'queued': return '<span class="adm-dim">En file d’attente…</span>';
    case 'running': return '<span class="adm-spin" aria-hidden="true"></span><span>Test en cours…</span>';
    case 'skipped': return '<span class="adm-dim">Non lancé : limite atteinte.</span>';
    case 'error': return '<span class="adm-test-r is-bad">' + esc(t.error) + '</span>';
    case 'done': {
      const r = t.result || {};
      const ms = fmtMs(r.latencyMs);
      if (r.ok) return '<span class="adm-test-r is-ok">OK · ' + esc(ms) + '</span>';
      const why = [r.status != null ? 'HTTP ' + r.status : '', TEST_ERROR[r.error] || r.error || ''].filter(Boolean).join(' · ');
      return '<span class="adm-test-r is-bad">Échec' + (why ? ' · ' + esc(why) : '') + ' · ' + esc(ms) + '</span>';
    }
    default: return '';
  }
}

export function sourcesHTML(S) {
  const pt = testsOf(S);
  const providers = providersOf(S);
  const busy = Object.values(pt.rows).some(isBusy);
  const all = '<button type="button" class="btn btn-primary btn-sm" data-adm-testall data-adm-focus="testall"' + (providers.some((p) => p.testable) ? '' : ' disabled') + (busy ? ' aria-busy="true"' : '') + '>Tester tout</button>';
  return sectionHead('Sources et addons', 'Santé de chaque fournisseur amont sur 24 h. « Tester » lance une vraie requête depuis le serveur.', all) +
    (pt.note ? '<p class="adm-live adm-note" role="status">' + esc(pt.note) + '</p>' : '') +
    loaded(S.providers, (r) => {
      const list = r.providers || [];
      return list.length ? table('Fournisseurs amont', ['Fournisseur', 'État', { label: 'Succès', num: true }, { label: 'p95', num: true }, '24 h', 'Dernier échec', 'Test'],
        list.map((p) => ({ cells: [
          esc(p.label),
          badge(serviceStatusLabel(p.status), PROVIDER_KIND[p.status]),
          esc(fmtPct(p.successRate, 1)),
          esc(fmtMs(p.p95)),
          curveHTML(p),
          esc(fmtDateTime(p.lastFailureAt)),
          '<div class="adm-test-cell">' + testButton(p, pt.rows[p.id]) + '<span class="adm-test" role="status">' + testNote(pt.rows[p.id]) + '</span></div>',
        ] })), 'is-sources') : empty('Aucun fournisseur amont.');
    }) +
    loaded(S.srcPerf, (m) => upstreamsCard(m));
}

/**
 * Teste des fournisseurs, deux à la fois. Un 429 arrête la série : les tests restants ne sont pas lancés et le message
 * dit de réessayer plus tard. `runner` est `api.testProvider` sauf en test.
 */
export async function runProviderTests(ctx, ids, runner = api.testProvider) {
  const pt = ctx.S.providerTests || (ctx.S.providerTests = { rows: {}, note: '' });
  const repaint = () => { if (ctx.isCurrent()) ctx.paint(); };
  const queue = [...ids];
  pt.note = '';
  for (const id of queue) pt.rows[id] = { state: 'queued' };
  repaint();
  let stopped = false;
  const worker = async () => {
    while (!stopped && queue.length) {
      const id = queue.shift();
      pt.rows[id] = { state: 'running' };
      repaint();
      try {
        pt.rows[id] = { state: 'done', result: await runner(id) };
      } catch (err) {
        pt.rows[id] = { state: 'error', error: adminErr(err) };
        if (err instanceof UserApiError && err.status === 429) {
          stopped = true;
          const rest = queue.splice(0);
          for (const r of rest) pt.rows[r] = { state: 'skipped' };
          if (rest.length) pt.note = 'Limite de tests atteinte : les tests restants ne sont pas lancés. ' + adminErr(err);
        }
      }
      repaint();
    }
  };
  await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, worker));
  repaint();
}

function bindSources(root, ctx) {
  root.querySelectorAll('[data-adm-test]').forEach((b) => b.addEventListener('click', () => {
    if (isBusy(testsOf(ctx.S).rows[b.dataset.admTest])) return;
    runProviderTests(ctx, [b.dataset.admTest]);
  }));
  const all = root.querySelector('[data-adm-testall]');
  if (all) all.addEventListener('click', () => {
    const ids = testableIds(ctx.S);
    if (ids.length) runProviderTests(ctx, ids);
  });
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

const UNKNOWN = 'indisponible';

/** Taille lisible (octets, Ko, Mo…) ; « indisponible » quand la valeur manque. */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1024) return fmtInt(n) + ' o';
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return v.toFixed(v < 10 ? 1 : 0).replace('.', ',') + ' ' + units[i];
}

const R2_LABEL = { TV: 'TV', META: 'Méta', AVATARS: 'Avatars' };
const approx = (truncated) => (truncated ? '≥ ' : '');

function kvCard(kv) {
  const rows = kv && Array.isArray(kv.prefixes) ? kv.prefixes : [];
  return admCard('Cache KV', rows.length ? table('Cache KV par préfixe', ['Préfixe', { label: 'Clés', num: true }, { label: 'Taux de succès', num: true }],
    rows.map((x) => ({ cells: ['<code>' + esc(x.prefix) + '</code>', esc((x.exact ? '' : '≥ ') + fmtInt(x.keys)), esc(fmtPct(x.hitRate, 1))] }))) : empty('Aucun préfixe en cache.'),
  { desc: 'Clés par préfixe ; « ≥ » quand le décompte est partiel.' });
}

function r2Card(list) {
  const rows = Array.isArray(list) ? list : [];
  return admCard('Buckets R2', rows.length ? table('Buckets R2', ['Bucket', { label: 'Objets', num: true }, { label: 'Taille', num: true }],
    rows.map((b) => ({ cells: [
      esc('R2 · ' + (R2_LABEL[b.bucket] || b.bucket)),
      esc(b.objects == null ? UNKNOWN : approx(b.truncated) + fmtInt(b.objects)),
      esc(b.bytes == null ? UNKNOWN : approx(b.truncated) + fmtBytes(b.bytes)),
    ] }))) : empty('Aucun bucket R2.'),
  { desc: 'Objets et volume par bucket ; « ≥ » quand le total est partiel.' });
}

function doCard(d) {
  const tables = d && Array.isArray(d.tables) ? d.tables : [];
  return admCard('Base du Durable Object', '<dl class="adm-dl"><div><dt>Taille</dt><dd>' + esc(fmtBytes(d ? d.sizeBytes : null)) + '</dd></div></dl>' +
    (tables.length ? table('Lignes par table', ['Table', { label: 'Lignes', num: true }],
      tables.map((t) => ({ cells: ['<code>' + esc(t.name) + '</code>', esc(t.rows == null ? UNKNOWN : fmtInt(t.rows))] }))) : empty('Aucune table.')),
  { desc: 'Taille de la base SQLite et lignes par table.' });
}

/** Stockage : KV, R2 et base du Durable Object, avec l'âge de la mesure (le serveur la garde 5 minutes). */
function storageHTML(d) {
  return '<h3 class="adm-sec-t">Stockage</h3>' + loaded(d, (r) => {
    const updated = Number.isFinite(toMs(r.cachedAt)) ? 'Mis à jour ' + fmtAgo(r.cachedAt) : 'Date de mise à jour inconnue';
    return '<p class="adm-live" role="status">' + esc(updated) + '</p><div class="adm-grid2">' + kvCard(r.kv) + r2Card(r.r2) + doCard(r.do) + '</div>';
  });
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
    }) + storageHTML(S.storage);
}

function bindCaches(root, ctx) {
  root.querySelectorAll('[data-adm-purge]').forEach((b) => b.addEventListener('click', () => purge(ctx, b.dataset.admPurge)));
}

// ---------- Tâches planifiées (TV, purges) ----------
const TASKS_POLL_MS = 5000;
let tasksTimer = 0;

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

/** Avancement d'une purge : pourcentage si la progression est connue (0 à 1), sinon indéterminé (null). */
export function jobView(job) {
  if (job.status === 'done') return { kind: 'ok', pct: 100, label: 'Terminée' };
  if (job.status === 'failed') return { kind: 'bad', pct: null, label: 'Échec' + (job.error ? ' : ' + job.error : '') };
  const p = typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.round(Math.min(1, Math.max(0, job.progress)) * 100) : null;
  return { kind: '', pct: p, label: p === null ? 'En cours…' : 'En cours · ' + p + ' %' };
}

const hasRunningPurge = (d) => !!d && d.status === 'ready' && !!d.value && (d.value.purges || []).some((j) => j.status === 'running');

/** Rafraîchit les tâches toutes les 5 s tant qu'une purge tourne ; s'arrête dès que la section n'est plus affichée. */
export function syncTasksPoll(ctx) {
  if (tasksTimer) { clearTimeout(tasksTimer); tasksTimer = 0; }
  if (!ctx.isCurrent() || !hasRunningPurge(ctx.S.tasks)) return;
  tasksTimer = setTimeout(() => {
    tasksTimer = 0;
    if (!ctx.isCurrent()) return;
    loadInto(ctx, 'tasks', () => api.getTasks(), true).then(() => syncTasksPoll(ctx));
  }, TASKS_POLL_MS);
}

function tvCard(lastCron, tv) {
  const rows = cronRows(lastCron);
  const items = rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>');
  if (tv && tv.nextRunAt) items.push('<div><dt>Prochain passage</dt><dd>' + esc(fmtDateTime(tv.nextRunAt)) + '</dd></div>');
  return admCard('Dernier passage',
    (items.length ? '<dl class="adm-dl">' + items.join('') + '</dl>' : '') + (rows.length ? '' : empty('Aucun passage enregistré.')) +
    '<div class="set-actions"><button type="button" class="btn btn-primary btn-sm" data-adm-tvrerun>Relancer maintenant</button></div><p class="set-msg" id="adm-tv-msg" role="status"></p>',
  { desc: 'Mise à jour des chaînes TV.', aside: tv && tv.overdue ? badge('En retard', 'warn') : '' });
}

function purgesCard(d) {
  return admCard('Purges de cache', loaded(d, (r) => {
    const jobs = r.purges || [];
    if (!jobs.length) return empty('Aucune purge récente.');
    return table('Purges de cache', ['Préfixe', 'Statut', 'Progression', { label: 'Clés supprimées', num: true }, 'Démarrée'],
      jobs.map((j) => {
        const v = jobView(j);
        const bar = '<div class="adm-progress" role="progressbar" aria-label="Purge de ' + esc(j.prefix) + '" aria-valuemin="0" aria-valuemax="100"' + (v.pct !== null ? ' aria-valuenow="' + v.pct + '"' : '') + '><i style="width:' + (v.pct === null ? (j.status === 'running' ? 40 : 100) : v.pct) + '%"' + (v.pct === null && j.status === 'running' ? ' class="is-indet"' : '') + '></i></div>';
        return { cells: ['<code>' + esc(j.prefix) + '</code>', badge(v.label, v.kind), '<div class="adm-prog-cell">' + bar + '</div>', esc(fmtInt(j.deleted)), esc(fmtDateTime(j.startedAt))] };
      }), 'is-jobs');
  }), { desc: 'Suivi des purges ; actualisé toutes les 5 s pendant qu’une purge tourne.' });
}

export function tasksHTML(S) {
  const tasks = S.tasks && S.tasks.status === 'ready' ? S.tasks.value : null;
  return sectionHead('Tâches planifiées', 'Passages automatiques du serveur et purges de cache.') +
    loaded(S.tv, (r) => tvCard(r.lastCron, tasks && tasks.tv)) +
    purgesCard(S.tasks);
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
  syncTasksPoll(ctx);
}

export const platformSections = [
  {
    id: 'sources', group: 'platform', label: 'Sources et addons', icon: 'plug', render: sourcesHTML, bind: bindSources,
    load: (ctx, quiet) => Promise.all([
      loadInto(ctx, 'providers', () => api.listProviders(), quiet),
      loadInto(ctx, 'srcPerf', () => api.getMetrics('24h'), quiet),
    ]),
  },
  {
    id: 'performance', group: 'platform', label: 'Performance', icon: 'chart', render: performanceHTML, bind: bindPerformance,
    load: (ctx, quiet) => ctx.fetch('perf', () => api.getMetrics(ctx.S.range), quiet),
  },
  {
    id: 'caches', group: 'platform', label: 'Caches et stockage', icon: 'database', render: cachesHTML, bind: bindCaches,
    load: (ctx, quiet) => Promise.all([
      loadInto(ctx, 'caches', () => fetchCaches(ctx), quiet),
      loadInto(ctx, 'storage', () => api.getStorage(), quiet),
    ]),
  },
  {
    id: 'tasks', group: 'platform', label: 'Tâches planifiées', icon: 'clock', render: tasksHTML, bind: bindTasks,
    load: (ctx, quiet) => Promise.all([
      loadInto(ctx, 'tv', () => api.getTv(), quiet),
      loadInto(ctx, 'tasks', () => api.getTasks(), quiet),
    ]),
  },
];
