/* Feuille « Planifier une soirée » et « Modifier la soirée » (LAST-199, lot B) : titre, date et heure (fuseau du navigateur envoyé en
 * `tz`), récurrence, invités (amis acceptés, hors foyer, 19 au plus, recherche courte). La validation reprend les plafonds du serveur
 * (data/eveningForm.ts) ; un seul envoi à la fois (bouton désactivé pendant l'appel) ; une réponse qui arrive après un changement de
 * profil ou la fermeture de la feuille n'écrit plus rien. En modification : titre, horaire et invités, sur l'occurrence ou la série. */
import { auth } from '../data/auth';
import {
  buildCreateBody, defaultStart, eveningErrorText, localTimeZone, MAX_GUESTS, parseLocal, TITLE_MAX, toDateInput, toTimeInput, validateEvening,
} from '../data/eveningForm';
import { commitEvening, eveningsAvailable } from '../data/eveningsStore';
import { friendName } from '../data/homeSocial';
import { createEvening, inviteToEvening, removeEveningGuest, updateEvening } from '../data/socialV3Api';
import { getState as socialState } from '../data/socialStore';
import { toast } from './dom.js';
import { openSheet } from './sheet.js';
import { avatarHTML } from './socialFmt.js';
import { esc } from './util.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

const REPEATS = [['once', 'Une fois'], ['weekly', 'Chaque semaine'], ['biweekly', 'Toutes les 2 semaines']];

/** Personnes invitables : mes amis acceptés (jamais le foyer), puis les invités actuels qui ne sont plus dans la liste (à retirer). */
function candidates(evening) {
  const seen = new Set();
  const list = [];
  const add = (p) => { if (p && p.pid && !seen.has(p.pid)) { seen.add(p.pid); list.push(p); } };
  socialState().friends.filter((f) => !f.household).forEach(add);
  if (evening) evening.guests.forEach((g) => add(g.profile));
  return list.sort((a, b) => friendName(a).localeCompare(friendName(b), 'fr'));
}

function friendsHTML(list, picked) {
  if (!list.length) return '<p class="evf-empty">Aucun ami à inviter pour l’instant. Ajoute des amis depuis la page Amis : tu pourras aussi inviter plus tard.</p>';
  return '<input class="evf-input evf-search" type="search" data-evf-search autocomplete="off" placeholder="Chercher un ami" aria-label="Chercher un ami à inviter">' +
    '<ul class="evf-friends">' + list.map((f) => {
      const name = friendName(f);
      return '<li data-evf-name="' + esc(norm(name)) + '"><label class="evf-friend">' + avatarHTML(f, 'ss-av-m') + '<span class="evf-fn">' + esc(name) + '</span>' +
        '<input type="checkbox" name="guest" value="' + esc(f.pid) + '"' + (picked.has(f.pid) ? ' checked' : '') + ' aria-label="Inviter ' + esc(name) + '"><span class="evf-chk" aria-hidden="true"></span></label></li>';
    }).join('') + '</ul><p class="evf-empty" data-evf-nomatch hidden>Aucun ami ne correspond.</p>';
}

const field = (id, label, control, extra = '') =>
  '<div class="evf-field"><label class="evf-lb" for="evf-' + id + '">' + label + '</label>' + control + extra + '<p class="evf-err" id="evf-err-' + id + '" hidden></p></div>';

function formHTML({ edit, title, start, picked, list }) {
  const scope = edit && (edit.recurrence || edit.seriesId)
    ? '<fieldset class="evf-scope"><legend class="evf-lb">Appliquer à</legend>' +
      '<label><input type="radio" name="scope" value="occurrence" checked> Cette soirée seulement</label>' +
      '<label><input type="radio" name="scope" value="series"> Toute la série</label></fieldset>' : '';
  const repeat = edit ? '' :
    field('repeat', 'Répéter', '<select class="evf-input" id="evf-repeat" name="repeat">' + REPEATS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select>') +
    '<div data-evf-until hidden>' + field('until', 'Fin de la série (facultatif)', '<input class="evf-input" id="evf-until" name="until" type="date" min="' + esc(start.date) + '">') + '</div>';
  return '<form class="evf" data-evf novalidate>' +
    field('title', 'Titre', '<input class="evf-input" id="evf-title" name="title" type="text" required autocomplete="off" value="' + esc(title) + '" placeholder="Ex. Soirée Dune 2" aria-describedby="evf-hint-title evf-err-title">',
      '<p class="evf-hint" id="evf-hint-title">' + TITLE_MAX + ' caractères au maximum.</p>') +
    '<div class="evf-row">' + field('date', 'Date', '<input class="evf-input" id="evf-date" name="date" type="date" value="' + esc(start.date) + '" min="' + esc(toDateInput(Date.now())) + '" aria-describedby="evf-err-when">') +
    field('time', 'Heure', '<input class="evf-input" id="evf-time" name="time" type="time" value="' + esc(start.time) + '" aria-describedby="evf-err-when">') + '</div>' +
    '<p class="evf-err" id="evf-err-when" hidden></p>' + scope + repeat +
    '<fieldset class="evf-guests" aria-describedby="evf-err-guests"><legend class="evf-lb">Invités <span class="evf-count" data-evf-count aria-live="polite"></span></legend>' + friendsHTML(list, picked) + '</fieldset>' +
    '<p class="evf-err" id="evf-err-guests" hidden></p>' +
    '<p class="evf-err evf-server" data-evf-server role="alert" hidden></p>' +
    '<div class="evf-foot"><button type="button" class="btn btn-ghost evf-btn" data-sheet-close>Annuler</button>' +
    '<button type="submit" class="btn btn-primary evf-btn" data-evf-submit>' + (edit ? 'Enregistrer' : 'Planifier') + '</button></div></form>';
}

/**
 * Ouvre la feuille. Sans `evening` : création (`title` : titre prérempli, ex. celui d'une fiche). Avec `evening` (mon événement,
 * à venir) : modification. Rend la feuille, ou `null` hors compte / sur un profil enfant.
 * @param {{ evening?: any, title?: string, opener?: Element | null }} [o]
 */
export function openEveningForm(o = {}) {
  if (!eveningsAvailable()) {
    toast('Connecte-toi avec un profil adulte pour planifier une soirée.');
    return null;
  }
  const edit = o.evening || null;
  const pid0 = auth.profile ? auth.profile.id : '';
  const start = edit ? { date: toDateInput(edit.startsAt), time: toTimeInput(edit.startsAt) } : defaultStart(Date.now());
  const initial = new Set(edit ? edit.guests.map((g) => g.profile.pid) : []);
  const list = candidates(edit);
  let busy = false;
  const sheet = openSheet({
    title: edit ? 'Modifier la soirée' : 'Planifier une soirée',
    cls: 'evf-sheet',
    opener: o.opener,
    locked: () => busy,
    initialFocus: '#evf-title',
    html: formHTML({ edit, title: edit ? edit.title : o.title ? String(o.title).trim() : '', start, picked: initial, list }),
  });
  const form = sheet.el.querySelector('[data-evf]');
  if (!(form instanceof HTMLFormElement)) return sheet;
  const $ = (sel) => form.querySelector(sel);
  const val = (name) => { const el = form.elements.namedItem(name); return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : ''; };
  const picked = () => Array.from(form.querySelectorAll('input[name="guest"]:checked')).map((i) => /** @type {HTMLInputElement} */ (i).value);
  const readInput = () => ({ title: val('title'), date: val('date'), time: val('time'), guests: picked(), repeat: /** @type {any} */ (val('repeat') || 'once'), until: val('until') });

  const slots = { title: ['evf-title'], when: ['evf-date', 'evf-time'], guests: [], until: ['evf-until'] };
  const showProblems = (problems) => {
    for (const f of Object.keys(slots)) {
      const p = problems.find((x) => x.field === f);
      const msg = $(f === 'title' ? '#evf-err-title' : f === 'when' ? '#evf-err-when' : f === 'guests' ? '#evf-err-guests' : '#evf-err-until');
      if (msg instanceof HTMLElement) { msg.textContent = p ? p.text : ''; msg.hidden = !p; }
      for (const id of slots[f]) {
        const el = form.querySelector('#' + id);
        if (el) { if (p) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
      }
    }
    const first = problems[0];
    const target = first && (first.field === 'guests' ? $('input[name="guest"], [data-evf-search]') : form.querySelector('#' + (slots[first.field][0] || '')));
    if (target instanceof HTMLElement) target.focus({ preventScroll: false });
  };
  const server = (text) => {
    const el = $('[data-evf-server]');
    if (el instanceof HTMLElement) { el.textContent = text; el.hidden = !text; }
  };
  const count = () => {
    const n = picked().length;
    const c = $('[data-evf-count]');
    if (c) c.textContent = n + ' / ' + MAX_GUESTS;
    form.querySelectorAll('input[name="guest"]').forEach((i) => { if (i instanceof HTMLInputElement) i.disabled = !i.checked && n >= MAX_GUESTS; });
  };
  const setBusy = (on) => {
    busy = on;
    const b = $('[data-evf-submit]');
    if (b instanceof HTMLButtonElement) { b.disabled = on; b.setAttribute('aria-busy', String(on)); }
    form.querySelectorAll('input, select').forEach((el) => { if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.readOnly = on; });
  };
  count();

  form.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
    if (t.matches('[data-evf-search]')) {
      const q = norm(t.value);
      let shown = 0;
      form.querySelectorAll('[data-evf-name]').forEach((li) => {
        const on = !q || (li.getAttribute('data-evf-name') || '').includes(q);
        /** @type {HTMLElement} */ (li).hidden = !on;
        if (on) shown++;
      });
      const none = $('[data-evf-nomatch]');
      if (none instanceof HTMLElement) none.hidden = shown > 0;
      return;
    }
    if (t.name === 'repeat') {
      const until = $('[data-evf-until]');
      if (until instanceof HTMLElement) until.hidden = t.value === 'once';
    }
    if (t.name === 'guest') count();
    if (t.getAttribute('aria-invalid')) {
      t.removeAttribute('aria-invalid');
      const msg = t.name === 'title' ? '#evf-err-title' : t.name === 'until' ? '#evf-err-until' : '#evf-err-when';
      const m = $(msg);
      if (m instanceof HTMLElement) { m.textContent = ''; m.hidden = true; }
    }
    server('');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || sheet.closed) return;
    const input = readInput();
    const whenChanged = !edit || input.date !== start.date || input.time !== start.time;
    const problems = validateEvening(input, Date.now(), { when: whenChanged });
    showProblems(problems);
    if (problems.length) return;
    setBusy(true);
    server('');
    void run(input, whenChanged);
  });

  async function run(input, whenChanged) {
    try {
      const done = edit ? await saveEdit(edit, input, whenChanged) : await commitEvening(() => createEvening(buildCreateBody(input, localTimeZone())));
      if (sheet.closed) return;
      if (!done || (auth.profile ? auth.profile.id : '') !== pid0) { sheet.close(true); return; }
      toast(edit ? 'Soirée modifiée.' : 'Soirée planifiée.');
      sheet.close();
    } catch (err) {
      if (sheet.closed) return;
      if ((auth.profile ? auth.profile.id : '') !== pid0) { sheet.close(true); return; }
      setBusy(false);
      server(eveningErrorText(err));
    }
  }

  /** Modification : titre/horaire d'abord, puis invités retirés, puis invités ajoutés (la soirée est relue même si une étape échoue). */
  function saveEdit(ev, input, whenChanged) {
    const body = {};
    if (input.title.trim() !== ev.title) body.title = input.title.trim();
    if (whenChanged) body.startsAt = parseLocal(input.date, input.time);
    const chosen = form.querySelector('input[name="scope"]:checked');
    const scope = chosen instanceof HTMLInputElement && chosen.value === 'series' ? 'series' : 'occurrence';
    const now = new Set(input.guests);
    const removed = [...initial].filter((p) => !now.has(p));
    const added = input.guests.filter((p) => !initial.has(p));
    const patched = Object.keys(body).length > 0;
    return commitEvening(async () => {
      if (patched) await updateEvening(ev.id, { ...body, scope });
      for (const p of removed) await removeEveningGuest(ev.id, p);
      if (added.length) await inviteToEvening(ev.id, added);
    }, scope === 'series' && patched ? undefined : ev.id);
  }

  return sheet;
}
