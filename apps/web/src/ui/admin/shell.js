/* Coquille de la console d'administration : page, barre du haut (marque, recherche, état du serveur, élévation), navigation groupée
 * avec compteurs. Fonctions pures (état -> HTML) ; admin.js les rafraîchit et gère les minuteries. */
import { elevationExpiresAt } from '../../data/adminApi';
import { fmtInt, formatCountdown, serviceStatusLabel } from '../../data/adminModel';
import { brandMark } from '../fragments.js';
import { esc } from '../util.js';
import { ICON } from './common.js';
import { GROUPS, sectionsOf } from './sections.js';

/** Compteur affiché à côté d’une entrée : à traiter, en ligne, signalements ouverts. */
const BADGE_OF = { inbox: 'todo', online: 'online', moderation: 'reports' };

export function badgeHTML(key, n) {
  return '<span class="adm-nbadge" data-adm-badge="' + key + '"' + (n == null ? ' hidden' : '') + '>' + (n == null ? '' : fmtInt(n)) + '</span>';
}

/** Navigation : cinq espaces, leurs entrées ; l’entrée courante porte aria-current. Chaque entrée est un `li` (flèches du clavier). */
export function navHTML(S) {
  return '<nav class="adm-nav" aria-label="Sections d’administration">' + GROUPS.map((g) =>
    '<div class="adm-navg"><p class="adm-navg-t">' + esc(g.label) + '</p><ul>' + sectionsOf(g.id).map((s) => {
      const b = BADGE_OF[s.id];
      return '<li data-nav><button type="button" class="adm-navi" data-adm-sec="' + s.id + '"' + (s.id === S.sec ? ' aria-current="page"' : '') + '>' +
        (ICON[s.icon] || '') + '<span class="adm-navi-l">' + esc(s.label) + '</span>' + (b ? badgeHTML(b, S.badges[b]) : '') + '</button></li>';
    }).join('') + '</ul></div>').join('') + '</nav>';
}

const STATUS_CLASS = { ok: 'is-ok', degraded: 'is-warn', down: 'is-bad' };

/** Pastille d’état global. `status` : ok, degraded, down, unknown, ou null (vérification en cours). */
export function statusHTML(status) {
  const cls = STATUS_CLASS[status] || 'is-unknown';
  const label = status == null ? 'Vérification…' : serviceStatusLabel(status);
  return '<span class="adm-status ' + cls + '" data-adm-status data-state="' + esc(String(status)) + '" role="status"><span class="adm-dot" aria-hidden="true"></span>' + esc(label) + '</span>';
}

/** Puce d’élévation dans son conteneur : compte à rebours « Mode élevé · mm:ss », ou bouton pour s’élever (expiresAt nul). */
export function elevationBoxHTML(expiresAt, now = Date.now()) {
  if (expiresAt == null) {
    return '<span class="adm-elev-box" data-adm-elev data-state="off"><button type="button" class="adm-elev is-off" data-adm-elevate title="Ressaisir ton mot de passe pour les actions sensibles (10 min)">' +
      ICON.lock + 'Activer le mode élevé</button></span>';
  }
  return '<span class="adm-elev-box" data-adm-elev data-state="on"><span class="adm-elev is-on" title="Les actions sensibles ne demandent pas ton mot de passe jusqu’à expiration">' +
    ICON.lock + 'Mode élevé · <span data-adm-elev-txt>' + formatCountdown(expiresAt - now) + '</span></span></span>';
}

export function topbarHTML(S) {
  return '<header class="adm-top"><a class="adm-brand" href="#/" aria-label="Laststream : retour à l’accueil">' + brandMark() +
    '<span class="wordmark">last<span class="wm-accent">stream</span></span></a><span class="adm-tag">Admin</span>' +
    '<button type="button" class="adm-search" data-adm-palette aria-label="Rechercher dans l’administration">' + ICON.search +
    '<span class="adm-search-t">Rechercher un compte, un salon, une action…</span></button>' +
    '<div class="adm-top-r">' + statusHTML(S.status) + elevationBoxHTML(elevationExpiresAt()) + '</div></header>';
}

/** Page complète : barre du haut, navigation, zone de contenu (remplie par admin.js). */
export function pageHTML(S) {
  return '<div class="adm-shell">' + topbarHTML(S) + '<div class="adm-body">' + navHTML(S) +
    '<main class="adm-main" id="adm-main"><h1 class="sr-only" id="adm-title" tabindex="-1">Administration</h1>' +
    '<section id="adm-content" class="adm-content" aria-live="polite"></section></main></div></div>';
}
