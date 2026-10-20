/* Espace Pilotage : tableau de bord (chiffres clés des dernières 24 heures) et « À traiter » (à venir). */
import * as api from '../../data/adminApi';
import { ACCOUNT_PAGE_LIMIT, daysAgoIso, fmtInt, fmtMs, fmtPct, fmtRate, scanAccounts, summarize } from '../../data/adminModel';
import { sparkline } from '../admin-charts.js';
import { kpi, loaded, sectionHead, soonPage } from './common.js';

/** Données du tableau de bord : balayage des comptes, inscriptions, métriques, salons, signalements, maintenance. */
async function fetchOverview() {
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
}

/** Tableau de bord : huit chiffres clés, courbes sur 24 h quand le serveur les fournit, bandeau si la maintenance est active. */
export function overviewHTML(S) {
  return sectionHead('Tableau de bord', 'Chiffres clés des dernières 24 heures.',
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    loaded(S.ov, (o) => {
      const m = o.metrics ? summarize(o.metrics) : null;
      const series = o.metrics ? o.metrics.series || [] : [];
      const dash = '—';
      return '<ul class="adm-kpis" aria-label="Chiffres clés">' +
        kpi('Comptes', o.total != null ? fmtInt(o.total) : dash, o.suspended ? fmtInt(o.suspended) + ' suspendu(s)' : '') +
        kpi('Actifs 24 h', o.active24 != null ? (o.truncated ? '≥ ' : '') + fmtInt(o.active24) : dash, o.truncated ? 'sur les ' + fmtInt(o.scanned) + ' derniers comptes' : 'dernière activité') +
        kpi('Inscriptions 7 j', o.signups7 != null ? fmtInt(o.signups7) : dash, '') +
        kpi('Requêtes / min', m ? fmtRate(m.rpm) : dash, m ? fmtInt(m.requests) + ' sur 24 h' : '', m ? sparkline(series.map((s) => s.requests), 'Requêtes sur 24 heures') : '') +
        kpi('Taux d’erreur', m ? fmtPct(m.errorRate, 2) : dash, 'réponses 5xx', m ? sparkline(series.map((s) => (s.requests > 0 ? s.errors5xx / s.requests : 0)), 'Taux d’erreur sur 24 heures', 'is-bad') : '') +
        kpi('Latence p95', m ? fmtMs(m.p95) : dash, m ? 'médiane ' + fmtMs(m.p50) : '', m ? sparkline(series.map((s) => s.p95), 'Latence p95 sur 24 heures', 'is-alt') : '') +
        kpi('Salons actifs', o.rooms != null ? fmtInt(o.rooms) : dash, o.rooms == null ? 'indisponible' : '') +
        kpi('Signalements en attente', o.reports != null ? fmtInt(o.reports) : dash, o.reports == null ? 'indisponible' : '') + '</ul>' +
        (o.maintenance ? '<p class="adm-banner is-warn" role="status">Mode maintenance activé : seuls les administrateurs accèdent au serveur.</p>' : '');
    });
}

export const pilotageSections = [
  { id: 'overview', group: 'pilotage', label: 'Tableau de bord', icon: 'grid', render: overviewHTML, load: (ctx, quiet) => ctx.fetch('ov', fetchOverview, quiet) },
  { id: 'inbox', group: 'pilotage', label: 'À traiter', icon: 'inbox', render: () => soonPage('À traiter', 'Ce qui demande une action : signalements, alertes, quotas.') },
];
