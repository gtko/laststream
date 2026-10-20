/* Briques communes aux sections de la console d'administration : libellés d'erreur, états de chargement, tableaux, cartes,
 * pagination, icônes. Fonctions pures (état -> HTML), sauf `attempt` qui affiche le message d'une action en échec. */
import { UserApiError } from '../../data/userApi';
import { SET_ICON } from '../settings-ui.js';
import { esc } from '../util.js';

const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';

/** Icônes de la navigation : celles des Réglages, plus celles de la console. */
export const ICON = {
  ...SET_ICON,
  inbox: svg('<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>'),
  online: svg('<circle cx="12" cy="12" r="2.6"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>'),
  plug: svg('<path d="M9 2v5M15 2v5M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  megaphone: svg('<path d="M4 10v4h3l8 4V6L7 10z"/><path d="M18 9a4 4 0 0 1 0 6"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>'),
};

export const badge = (text, kind) => '<span class="adm-badge' + (kind ? ' is-' + kind : '') + '">' + esc(text) + '</span>';
export const statusBadge = (s) => (s === 'suspended' ? badge('Suspendu', 'warn') : badge('Actif', 'ok'));
export const empty = (text) => '<p class="adm-empty" role="status">' + esc(text) + '</p>';

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

/** Contenu d'une donnée chargée : chargement, erreur (avec réessai) ou rendu. */
export function loaded(d, render) {
  if (!d || d.status === 'idle' || d.status === 'loading') return '<p class="adm-empty" role="status">Chargement…</p>';
  if (d.status === 'error') return '<div class="adm-error" role="alert"><span>' + esc(d.error) + '</span><button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Réessayer</button></div>';
  return render(d.value);
}

/** Sous 760 px, le tableau devient des cartes empilées (admin.css) : rien ne défile, donc le conteneur n'a pas à être focusable. */
const stackedCards = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 759px)').matches;

/** Tableau à colonnes ; `heads` : libellés ou { label, num }. Sous 760 px, chaque ligne devient une carte (data-label). */
export function table(caption, heads, rows, cls) {
  if (!rows.length) return '';
  return '<div class="adm-table-wrap ' + (cls || '') + '" role="region" aria-label="' + esc(caption) + '"' + (stackedCards() ? '' : ' tabindex="0"') + '><table class="adm-table"><caption class="sr-only">' + esc(caption) + '</caption><thead><tr>' +
    heads.map((h) => '<th scope="col"' + (h.num ? ' class="is-num"' : '') + '>' + esc(h.label || h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr' + (r.attrs ? ' ' + r.attrs : '') + '>' + r.cells.map((c, i) => {
      const h = heads[i];
      return '<td data-label="' + esc(h.label || h) + '"' + (h.num ? ' class="is-num"' : '') + '>' + c + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table></div>';
}

/** En-tête d'une section : titre (cible du focus au changement de section), description, action à droite. */
export const sectionHead = (title, desc, aside) =>
  '<header class="adm-head"><div><h2 id="adm-h" tabindex="-1">' + esc(title) + '</h2>' + (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' + (aside || '') + '</header>';

/** Carte de la console : titre facultatif, description facultative, action facultative à droite du titre. */
export function admCard(title, body, opts) {
  const o = opts || {};
  return '<section class="adm-card"' + (title ? ' aria-label="' + esc(title) + '"' : '') + '>' +
    (title ? '<header class="adm-card-h"><div><h3>' + esc(title) + '</h3>' + (o.desc ? '<p>' + esc(o.desc) + '</p>' : '') + '</div>' + (o.aside || '') + '</header>' : '') +
    '<div class="adm-card-b">' + body + '</div></section>';
}

/** Chiffre clé : libellé, valeur, indication facultative, mini-courbe facultative. */
export function kpi(label, value, hint, spark) {
  return '<li class="adm-kpi"><span class="adm-kpi-l">' + esc(label) + '</span><strong class="adm-kpi-v">' + value + '</strong>' +
    (hint ? '<span class="adm-kpi-h">' + esc(hint) + '</span>' : '') + (spark || '') + '</li>';
}

/** Page « bientôt » : section sans contenu encore, remplacée par son lot. */
export function soonPage(title, desc) {
  return sectionHead(title, desc) +
    '<section class="adm-card adm-soon" aria-label="Bientôt disponible"><p class="adm-soon-t">Bientôt disponible</p><p class="adm-dim">Cette section sera complétée prochainement.</p></section>';
}

/** Carte « bientôt » à l’intérieur d’une page existante. */
export function soonCard(title, note) {
  return '<section class="adm-card adm-soon" aria-label="' + esc(title) + '"><h3 class="adm-soon-t">' + esc(title) + '</h3><p class="adm-dim">' + esc(note) + '</p></section>';
}

/** Pagination à curseur : boutons « Précédent » / « Suivant » (identifiants `which:prev|next`). */
export function pager(id, hasPrev, hasNext) {
  return '<nav class="adm-pager" aria-label="Pagination" data-nav><button type="button" class="btn btn-ghost btn-sm" data-adm-page="' + id + ':prev"' + (hasPrev ? '' : ' disabled') + '>← Précédent</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-adm-page="' + id + ':next"' + (hasNext ? '' : ' disabled') + '>Suivant →</button></nav>';
}

/** Branche les boutons de pagination de `root` : `onPage(which, 'prev' | 'next')`. */
export function bindPager(root, onPage) {
  root.querySelectorAll('[data-adm-page]').forEach((b) => {
    b.addEventListener('click', () => {
      const [which, dir] = b.dataset.admPage.split(':');
      onPage(which, dir);
    });
  });
}

/** Exécute une action ; une erreur (ou une annulation) est remise à `say` (message ou toast). Renvoie true en cas de succès. */
export async function attempt(fn, say) {
  try { await fn(); return true; } catch (err) {
    if (err instanceof UserApiError && err.code === 'cancelled') { say('Action annulée.'); return false; }
    say(adminErr(err));
    return false;
  }
}
