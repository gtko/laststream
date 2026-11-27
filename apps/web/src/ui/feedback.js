/* Fenêtre « Envoyer un feedback » (LAST-1654), commune aux trois entrées : menu du profil, bouton du lecteur, lien
 * « Signaler » d'une erreur interceptée. Feuille basse sur mobile, modale centrée sur ordinateur, panneau à droite dans le
 * lecteur. Ouverte depuis une erreur : type « Bug », erreur et contexte déjà remplis. Le détail technique part vers Sentry
 * (privé) ; le forum (service en ligne) reçoit un sujet public regroupé par empreinte d'erreur. */
import { feedbackAvailable, forumAvailable, recentError, sentryActive } from '../data/feedback';
import { collectContext, contextRows, sendFeedback } from '../data/feedbackSend';
import '../styles/feedback.css';
import { openSheet } from './sheet.js';
import { esc } from './util.js';
import { t as tr } from '../i18n';

/** Motifs proposés en un geste dans le lecteur. */
export const PLAYER_REASONS = [tr('Pas de son'), tr('Sous-titres décalés'), tr('Image saccadée'), tr('Mauvaise langue'), tr('Coupures'), tr('Autre')];

const KINDS = [['bug', tr('Bug')], ['idea', tr('Idée')], ['other', tr('Autre')]];
const PLACEHOLDER = {
  bug: tr('Que s’est-il passé ? Ce que tu faisais juste avant aide beaucoup.'),
  idea: tr('Ton idée, en une ou deux phrases.'),
  other: tr('Ton message.'),
};
const FORUM_CAT = { bug: tr('« Remontée de bugs »'), idea: tr('« Idées et demandes »') };
const FORUM_ERRORS = {
  rate_limited: tr('Le forum limite les envois : ton message est parti à l’équipe, mais pas sur le forum.'),
  forum_banned: tr('Ton profil ne peut plus écrire sur le forum : ton message est parti à l’équipe seulement.'),
};

/**
 * @param {{ error?: import('../data/feedback').FeedbackError | null, kind?: 'bug' | 'idea' | 'other', player?: boolean,
 *   opener?: Element | null, onClose?: () => void }} [o]  `error: undefined` : la dernière erreur interceptée (moins de 10 min),
 *   `null` : aucune. `player` : ouvert depuis le lecteur (motifs en un geste, panneau à droite).
 */
export function openFeedback(o = {}) {
  if (!feedbackAvailable()) return null;
  const error = o.error === undefined ? (o.player ? recentPlayerError() : null) : o.error;
  let kind = error ? 'bug' : o.kind || 'bug';
  let reason = '';
  let busy = false;
  const forumOk = forumAvailable();
  const sentry = sentryActive();
  const rows = sentry ? contextRows(collectContext(), error) : [];

  const html =
    (o.player ? '<p class="fb-sub">' + tr('La lecture reste en pause pendant que tu écris.') + '</p>' : '') +
    '<form class="fb" novalidate>' +
    (o.player || error ? '' :
      '<div class="fb-kinds" role="radiogroup" aria-label="' + tr('Type de message') + '">' +
      KINDS.map(([k, label]) => '<button type="button" role="radio" class="fb-kind" data-kind="' + k + '" aria-checked="' + (k === kind) + '">' + label + '</button>').join('') +
      '</div>') +
    (o.player && !error ? '<div class="fb-reasons" role="group" aria-label="' + tr('Motif') + '">' +
      PLAYER_REASONS.map((r) => '<button type="button" class="fb-reason" aria-pressed="false" data-reason="' + esc(r) + '">' + esc(r) + '</button>').join('') + '</div>' : '') +
    (error ? '<div class="fb-error" role="note"><strong>' + esc(error.title) + '</strong> <span class="fb-code">' + esc(error.code) + '</span><br>' + esc(error.message) + '</div>' : '') +
    '<label class="fb-lb" for="fb-msg">' + (o.player && !error ? tr('Précisions (facultatif)') : tr('Ton message')) + '</label>' +
    '<textarea id="fb-msg" class="fb-msg" rows="4" maxlength="3000" placeholder="' + esc(PLACEHOLDER[kind]) + '"></textarea>' +
    (sentry
      ? '<details class="fb-ctx"><summary>' + tr('Détails techniques joints') + '</summary><dl>' +
        rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl></details>' +
        '<p class="fb-note">' + tr('Pour l’équipe seulement : aucun e-mail, aucune adresse IP, aucun lien de source.') + '</p>'
      : '') +
    (forumOk ? '<label class="fb-check" data-fb-forum><input type="checkbox" checked> <span>' + tr('Publier aussi dans le forum, catégorie') + ' <b data-fb-cat>' +
      FORUM_CAT[kind === 'idea' ? 'idea' : 'bug'] + tr('</b>, sous le nom de ton profil') + (error ? ' ' + tr('(les mêmes erreurs sont regroupées)') : '') + '</span></label>' : '') +
    '<p class="fb-fail" role="alert" hidden></p>' +
    '<div class="fb-actions"><button type="button" class="btn btn-ghost" data-sheet-close>' + tr('Annuler') + '</button>' +
    '<button type="submit" class="btn btn-primary" data-fb-send>' + tr('Envoyer') + '</button></div>' +
    '</form>';

  const sheet = openSheet({
    title: o.player ? tr('Signaler un problème') : tr('Envoyer un feedback'),
    html,
    cls: 'fb-sheet' + (o.player ? ' fb-side' : ''),
    opener: o.opener || null,
    locked: () => busy,
    initialFocus: o.player && !error ? '.fb-reason' : '#fb-msg',
    onClose: o.onClose,
  });
  const box = sheet.el;
  const form = /** @type {HTMLFormElement} */ (box.querySelector('.fb'));
  const msg = /** @type {HTMLTextAreaElement} */ (box.querySelector('#fb-msg'));
  const forumRow = box.querySelector('[data-fb-forum]');
  const forumBox = /** @type {HTMLInputElement | null} */ (forumRow ? forumRow.querySelector('input') : null);
  const fail = /** @type {HTMLElement} */ (box.querySelector('.fb-fail'));
  const send = /** @type {HTMLButtonElement} */ (box.querySelector('[data-fb-send]'));

  const paintKind = () => {
    for (const b of box.querySelectorAll('.fb-kind')) b.setAttribute('aria-checked', String(b.getAttribute('data-kind') === kind));
    msg.placeholder = PLACEHOLDER[kind];
    if (forumRow) {
      forumRow.hidden = kind === 'other';
      const cat = forumRow.querySelector('[data-fb-cat]');
      if (cat) cat.textContent = FORUM_CAT[kind === 'idea' ? 'idea' : 'bug'];
    }
  };
  paintKind();

  box.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const k = t && t.closest('[data-kind]');
    if (k) { kind = k.getAttribute('data-kind') || 'bug'; paintKind(); return; }
    const r = t && t.closest('[data-reason]');
    if (r) {
      const v = r.getAttribute('data-reason') || '';
      reason = reason === v ? '' : v;
      for (const b of box.querySelectorAll('.fb-reason')) b.setAttribute('aria-pressed', String(b.getAttribute('data-reason') === reason));
    }
  });
  // Flèches dans le groupe Bug / Idée / Autre (radiogroup).
  box.addEventListener('keydown', (e) => {
    const t = e.target instanceof Element ? e.target.closest('.fb-kind') : null;
    if (!t || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    const all = Array.from(box.querySelectorAll('.fb-kind'));
    const next = all[(all.indexOf(t) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    if (next instanceof HTMLElement) { next.focus(); next.click(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const message = msg.value.trim();
    if (!message && !reason && !error) {
      fail.textContent = kind === 'idea' ? tr('Décris ton idée en quelques mots.') : tr('Dis-nous en quelques mots ce qui ne va pas.');
      fail.hidden = false;
      msg.focus();
      return;
    }
    busy = true;
    fail.hidden = true;
    send.disabled = true;
    send.textContent = tr('Envoi…');
    try {
      const res = await sendFeedback({ kind, message, reason: reason || undefined, error, forum: !!(forumBox && forumBox.checked && kind !== 'other') });
      busy = false;
      done(res);
    } catch {
      busy = false;
      send.disabled = false;
      send.textContent = tr('Envoyer');
      fail.textContent = tr('Envoi impossible pour le moment. Vérifie ta connexion puis réessaie.');
      fail.hidden = false;
    }
  });

  /** @param {import('../data/feedbackSend').FeedbackResult} res */
  function done(res) {
    const lines = ['<p class="fb-thanks">' + tr('Merci, c’est envoyé.') + '</p>'];
    if (res.forum) {
      lines.push('<p class="fb-sub">' + (res.forum.grouped
        ? tr('Ce problème était déjà signalé : ton message a rejoint le sujet du forum ({reporters} membres concernés).', { reporters: res.forum.reporters })
        : tr('Un sujet a été ouvert sur le forum : les autres membres pourront confirmer ou t’aider.')) + '</p>');
    } else if (res.sentry) {
      lines.push('<p class="fb-sub">' + tr('L’équipe a reçu ton message avec les détails techniques.') + '</p>');
    }
    if (res.forumError) lines.push('<p class="fb-sub">' + esc(FORUM_ERRORS[res.forumError] || tr('Le forum n’a pas pu publier ton message, mais l’équipe l’a bien reçu.')) + '</p>');
    lines.push('<div class="fb-actions">' +
      (res.forum ? '<a class="btn btn-ghost" href="#/forum/t/' + encodeURIComponent(res.forum.topicId) + '" data-sheet-close data-fb-topic>' + tr('Voir le sujet') + '</a>' : '') +
      '<button type="button" class="btn btn-primary" data-sheet-close>' + tr('Fermer') + '</button></div>');
    // eslint-disable-next-line laststream/no-html-sink -- gabarit fixe, textes dynamiques échappés par esc
    form.innerHTML = lines.join('');
    const sub = box.querySelector(':scope > .fb-sub');
    if (sub) sub.remove();
    const topic = form.querySelector('[data-fb-topic]');
    // Le lien quitte le lecteur : la fenêtre se ferme d'abord, puis la page change (le lecteur se replie en mini).
    if (topic) topic.addEventListener('click', () => { if (o.player && document.fullscreenElement) void document.exitFullscreen().catch(() => {}); });
    const close = form.querySelector('.btn-primary');
    if (close instanceof HTMLElement) close.focus({ preventScroll: true });
  }
  return sheet;
}

/** Dernière erreur interceptée, seulement si elle vient du lecteur (le bouton du lecteur n'y joint rien d'autre). */
function recentPlayerError() {
  const e = recentError();
  return e && e.where === 'player' ? e : null;
}
