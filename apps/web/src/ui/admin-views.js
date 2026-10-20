/* Rendu HTML des sections de la console d'administration (#/admin). Fonctions pures : état -> chaîne.
 * Composants des Réglages (settings-ui.js) : cartes, lignes, interrupteurs. Les comportements sont dans admin.js. */
import { UserApiError } from '../data/userApi';
import {
  alldebridRows, countDescendants, fmtAgo, fmtDateTime, fmtDay, fmtInt, fmtMs, fmtPct, fmtRate, groupRows, purgeView, STATUS_KEYS,
  summarize, toMs, treeDepth, upstreamRows,
} from '../data/adminModel';
import { lineChart, simpleBar, sparkline, stackedBar } from './admin-charts.js';
import { card, fieldRow, switchRow } from './settings-ui.js';
import { esc } from './util.js';

export const SECTIONS = [
  { id: 'overview', label: 'Vue d’ensemble', icon: 'grid' },
  { id: 'accounts', label: 'Comptes', icon: 'users' },
  { id: 'referrals', label: 'Parrainages', icon: 'tree' },
  { id: 'performance', label: 'Performance', icon: 'chart' },
  { id: 'caches', label: 'Caches', icon: 'database' },
  { id: 'tv', label: 'TV', icon: 'tv' },
  { id: 'parties', label: 'Watch parties', icon: 'party' },
  { id: 'moderation', label: 'Modération', icon: 'flag' },
  { id: 'settings', label: 'Réglages du serveur', icon: 'sliders' },
  { id: 'audit', label: 'Journal', icon: 'scroll' },
];

/** Message FR d'une erreur de l'API d'administration. */
export function adminErr(err) {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  if (err.status === 0 && err.code === 'cancelled') return 'Action annulée.';
  switch (err.code) {
    case 'network': return 'Serveur injoignable.';
    case 'unauthorized': return 'Session expirée : reconnecte-toi.';
    case 'owner_only': return 'Réservé au propriétaire du serveur.';
    case 'kid_profile': return 'Indisponible depuis un profil enfant.';
    case 'pin_required': return 'Déverrouille d’abord ton profil (code PIN).';
    case 'profile_invalid': return 'Profil actif invalide : change de profil.';
    case 'rate_limited': return 'Trop de requêtes.' + (err.retryAfterSec ? ' Réessaie dans ' + err.retryAfterSec + ' s.' : '');
    case 'invalid_password': return 'Mot de passe incorrect.';
    case 'elevation_required': case 'elevation_expired': return 'Ré-authentification nécessaire.';
    case 'cannot_target_owner': return 'Le propriétaire ne peut être ni suspendu ni supprimé.';
    case 'report_closed': return 'Ce signalement est déjà traité.';
    case 'unknown_cache': return 'Cache inconnu.';
    case 'cache_admin_unavailable': return 'Administration des caches indisponible sur ce serveur (mode Node).';
    case 'tv_admin_unavailable': return 'L’API TV n’est pas encore branchée sur ce serveur.';
    case 'party_unavailable': return 'Watch parties indisponibles sur ce serveur (mode Node).';
    case 'not_found': return 'Introuvable.';
    default: return err.status === 501 ? 'Fonction indisponible sur ce serveur.' : 'Erreur (' + err.code + ').';
  }
}

// ---------- Briques ----------
const badge = (text, kind) => '<span class="adm-badge' + (kind ? ' is-' + kind : '') + '">' + esc(text) + '</span>';
const empty = (text) => '<p class="adm-empty" role="status">' + esc(text) + '</p>';

/** Contenu d'une donnée chargée : chargement, erreur (avec réessai) ou rendu. */
export function loaded(d, render) {
  if (!d || d.status === 'idle' || d.status === 'loading') return '<p class="adm-empty" role="status">Chargement…</p>';
  if (d.status === 'error') return '<div class="adm-error" role="alert"><span>' + esc(d.error) + '</span><button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Réessayer</button></div>';
  return render(d.value);
}

function table(caption, heads, rows, cls) {
  if (!rows.length) return '';
  return '<div class="adm-table-wrap ' + (cls || '') + '" role="region" aria-label="' + esc(caption) + '" tabindex="0"><table class="adm-table"><caption class="sr-only">' + esc(caption) + '</caption><thead><tr>' +
    heads.map((h) => '<th scope="col"' + (h.num ? ' class="is-num"' : '') + '>' + esc(h.label || h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr' + (r.attrs ? ' ' + r.attrs : '') + '>' + r.cells.map((c, i) => {
      const h = heads[i];
      return '<td data-label="' + esc(h.label || h) + '"' + (h.num ? ' class="is-num"' : '') + '>' + c + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table></div>';
}

const sectionHead = (title, desc, aside) =>
  '<header class="adm-head"><div><h2 id="adm-h" tabindex="-1">' + esc(title) + '</h2>' + (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' + (aside || '') + '</header>';

// ---------- Vue d'ensemble ----------
function kpi(label, value, hint, spark) {
  return '<li class="adm-kpi"><span class="adm-kpi-l">' + esc(label) + '</span><strong class="adm-kpi-v">' + value + '</strong>' +
    (hint ? '<span class="adm-kpi-h">' + esc(hint) + '</span>' : '') + (spark || '') + '</li>';
}

export function overviewHTML(S) {
  return sectionHead('Vue d’ensemble', 'Chiffres clés des dernières 24 heures.',
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

// ---------- Comptes ----------
const statusBadge = (s) => (s === 'suspended' ? badge('Suspendu', 'warn') : badge('Actif', 'ok'));

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

export function pager(id, hasPrev, hasNext) {
  return '<nav class="adm-pager" aria-label="Pagination" data-nav><button type="button" class="btn btn-ghost btn-sm" data-adm-page="' + id + ':prev"' + (hasPrev ? '' : ' disabled') + '>← Précédent</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-page="' + id + ':next"' + (hasNext ? '' : ' disabled') + '>Suivant →</button></nav>';
}

/** Contenu du panneau latéral d'un compte. `link` : dernier lien de réinitialisation généré (affiché une seule fois). */
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

// ---------- Parrainages ----------
function nodeHTML(n) {
  const kids = n.children || [];
  const n2 = countDescendants(n);
  const head = '<span class="adm-node"><button type="button" class="adm-link" data-adm-acc="' + esc(n.id) + '" data-nav>' + esc(n.username) + '</button>' +
    (n.status === 'suspended' ? ' ' + badge('Suspendu', 'warn') : '') + ' <span class="adm-dim">' + esc(fmtDay(n.createdAt)) + (n2 ? ' · ' + n2 + ' filleul' + (n2 > 1 ? 's' : '') : '') + '</span></span>';
  if (!kids.length) return '<li class="adm-leaf">' + head + '</li>';
  return '<li><details open><summary>' + head + '</summary><ul class="adm-tree" role="group">' + kids.map(nodeHTML).join('') + '</ul></details></li>';
}

export function referralsHTML(S) {
  return sectionHead('Parrainages', 'Qui a invité qui. Les branches se replient.') +
    loaded(S.ref, (r) => (!r.roots.length ? empty('Aucun compte.') :
      '<p class="adm-count" role="status">' + fmtInt(r.total) + ' compte' + (r.total > 1 ? 's' : '') + ' · profondeur ' + treeDepth(r.roots) + (r.truncated ? ' · arbre tronqué par le serveur' : '') + '</p>' +
      '<ul class="adm-tree is-root" role="tree" aria-label="Arbre de parrainage">' + r.roots.map(nodeHTML).join('') + '</ul>'));
}

// ---------- Performance ----------
const RANGES = [['1h', '1 heure'], ['24h', '24 heures'], ['7d', '7 jours']];
const rangeLabel = (r) => (RANGES.find((x) => x[0] === r) || [0, r])[1];

function timeLabels(series, range) {
  return series.map((s) => {
    const d = new Date(toMs(s.t));
    return range === '7d' ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  });
}

export function performanceHTML(S) {
  const picker = '<div class="pills adm-ranges" role="group" aria-label="Période" data-nav>' + RANGES.map(([v, l]) =>
    '<button type="button" class="pill" data-adm-range="' + v + '" aria-pressed="' + (S.range === v) + '">' + l + '</button>').join('') + '</div>';
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
        card('Requêtes dans le temps', lineChart({ series: [{ name: 'Requêtes', values: series.map((x) => x.requests), cls: 'adm-s1', area: true }, { name: 'Erreurs 5xx', values: series.map((x) => x.errors5xx), cls: 'adm-s4' }], labels, yFmt: (v) => fmtInt(v), description: 'Requêtes et erreurs 5xx par tranche, sur ' + rangeLabel(m.range) }), { desc: 'Tranches de ' + Math.round((m.stepSec || 300) / 60) + ' min.' }) +
        card('Latence p95', lineChart({ series: [{ name: 'p95', values: series.map((x) => x.p95), cls: 'adm-s2' }], labels, yFmt: (v) => fmtMs(v), description: 'Latence p95 par tranche, sur ' + rangeLabel(m.range) })) + '</div>' +
        card('Groupes de routes', (rows.length ? '<div class="adm-grid2 adm-bars">' +
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

function upstreamsCard(m) {
  const rows = upstreamRows(m);
  return card('Santé des addons amont', rows.length ? table('Addons amont', ['Hôte', { label: 'Appels', num: true }, { label: 'Échecs', num: true }, { label: 'Timeouts', num: true }, { label: 'Latence moy.', num: true }],
    rows.map((u) => ({ cells: [esc(u.host), fmtInt(u.calls), fmtInt(u.failures) + (u.failures ? ' <span class="adm-dim">(' + fmtPct(u.failureRate, 0) + ')</span>' : ''), fmtInt(u.timeouts), fmtMs(u.avgMs)] }))) : empty('Aucun appel amont sur cette période.'),
  { desc: 'Un hôte par addon, sans chemin ni jeton.' });
}

const PROVIDER_LABEL = new Map([['tmdb', 'TMDB'], ['tvdb', 'TVDB'], ['openrouter', 'OpenRouter'], ['cinemeta', 'Cinemeta'], ['mdblist', 'MDBList'], ['fanart', 'Fanart.tv']]);

/** Totaux 30 jours par fournisseur (`providers.totals`) ; carte absente si le serveur ne publie pas `providers`. */
function providersCard(m) {
  if (!m.providers) return '';
  const rows = m.providers.totals || [];
  return card('Appels par fournisseur', rows.length ? table('Appels par fournisseur', ['Fournisseur', { label: 'Appels', num: true }, { label: 'Mémoire', num: true }, { label: 'KV', num: true }, { label: 'Périmé', num: true }, { label: 'Jointes', num: true }, { label: 'Fiches R2', num: true }, { label: '304', num: true }, { label: 'Taux de hit', num: true }],
    rows.map((p) => ({ cells: [esc(PROVIDER_LABEL.get(p.provider) ?? p.provider), esc(fmtInt(p.calls)), esc(fmtInt(p.l1Hits)), esc(fmtInt(p.l2Hits)), esc(fmtInt(p.stale)), esc(fmtInt(p.coalesced)), esc(fmtInt(p.r2Hits)), esc(fmtInt(p.notModified)), esc(fmtPct(p.hitRate, 1))] }))) : empty('Aucun appel fournisseur sur les 30 derniers jours.'),
  { desc: '30 derniers jours (UTC), indépendants de la période choisie. Taux de hit : lectures servies sans appel sortant.' });
}

function alldebridCard(m) {
  const rows = alldebridRows(m);
  return card('AllDebrid', rows.length ? table('Appels AllDebrid', ['Appel', { label: 'Succès', num: true }, { label: 'Erreurs', num: true }, { label: 'Taux de succès', num: true }, 'Codes d’erreur'],
    rows.map((r) => ({ cells: [esc(r.label), fmtInt(r.ok), fmtInt(r.errTotal), fmtPct(r.successRate, 1), r.errors.length ? r.errors.map((e) => '<code>' + esc(e.code) + '</code> × ' + fmtInt(e.n)).join(', ') : '—'] }))) : empty('Aucun appel AllDebrid sur cette période.'));
}

function errorsCard(m) {
  const errs = m.errors || [];
  return card('Dernières erreurs 5xx', errs.length ? table('Dernières erreurs', ['Quand', 'Route', { label: 'Statut', num: true }, 'Message'],
    errs.slice(0, 50).map((e) => ({ cells: [esc(fmtDateTime(e.at)), '<code>' + esc(e.route) + '</code>', esc(e.status), esc(e.message)] }))) : empty('Aucune erreur 5xx récente.'), { desc: '100 dernières au plus ; messages épurés par le serveur.' });
}

// ---------- Caches ----------
export function cachesHTML(S) {
  return sectionHead('Caches', 'Entrées gardées côté serveur. Vider un cache est sans danger mais ralentit les premières requêtes.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
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

// ---------- TV ----------
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

export function tvHTML(S) {
  return sectionHead('TV', 'Dernière exécution de la tâche planifiée qui met à jour les chaînes.') +
    loaded(S.tv, (r) => {
      const rows = cronRows(r.lastCron);
      return card('Dernier passage', (rows.length ? '<dl class="adm-dl">' + rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>' : empty('Aucun passage enregistré.')) +
        '<div class="set-actions"><button type="button" class="btn btn-primary btn-sm" data-adm-tvrerun>Relancer maintenant</button></div><p class="set-msg" id="adm-tv-msg" role="status"></p>');
    });
}

// ---------- Watch parties ----------
export function partiesHTML(S) {
  return sectionHead('Watch parties', 'Salons ouverts en ce moment, privés compris.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    loaded(S.rooms, (r) => (!r.rooms.length ? empty('Aucun salon actif.') :
      table('Salons actifs', ['Titre', 'Hôte', { label: 'Participants', num: true }, 'Visibilité', 'Ouvert', 'Action'],
        r.rooms.map((x) => ({ cells: [esc(x.title || x.id), esc(x.host), fmtInt(x.participants) + (x.maxParticipants ? ' / ' + fmtInt(x.maxParticipants) : ''),
          x.visibility === 'public' ? badge('Public', 'ok') : badge('Privé'), esc(fmtAgo(x.createdAt)),
          '<button type="button" class="btn btn-danger btn-sm" data-adm-closeroom="' + esc(x.id) + '" data-title="' + esc(x.title || x.id) + '">Fermer</button>'] })))));
}

// ---------- Modération ----------
const REPORT_TABS = [['open', 'À traiter'], ['deleted', 'Supprimés'], ['suspended', 'Auteur suspendu'], ['ignored', 'Ignorés']];

export function moderationHTML(S) {
  const tabs = '<div class="pills" role="group" aria-label="Statut des signalements" data-nav>' + REPORT_TABS.map(([v, l]) =>
    '<button type="button" class="pill" data-adm-repstatus="' + v + '" aria-pressed="' + (S.repStatus === v) + '">' + l + '</button>').join('') + '</div>';
  return sectionHead('Modération', 'Messages de salon signalés par les participants.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') + tabs +
    loaded(S.reports, (r) => (!r.reports.length ? empty('Aucun signalement dans cette liste.') :
      '<ul class="adm-reports">' + r.reports.map((x) => '<li class="adm-report" data-nav><div class="adm-report-h"><strong>' + esc(x.against || 'auteur inconnu') + '</strong> ' +
        '<span class="adm-dim">signalé par ' + esc(x.by || '?') + ' · ' + esc(fmtAgo(x.at)) + (x.reason ? ' · motif : ' + esc(x.reason) : '') + '</span></div>' +
        '<blockquote class="adm-quote">' + (x.text ? esc(x.text) : '<em>Message indisponible</em>') + '</blockquote>' +
        '<p class="adm-dim">Salon <code>' + esc(x.roomId) + '</code> · message <code>' + esc(x.messageId) + '</code></p>' +
        (x.status === 'open' ? '<div class="adm-actions"><button type="button" class="btn btn-ghost btn-sm" data-adm-rep="' + esc(x.id) + ':delete">Supprimer le message</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-adm-rep="' + esc(x.id) + ':suspend" data-who="' + esc(x.against) + '">Suspendre l’auteur</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-adm-rep="' + esc(x.id) + ':ignore">Ignorer</button></div>' : '<p>' + badge(x.status) + '</p>') + '</li>').join('') + '</ul>'));
}

// ---------- Réglages du serveur ----------
export function settingsHTML(S) {
  return sectionHead('Réglages du serveur', 'Ces réglages s’appliquent à tout le serveur et à tous les comptes.') +
    loaded(S.settings, (s) =>
      '<form id="adm-settings" class="set-form" autocomplete="off">' +
      '<p class="adm-banner is-warn" role="note"><strong>Attention.</strong> Fermer les inscriptions bloque les nouveaux comptes (les liens ne sont pas consommés). Activer la maintenance fait répondre « 503 » à tout le monde sauf toi : tous les utilisateurs perdent l’accès tant qu’elle est active.</p>' +
      card('Inscriptions', fieldRow('Quota par défaut', 'Nombre de liens d’invitation donné aux nouveaux comptes (0 à 100). Les comptes existants gardent le leur.', (id) => '<input class="set-input set-input-sm" id="' + id + '" type="number" name="quota" min="0" max="100" value="' + esc(s.inviteDefaultQuota) + '" required>') +
        switchRow('Inscriptions par invitation ouvertes', 'Désactivé : les liens d’invitation sont refusés.', !!s.invitesOpen, 'name="invitesOpen"')) +
      card('Mode maintenance', switchRow('Activer la maintenance', 'Le serveur répond 503 à tous sauf à l’administration. Exige ton mot de passe.', !!s.maintenance.enabled, 'name="maintenance"') +
        fieldRow('Message affiché', 'Montré aux utilisateurs pendant la maintenance.', (id) => '<textarea class="set-input adm-textarea" id="' + id + '" name="message" rows="3" maxlength="300">' + esc(s.maintenance.message || '') + '</textarea>', { stack: true }),
      { aside: s.maintenance.enabled ? badge('Maintenance active', 'warn') : '' }) +
      '<p class="set-msg" id="adm-settings-msg" role="status"></p><div class="set-actions"><button type="submit" class="btn btn-primary">Enregistrer</button></div></form>');
}

// ---------- Journal ----------
export function auditHTML(S) {
  const filter = '<form class="adm-toolbar" data-adm-auditform data-nav><label class="adm-field adm-grow"><span class="sr-only">Filtrer par action</span><input class="set-input" name="action" value="' + esc(S.auditAction) + '" placeholder="Filtrer par action (ex. elevate.failed)" autocomplete="off" autocapitalize="none"></label><button type="submit" class="btn btn-ghost btn-sm">Filtrer</button></form>';
  return sectionHead('Journal d’audit', 'Toutes les actions d’administration, y compris les ré-authentifications échouées. Jamais de mot de passe ni de jeton.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') + filter +
    loaded(S.audit, (r) => (!r.entries.length ? empty('Aucune entrée.') :
      table('Journal d’audit', ['Date', 'Acteur', 'Action', 'Cible', 'Détail'],
        r.entries.map((e) => ({ cells: [esc(fmtDateTime(e.at)), esc(e.actor), '<code>' + esc(e.action) + '</code>', esc(e.target || '—'), esc(detailText(e.detail))] })), 'is-audit') +
      pager('audit', S.auditPager.hasPrev, !!r.nextBefore)));
}

function detailText(d) {
  if (d == null || d === '') return '—';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch (_) { return '—'; }
}
