/* Onglets « Ce soir », « À venir » et « Passées » de la page Ensemble (LAST-199) : soirées planifiées du profil, lues par le magasin
 * des soirées (eveningsStore.ts) et tenues à jour par les trames temps réel. Les réponses (Je viens / Peut-être / Refuser) et
 * l'ouverture du salon passent par des boutons `data-evening-act="<id>:<action>"`. Un compteur de montage protège toute réponse
 * asynchrone : changer d'onglet, de page ou de profil rend caduque une action en vol. */
import { EVENING_FALLBACK, eveningErrorText } from '../data/eveningForm';
import { answerEvening, findEvening, getEveningList, loadEvenings, putEvening, subscribeEvenings } from '../data/eveningsStore';
import { openEvening } from '../data/socialV3Api';
import { UserApiError } from '../data/userApi';
import { detailEl, toast } from './dom.js';
import { CONFIRM_KINDS, openEveningAction } from './eveningActions.js';
import { eveningCardHTML } from './eveningCard.js';
import { openEveningForm } from './eveningForm.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { esc, rewriteKeepingFocus } from './util.js';

/** Onglets de cette page. */
export const EVENING_TABS = ['ce-soir', 'a-venir', 'passees'];

/** Portées lues par chaque onglet. */
const SCOPES = { 'ce-soir': ['upcoming', 'past'], 'a-venir': ['invites', 'upcoming'], passees: ['past'] };
/** Une soirée commencée depuis moins de 2 h reste dans « Ce soir » (l'hôte peut encore ouvrir le salon). */
const TONIGHT_GRACE_MS = 2 * 3600 * 1000;
/** Un onglet rouvert moins de 10 s après sa lecture n'appelle pas le serveur. */
const MAX_AGE_MS = 10_000;

/** [titre, texte] de l'état vide de chaque onglet. */
const EMPTY = {
  'ce-soir': ['Rien de prévu ce soir', 'Les soirées planifiées pour ce soir apparaîtront ici, avec les réponses de tes amis.'],
  'a-venir': ['Aucune soirée à venir', 'Les prochaines soirées et les invitations en attente apparaîtront ici.'],
  passees: ['Aucune soirée passée', 'Les soirées terminées resteront ici pour que tu puisses les retrouver.'],
};

const ERRORS = {
  evening_closed: 'Cette soirée est annulée ou a déjà commencé.',
  evening_not_found: 'Cette soirée n’existe plus.',
  evening_not_open: 'Le salon s’ouvre 15 minutes avant le début et jusqu’à 2 heures après.',
  too_many_rooms: 'Tu as déjà trop de salons ouverts.',
  party_unavailable: 'Les salons ne sont pas disponibles sur ce serveur.',
};

let tab = '';
let hostEl = null;
let mountGen = 0;
let subscribed = false;
const busy = new Set();
/** Dernier HTML écrit par panneau : un contenu identique n'est pas réécrit (le focus clavier reste en place). */
const lastHtml = new WeakMap();

const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isToday = (ts, now) => startOfDay(ts) === startOfDay(now);

const retryBtn = (scope) => '<button type="button" class="btn btn-ghost ev-btn" data-evening-act="' + scope + ':retry">Réessayer</button>';
const message = (text) => '<p class="row-msg" role="status">' + esc(text) + '</p>';

function emptyHTML(t) {
  const [title, text] = EMPTY[t];
  return '<div class="wp-empty-box ens-empty"><span class="wp-empty-ico">' + ICON.party + '</span><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
}

const listHTML = (items, now) =>
  '<ul class="ev-list">' + items.map((e) => '<li>' + eveningCardHTML(e, { now, busy: busy.has(e.id) }) + '</li>').join('') + '</ul>';

function moreHTML(scope) {
  const l = getEveningList(scope);
  if (l.error && l.loaded) return message('Impossible de charger la suite pour l’instant.') + '<button type="button" class="btn btn-ghost ev-btn" data-evening-act="' + scope + ':more">Réessayer</button>';
  return l.nextCursor ? '<button type="button" class="btn btn-ghost ev-btn ev-more-btn" data-evening-act="' + scope + ':more"' + (l.loading ? ' aria-disabled="true"' : '') + '>Voir plus</button>' : '';
}

const section = (id, title, body) => '<section class="ev-sec" aria-labelledby="ev-h-' + id + '"><h2 class="ev-h" id="ev-h-' + id + '">' + esc(title) + '</h2>' + body + '</section>';

/** Soirées de « Ce soir » : celles du jour à venir, plus celles commencées depuis moins de 2 h. */
function tonight(now) {
  const seen = new Set();
  return [...getEveningList('upcoming').items.filter((e) => isToday(e.startsAt, now)),
    ...getEveningList('past').items.filter((e) => e.status === 'scheduled' && e.startsAt >= now - TONIGHT_GRACE_MS)]
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** Contenu d'un onglet à l'instant `now`. */
export function paneHTML(t, now = Date.now()) {
  const scopes = SCOPES[t];
  const failed = scopes.find((s) => !getEveningList(s).loaded && getEveningList(s).error && !getEveningList(s).loading);
  if (failed) return message('Impossible de charger les soirées pour l’instant.') + retryBtn(failed);
  if (scopes.some((s) => !getEveningList(s).loaded)) return message('Chargement…');
  if (t === 'ce-soir') {
    const items = tonight(now);
    return items.length ? listHTML(items, now) : emptyHTML(t);
  }
  if (t === 'passees') {
    const items = getEveningList('past').items;
    return items.length ? listHTML(items, now) + moreHTML('past') : emptyHTML(t);
  }
  const invites = getEveningList('invites').items.filter((e) => e.status === 'scheduled' && e.startsAt > now);
  const ids = new Set(invites.map((e) => e.id));
  const later = getEveningList('upcoming').items.filter((e) => !isToday(e.startsAt, now) && !ids.has(e.id));
  if (!invites.length && !later.length) return emptyHTML(t);
  return (invites.length ? section('inv', 'Invitations reçues', listHTML(invites, now)) : '') +
    (later.length ? section('next', invites.length ? 'Prochaines soirées' : 'À venir', listHTML(later, now) + moreHTML('upcoming')) : '');
}

function paint() {
  const el = hostEl;
  if (!el || !el.isConnected || state.kind !== 'ensemble') return;
  const html = paneHTML(tab);
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  rewriteKeepingFocus(el, html);
}

/** Monte l'onglet `t` dans `host` : état local remis à zéro, lecture des portées (cache court), affichage au fil des réponses. */
export function mountEveningsPane(host, t) {
  mountGen++;
  busy.clear();
  tab = SCOPES[t] ? t : 'ce-soir';
  hostEl = host;
  if (!subscribed) {
    subscribed = true;
    subscribeEvenings(paint);
  }
  paint();
  for (const scope of SCOPES[tab]) void loadEvenings(scope, { maxAge: MAX_AGE_MS });
}

function failure(err, fallback) {
  toast(err instanceof UserApiError && ERRORS[err.code] ? ERRORS[err.code] : fallback);
}

function answer(id, response, g) {
  busy.add(id);
  paint();
  let reason = '';
  void answerEvening(id, response, (err) => { reason = eveningErrorText(err); }).then((ok) => {
    if (g !== mountGen) return;
    busy.delete(id);
    if (!ok) toast(reason && reason !== EVENING_FALLBACK ? reason : 'Ta réponse n’a pas pu être enregistrée.');
    paint();
  });
}

function openRoom(id, g) {
  busy.add(id);
  paint();
  openEvening(id).then(
    (e) => {
      if (g !== mountGen) return;
      busy.delete(id);
      putEvening(e);
      if (e.party && e.party.partyId && state.kind === 'ensemble') location.hash = '#/party/' + encodeURIComponent(e.party.partyId);
      else toast('Le salon n’a pas pu s’ouvrir.');
      paint();
    },
    (err) => {
      if (g !== mountGen) return;
      busy.delete(id);
      failure(err, 'Le salon n’a pas pu s’ouvrir.');
      paint();
    },
  );
}

detailEl.addEventListener('click', (e) => {
  if (state.kind !== 'ensemble' || !hostEl) return;
  const btn = e.target instanceof Element ? e.target.closest('[data-evening-act]') : null;
  if (!btn || !hostEl.contains(btn)) return;
  e.preventDefault();
  if (btn.getAttribute('aria-disabled') === 'true') return;
  const v = btn.getAttribute('data-evening-act') || '';
  const cut = v.lastIndexOf(':');
  const id = v.slice(0, cut);
  const act = v.slice(cut + 1);
  if (act === 'yes' || act === 'maybe' || act === 'no') {
    if (!busy.has(id)) answer(id, act, mountGen);
  } else if (act === 'open') {
    if (!busy.has(id)) openRoom(id, mountGen);
  } else if (act === 'edit' || CONFIRM_KINDS.includes(act)) {
    const ev = findEvening(id);
    if (!ev) return;
    if (act === 'edit') openEveningForm({ evening: ev, opener: btn });
    else openEveningAction(act, ev, btn);
  } else if (act === 'more') {
    void loadEvenings(id, { more: true });
  } else if (act === 'retry') {
    void loadEvenings(id, { force: true });
  }
});
