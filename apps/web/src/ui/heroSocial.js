/* Ligne sociale du héros de l'accueil : « Léa, Tom et Sam veulent le voir » et bouton « Je viens à 21 h » (LAST-193).
 * Données : data/homeSocial.ts (état du store social, source de soirées isolée). Absente sans ami concerné, sur un profil enfant
 * et hors compte connecté. Module léger : pas d'illustration d'avatar ici (initiales sur la couleur du profil). */
import { getState, subscribe } from '../data/socialStore';
import { eveningFor, eveningTime, friendName, hasEveningJoin, joinEvening, wantNames, wantVerb, wantersOf } from '../data/homeSocial';
import { toast } from './dom.js';
import { ICON } from './icons.js';
import { socialAvailable } from './socialButton.js';
import { esc } from './util.js';

const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3b3750');
const kindOf = (it) => (it.type === 'tv' ? 'series' : 'movie');
const initials = (f) => esc(Array.from(friendName(f)).slice(0, 2).join('').toUpperCase());

/** Titre du catalogue -> référence du protocole (null si l'identifiant n'est pas numérique). */
function refOf(it) {
  const tmdbId = Number(it.id);
  return Number.isInteger(tmdbId) && tmdbId > 0 ? { type: kindOf(it), tmdbId } : null;
}

/** Contenu de la ligne (sans conteneur) : pile d'avatars et phrase. Chaîne vide s'il n'y a pas d'ami concerné. */
export function heroSocialInner(it, s = getState(), now = Date.now()) {
  const ref = socialAvailable() ? refOf(it) : null;
  if (!ref) return '';
  const friends = wantersOf(s, ref.type, ref.tmdbId, now);
  if (!friends.length) return '';
  const { shown, more } = wantNames(friends.map(friendName));
  const bold = shown.map((n) => '<b>' + esc(n) + '</b>');
  const names = more
    ? bold.join(', ') + ' et ' + more + (more > 1 ? ' autres' : ' autre')
    : bold.length > 1 ? bold.slice(0, -1).join(', ') + ' et ' + bold[bold.length - 1] : bold[0];
  const ev = eveningFor(ref.type, ref.tmdbId, now);
  const stack = friends.slice(0, 3).map((f) => '<span class="hs-av" style="background:' + colorOf(f.avatarColor) + '">' + initials(f) + '</span>').join('');
  return '<span class="hs-stack" aria-hidden="true">' + stack + '</span>' +
    '<span class="hs-text">' + names + ' ' + wantVerb(friends.length) + (ev ? ' — soirée proposée à ' + eveningTime(ev.startsAt) : '') + '</span>';
}

/** Bouton « Je viens à 21 h » : seulement quand une soirée est proposée sur ce titre et qu'une action d'inscription est branchée. */
export function heroEveningInner(it, _s, now = Date.now()) {
  const ref = socialAvailable() && hasEveningJoin() ? refOf(it) : null;
  const ev = ref ? eveningFor(ref.type, ref.tmdbId, now) : null;
  if (!ev) return '';
  return '<button type="button" class="btn btn-ghost" data-hero-evening="' + esc(ev.id) + '">' + ICON.users + '<span>Je viens à ' + eveningTime(ev.startsAt) + '</span></button>';
}

/** Conteneurs de la diapositive : remplis ici, puis tenus à jour par paintHeroSocial. Vides hors social. */
export function heroSocialHTML(it) {
  if (!socialAvailable()) return '';
  return '<div class="hero-social" data-hero-social="' + esc(it.key) + '">' + heroSocialInner(it) + '</div>';
}
export function heroEveningHTML(it) {
  if (!socialAvailable()) return '';
  return '<span class="hs-evening" data-hero-evening-slot="' + esc(it.key) + '">' + heroEveningInner(it) + '</span>';
}

/** Dernier HTML écrit dans chaque conteneur : le DOM relu ne reprend pas toujours le HTML écrit (apostrophes, guillemets), donc on compare ici. */
const written = new WeakMap();

/** Redessine la ligne et le bouton de chaque diapositive affichée si l'état a changé (rien ne bouge sinon). `items` : titres du héros. */
export function paintHeroSocial(items, s = getState()) {
  const byKey = new Map(items.map((it) => [it.key, it]));
  const fill = (sel, attr, inner) => document.querySelectorAll(sel).forEach((el) => {
    const it = byKey.get(el.dataset[attr]);
    if (!it) return;
    const html = inner(it, s);
    if (written.get(el) === html) return;
    written.set(el, html);
    // eslint-disable-next-line no-restricted-syntax -- noms échappés par esc (heroSocialInner, heroEveningInner)
    el.innerHTML = html;
  });
  fill('#app [data-hero-social]', 'heroSocial', heroSocialInner);
  fill('#app [data-hero-evening-slot]', 'heroEveningSlot', heroEveningInner);
}

let itemsOf = () => [];
let watching = false;

/** Branche une fois l'abonnement au store : la ligne suit les amis et l'activité en direct, sans nouvelle requête. */
export function watchHeroSocial(items) {
  itemsOf = items;
  if (watching) return;
  watching = true;
  subscribe((s) => paintHeroSocial(itemsOf(), s));
}

document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-hero-evening]') : null;
  if (!b) return;
  e.preventDefault();
  void joinEvening(b.dataset.heroEvening).then((ok) => { if (!ok) toast('Cette soirée n’est plus disponible.'); });
});
