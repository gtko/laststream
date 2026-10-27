/* Carte d'une soirée planifiée (LAST-199) : titre, date et heure locales (Intl), hôte, invités avec pastille de réponse, rendez-vous
 * récurrent, statut annulée, réponses Je viens / Peut-être / Refuser, ouverture du salon (hôte) et lien Rejoindre. Pure : rend du
 * HTML à partir d'une soirée du protocole, tout texte dynamique passe par esc. */
import { eveningDay, friendName } from '../data/homeSocial';
import { avatarHTML } from './socialFmt.js';
import { esc } from './util.js';

/** Fenêtre d'ouverture du salon par l'hôte : de T-15 min à T+2 h (miroir du serveur). */
const OPEN_BEFORE_MS = 15 * 60 * 1000;
const OPEN_AFTER_MS = 2 * 3600 * 1000;
/** Invités montrés sur la carte ; les suivants sont comptés. */
const GUESTS_SHOWN = 6;

const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const WEEKDAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' });

/** [glyphe de la pastille, libellé] de chaque réponse. */
const RESP = { yes: ['✓', 'vient'], maybe: ['?', 'peut-être'], no: ['×', 'ne vient pas'], pending: ['…', 'n’a pas répondu'] };
/** Boutons de réponse : [réponse, libellé]. */
const ANSWERS = [['yes', 'Je viens'], ['maybe', 'Peut-être'], ['no', 'Refuser']];

/** Libellé du jour : « Ce soir », « Demain », puis « ven. 30 oct. » (le jour d'une soirée passée n'est jamais « Ce soir »). */
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (d.getTime() >= today.getTime()) {
    const word = eveningDay(ts, now);
    if (word === 'Ce soir' || word === 'Demain') return word;
  }
  return DATE.format(d);
}

export const timeLabel = (ts) => TIME.format(new Date(ts));

/** « Chaque dimanche », « Un dimanche sur deux » ; chaîne vide pour une soirée ponctuelle. */
export function recurrenceLabel(r, startsAt) {
  if (!r || r.freq !== 'weekly') return '';
  const day = WEEKDAY.format(new Date(startsAt));
  return r.interval === 2 ? 'Un ' + day + ' sur deux' : 'Chaque ' + day;
}

/** L'hôte peut ouvrir le salon : soirée maintenue, sans salon, entre T-15 min et T+2 h. */
export const canOpenRoom = (e, now = Date.now()) =>
  e.isHost && e.status === 'scheduled' && !e.party && now >= e.startsAt - OPEN_BEFORE_MS && now <= e.startsAt + OPEN_AFTER_MS;

/** Un invité peut répondre tant que la soirée est maintenue et n'a pas commencé. */
export const canAnswer = (e, now = Date.now()) => !e.isHost && e.status === 'scheduled' && now < e.startsAt;

function guestsHTML(e) {
  const list = Array.isArray(e.guests) ? e.guests : [];
  if (!list.length) return '';
  const shown = list.slice(0, GUESTS_SHOWN).map((g) => {
    const [glyph, label] = RESP[g.response] || RESP.pending;
    return '<li class="ev-guest"><span class="ev-av">' + avatarHTML(g.profile, 'ss-av-m') + '<i class="ev-resp is-' + esc(g.response in RESP ? g.response : 'pending') + '" aria-hidden="true">' + glyph + '</i></span>' +
      '<span class="sr-only">' + esc(friendName(g.profile)) + ' : ' + label + '</span></li>';
  }).join('');
  const more = list.length - GUESTS_SHOWN;
  return '<ul class="ev-guests" aria-label="Invités">' + shown + (more > 0 ? '<li class="ev-more">+' + more + '<span class="sr-only"> autres invités</span></li>' : '') + '</ul>';
}

const summary = (e) => {
  const list = Array.isArray(e.guests) ? e.guests : [];
  const yes = list.filter((g) => g.response === 'yes').length;
  const sub = e.isHost ? 'Tu organises cette soirée' : 'Proposée par ' + esc(friendName(e.host));
  return sub + (list.length ? ' · ' + yes + ' sur ' + list.length + ' invité' + (list.length > 1 ? 's' : '') + ' confirmé' + (yes > 1 ? 's' : '') : '');
};

/**
 * Carte d'une soirée. `busy` : une action est en cours sur cette carte (boutons inertes, `aria-disabled`). Une invitation reçue
 * (sans réponse de ma part) est mise en avant.
 */
export function eveningCardHTML(e, o = {}) {
  const now = o.now ?? Date.now();
  const id = esc(e.id);
  const cancelled = e.status === 'cancelled';
  const invite = !e.isHost && !cancelled && e.myResponse === 'pending' && now < e.startsAt;
  const rec = recurrenceLabel(e.recurrence, e.startsAt);
  const chips = (invite ? '<span class="ev-chip is-invite">Invitation</span>' : '') + (cancelled ? '<span class="ev-chip is-cancelled">Annulée</span>' : '') +
    (rec ? '<span class="ev-chip">' + esc(rec) + '</span>' : '');
  const dis = o.busy ? ' aria-disabled="true"' : '';
  let acts = '';
  if (canAnswer(e, now)) {
    acts += '<div class="ev-answers" role="group" aria-label="Ta réponse">' + ANSWERS.map(([r, label]) =>
      '<button type="button" class="btn ev-btn' + (r === 'yes' && e.myResponse !== 'yes' ? ' btn-primary' : ' btn-ghost') + '" data-evening-act="' + id + ':' + r + '" aria-pressed="' + (e.myResponse === r) + '"' + dis + '>' + label + '</button>').join('') + '</div>';
  }
  if (!cancelled && e.party && e.party.partyId) {
    acts += '<a class="btn btn-primary ev-btn" href="#/party/' + encodeURIComponent(e.party.partyId) + '" data-go aria-label="Rejoindre le salon : ' + esc(e.title) + '">Rejoindre</a>';
  } else if (canOpenRoom(e, now)) {
    acts += '<button type="button" class="btn btn-primary ev-btn" data-evening-act="' + id + ':open"' + dis + '>Ouvrir le salon</button>';
  }
  if (acts) acts = '<div class="ev-acts">' + acts + '</div>';
  return '<article class="ev-card' + (invite ? ' is-invite' : '') + (cancelled ? ' is-cancelled' : '') + '" data-evening="' + id + '" aria-labelledby="ev-t-' + id + '">' +
    '<div class="ev-when"><span class="ev-day">' + esc(dayLabel(e.startsAt, now)) + '</span><b class="ev-time">' + esc(timeLabel(e.startsAt)) + '</b></div>' +
    '<div class="ev-main">' + (chips ? '<div class="ev-chips">' + chips + '</div>' : '') +
    '<h3 class="ev-title" id="ev-t-' + id + '">' + esc(e.title) + '</h3><p class="ev-sub">' + summary(e) + '</p>' + guestsHTML(e) + '</div>' + acts + '</article>';
}
