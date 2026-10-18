/* Composants de la page Réglages : catégories, lignes, interrupteurs, puces, cartes de groupe.
 * Pur HTML (chaînes) : aucun état, aucun effet de bord. Les comportements sont dans settings.js et homeprefs.js. */
import { esc } from './util.js';

const svg = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';

export const SET_ICON = {
  user: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-3.8 3.7-6 7.5-6s6.7 2.2 7.5 6"/>'),
  palette: svg('<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-1.2-1-1.5-1-2.7 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.4" r="1"/><circle cx="15" cy="7.8" r="1"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.400 5.600 12 3z"/>'),
  play: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.200 9.300v5.400l4.500-2.700z"/>'),
  home: svg('<path d="M4 11l8-7 8 7v8.500a1 1 0 0 1-1 1h-4.500V15h-5v5.500H5a1 1 0 0 1-1-1z"/>'),
  server: svg('<rect x="3.500" y="4" width="17" height="6.500" rx="2"/><rect x="3.500" y="13.500" width="17" height="6.500" rx="2"/><path d="M7.500 7.300h.01M7.500 16.800h.01"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.500l9 5 9-5M3 16.500l9 5 9-5"/>'),
  eye: svg('<path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.800"/>'),
  eyeOff: svg('<path d="M4 4l16 16"/><path d="M9.800 5.800A9 9 0 0 1 12 5.500c6 0 9.500 6.500 9.500 6.500a15 15 0 0 1-3 3.700M6.300 7.700C3.800 9.500 2.500 12 2.500 12S6 18.500 12 18.500c1.300 0 2.500-.3 3.500-.8"/>'),
  film: svg('<rect x="4" y="4" width="16" height="16" rx="2.500"/><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>'),
  x: svg('<path d="M6.500 6.500l11 11M17.500 6.500l-11 11"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
};

/** Catégories de la navigation latérale (ordre = ordre des panneaux dans la page). */
export const CATEGORIES = [
  { id: 'account', label: 'Profil et compte', icon: 'user' },
  { id: 'appearance', label: 'Apparence', icon: 'palette' },
  { id: 'region', label: 'Langue et région', icon: 'globe' },
  { id: 'playback', label: 'Lecture', icon: 'play' },
  { id: 'home', label: 'Accueil et recommandations', icon: 'home' },
  { id: 'server', label: 'Serveur lastAddon', icon: 'server' },
  { id: 'sources', label: 'Sources et debrid', icon: 'layers' },
];

export function navHTML(cats, active) {
  return '<nav class="set-nav" aria-label="Catégories de réglages"><ul>' + cats.map((c) =>
    '<li data-nav><button type="button" class="set-nav-i" data-set-cat="' + c.id + '" aria-current="' + (c.id === active ? 'true' : 'false') + '">' +
    SET_ICON[c.icon] + '<span>' + esc(c.label) + '</span></button></li>').join('') + '</ul></nav>';
}

export function panelHTML(cat, desc, inner) {
  return '<section class="set-panel" id="set-p-' + cat.id + '" data-cat="' + cat.id + '" aria-labelledby="set-h-' + cat.id + '">' +
    '<header class="set-panel-h"><span class="set-panel-ic">' + SET_ICON[cat.icon] + '</span><div><h2 id="set-h-' + cat.id + '">' + esc(cat.label) + '</h2>' +
    (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div></header>' + inner + '</section>';
}

/** Carte de groupe : titre, description facultative, action facultative à droite du titre, puis le contenu. */
export function card(title, body, opts) {
  const o = opts || {};
  return '<div class="set-card"' + (o.attrs ? ' ' + o.attrs : '') + '>' +
    (title ? '<div class="set-card-h"><div class="set-card-t"><h3>' + esc(title) + '</h3>' + (o.desc ? '<p>' + esc(o.desc) + '</p>' : '') + '</div>' + (o.aside || '') + '</div>' : '') +
    '<div class="set-card-b">' + body + '</div></div>';
}

let uid = 0;
const nextId = () => 'set-r' + (++uid);

/** Interrupteur : bouton role=switch (la valeur est dans aria-checked). `attrs` : name, data-set-pref… */
export function switchHTML(on, attrs, labelledBy) {
  return '<button type="button" class="set-switch" role="switch" data-set-toggle aria-checked="' + (on ? 'true' : 'false') + '"' +
    (labelledBy ? ' aria-labelledby="' + labelledBy + '"' : '') + (attrs ? ' ' + attrs : '') + '><span class="set-switch-k"></span></button>';
}

/** Ligne de réglage : libellé et description à gauche, contrôle à droite. `stack` : contrôle pleine largeur sous le libellé. */
export function rowHTML(label, desc, control, opts) {
  const o = opts || {};
  const id = nextId();
  return '<div class="set-row' + (o.stack ? ' is-stack' : '') + '" data-nav><div class="set-row-t"><span class="set-row-l" id="' + id + '">' + esc(label) + '</span>' +
    (desc ? '<span class="set-row-d" id="' + id + '-d">' + esc(desc) + '</span>' : '') + '</div><div class="set-row-c">' + control(id) + '</div></div>';
}

/** Ligne avec interrupteur (toute la ligne est cliquable). */
export function switchRow(label, desc, on, attrs) {
  const id = nextId();
  return '<div class="set-row" data-nav data-sw-row><div class="set-row-t"><span class="set-row-l" id="' + id + '">' + esc(label) + '</span>' +
    (desc ? '<span class="set-row-d">' + esc(desc) + '</span>' : '') + '</div><div class="set-row-c">' + switchHTML(on, attrs, id) + '</div></div>';
}

/** Ligne avec un champ (texte, nombre, mot de passe, liste déroulante). `inner` reçoit l'identifiant du champ. */
export function fieldRow(label, desc, inner, opts) {
  const o = opts || {};
  const id = nextId();
  return '<div class="set-row' + (o.stack ? ' is-stack' : '') + '" data-nav><label class="set-row-t" for="' + id + '"><span class="set-row-l">' + esc(label) + '</span>' +
    (desc ? '<span class="set-row-d">' + esc(desc) + '</span>' : '') + '</label><div class="set-row-c">' + inner(id) + '</div></div>';
}

/** Puce à cocher (bouton role=checkbox) : langues, résolutions, genres. */
export function chipHTML(label, on, attrs) {
  return '<button type="button" class="set-chip" role="checkbox" aria-checked="' + (on ? 'true' : 'false') + '"' + (attrs ? ' ' + attrs : '') + '>' +
    '<span class="set-chip-i" aria-hidden="true"></span><span class="set-chip-l">' + esc(label) + '</span></button>';
}

export const chipsHTML = (label, chips) => '<div class="set-chips" role="group" aria-label="' + esc(label) + '" data-nav>' + chips + '</div>';

/** Lit l'état d'un interrupteur ou d'une puce (bouton à aria-checked) ou d'une case native. */
export function isOn(el) {
  if (!el) return false;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
  return el.getAttribute('aria-checked') === 'true';
}

/** Inverse un interrupteur ou une puce, et renvoie le nouvel état. */
export function flip(el) {
  const on = !isOn(el);
  el.setAttribute('aria-checked', String(on));
  return on;
}
