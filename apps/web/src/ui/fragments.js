/* Port du prototype (voir tools/port-prototype.mjs). */
import { ICON } from './icons.js';
import { friendsButtonHTML } from './socialButton.js';
import { esc } from './util.js';

// ---------- Fragments communs (accueil) ----------
export const brandMark = () =>
  '<svg class="logo-mark" viewBox="0 0 120 120" aria-hidden="true"><rect class="lm-bg" width="120" height="120" rx="28"/><polygon class="lm-play" points="42,30 92,60 42,90"/><rect class="lm-bar" x="38" y="44" width="60" height="5"/><rect class="lm-bar" x="38" y="57.5" width="60" height="5"/><rect class="lm-bar" x="38" y="71" width="60" height="5"/></svg>';
const brandWord = () => brandMark() + '<span class="wordmark">last<span class="wm-accent">stream</span></span>';
export const brand = () => '<a href="#/" data-noop class="brand" aria-label="Laststream, accueil">' + brandWord() + '</a>';
/** Lien Accueil de la barre du haut des pages profondes (LAST-1200) : même logo, navigation ordinaire vers #/ (data-go, go()).
 * Chaque clic ajoute une entrée d'historique, comme tout lien : Retour du navigateur revient à la page quittée, sans boucle
 * (route() remet state.depth à 0 sur l'accueil). */
export const homeLink = () => '<a href="#/" data-go class="brand f-home" aria-label="Laststream, accueil">' + brandWord() + '</a>';

export function titleEl(it, d, cls) {
  if (d.logo) {
    return '<h1 class="' + cls + '"><img class="logo-img" src="' + esc(d.logo) + '" alt="' + esc(it.name) +
      '" data-logo="' + esc(it.name) + '"></h1>';
  }
  return '<h1 class="' + cls + '"><span class="title-text">' + esc(it.name) + '</span></h1>';
}
export const trailerBtn = (it, d) =>
  d.trailer
    ? '<button type="button" class="btn btn-primary" data-trailer="' + esc(it.key) + '">' + ICON.play + '<span>Bande-annonce</span></button>'
    : '<button type="button" class="btn btn-primary" disabled title="Bande-annonce indisponible">' + ICON.play + '<span>Bande-annonce</span></button>';
export const infoBtn = (it) =>
  '<button type="button" class="btn btn-ghost" data-info="' + esc(it.key) + '">' + ICON.info + '<span>Plus d’infos</span></button>';

export function heroEmpty() {
  return '<div class="state state-hero" role="status"><p>La mise en avant n’a pas pu être chargée.</p></div>';
}

export function section(id, title, list, render, tag) {
  const body = list === null
    ? '<p class="row-msg" role="status">Cette rangée n’a pas pu être chargée.</p>'
    : list.length ? render(list) : '<p class="row-msg">Aucun contenu pour le moment.</p>';
  return '<section class="row-section" id="' + id + '" aria-labelledby="h-' + id + '">' +
    '<h2 class="row-title" id="h-' + id + '">' + esc(title) + '</h2>' +
    body + '</section>';
}
export const row = (inner) => '<div class="row">' + inner + '</div>';
function backBtn() {
  return '<button type="button" class="f-round" data-back data-tip="Retour" aria-label="Retour à l’accueil">' + ICON.back + '</button>';
}

export function topBar(withActions) {
  const friends = friendsButtonHTML('f-round'); // vide hors compte connecté (profil enfant, mode local)
  const actions = withActions
    ? '<button type="button" class="f-round" data-share data-tip="Partager" aria-label="Partager">' + ICON.share + '</button>' +
      '<button type="button" class="f-round" data-fsound hidden aria-pressed="false" data-tip="Activer le son" aria-label="Activer le son">' + ICON.mute + '</button>'
    : '';
  return '<div class="f-top" data-nav><div class="f-top-l">' + backBtn() + homeLink() + '</div>' +
    (friends || actions ? '<div class="f-top-r">' + friends + actions + '</div>' : '') + '</div>';
}
export function svcError(msg) {
  return topBar(false) + '<article class="fiche f-error" tabindex="-1"><div class="state" role="alert"><p>' + esc(msg) + '</p>' +
    '<div class="f-actions"><button type="button" class="btn btn-ghost" data-back>Retour</button></div></div></article>';
}
