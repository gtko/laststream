/* Éditeur du statut personnalisé (ODY-174) : petite fenêtre ouverte depuis « Statut personnalisé… » du menu de présence de la
 * sidebar, au lieu de l'écran « Mon profil social » complet. Emoji, texte, échéance d'effacement, enregistrer / effacer ; le
 * statut actuel est pré-rempli. Le statut passe par la même route que l'écran Profil (store.saveProfile, champ customStatus) et
 * par les mêmes règles (socialProfileModel : EMOJIS, EXPIRIES, customStatusOf). Tout texte est posé avec textContent. */
import * as store from '../data/socialStore';
import { toast } from './dom.js';
import { customStatusText, socialErrorMessage } from './socialFmt.js';
import { EMOJIS, EXPIRIES, STATUS_TEXT_MAX, charCount, customStatusOf } from './socialProfileModel.js';

const FOCUSABLE = 'input:not([disabled]), button:not([disabled])';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/**
 * Ouvre l'éditeur dans `host` (la sidebar : le fond s'étend sur elle, comme les dialogues de la fiche ami) et renvoie une
 * fonction de fermeture. Le focus part dans le champ de texte et revient sur `opener` à la fermeture.
 */
export function openStatusEditor(host, opener = document.activeElement) {
  host.querySelector('.ss-se-bk')?.remove();

  /** `expiry` vaut 'keep' (échéance déjà posée, conservée), '4h', 'tonight' ou 'never' : même convention que l'écran Profil. */
  const d = { emoji: '', statusText: '', expiry: 'never', expiresAt: undefined };
  let hadStatus = false;
  let touched = false;
  let busy = false;
  let emojiOpen = false;

  const fillFrom = (profile) => {
    const cs = (profile && profile.customStatus) || {};
    const live = customStatusText(cs) !== '';
    hadStatus = live;
    d.emoji = live ? cs.emoji || '' : '';
    d.statusText = live ? cs.text || '' : '';
    d.expiresAt = live ? cs.expiresAt : undefined;
    d.expiry = live && cs.expiresAt ? 'keep' : 'never';
  };
  fillFrom(store.getState().profile);

  const input = h('input', {
    id: 'ss-se-text', class: 'ss-input ss-se-input', maxlength: String(STATUS_TEXT_MAX), autocomplete: 'off',
    placeholder: 'Un mot sur ce que tu fais', 'aria-describedby': 'ss-se-count',
  });
  input.value = d.statusText;
  const count = h('span', { id: 'ss-se-count', class: 'ss-hint ss-se-count' });
  const err = h('p', { class: 'ss-se-err', role: 'alert', hidden: true });
  // Les contrôles sont créés une fois et mis à jour sur place : recréer un bouton qui a le focus le ferait tomber sur <body>.
  const emojiBtn = h('button', {
    type: 'button', class: 'ss-se-emoji', 'aria-label': 'Choisir un emoji', 'aria-expanded': 'false', 'aria-controls': 'ss-se-pop',
    on: { click: () => setEmojiOpen(!emojiOpen) },
  });
  const emojiPop = h('div', { id: 'ss-se-pop', class: 'ss-se-pop', role: 'group', 'aria-label': 'Emojis', hidden: true },
    ...EMOJIS.map((e) => h('button', { type: 'button', class: 'ss-se-e', text: e, on: { click: () => pick(e) } })),
    h('button', { type: 'button', class: 'ss-se-e ss-se-e--none', text: 'Aucun', on: { click: () => pick('') } }));
  const emojiZone = h('span', { class: 'ss-se-emoji-wrap' }, emojiBtn, emojiPop);
  const chips = EXPIRIES.map(([v, text]) => h('button', { type: 'button', class: 'ss-se-chip', text, on: { click: () => { d.expiry = v; touched = true; paint(); } } }));
  const keepHint = h('span', { class: 'ss-hint', hidden: true });
  const expiryZone = h('div', { class: 'ss-se-chips', role: 'group', 'aria-labelledby': 'ss-se-exp' }, ...chips, keepHint);
  const clearBtn = h('button', { type: 'button', class: 'ss-btn2 ss-se-clear', text: 'Effacer le statut', on: { click: () => save(true) } });
  const okBtn = h('button', { type: 'submit', class: 'ss-btn2 ss-pri', text: 'Enregistrer' });
  const cancelBtn = h('button', { type: 'button', class: 'ss-btn2 ss-sec', text: 'Annuler', on: { click: () => close() } });

  const showError = (msg) => { err.textContent = msg; err.hidden = !msg; };

  function setEmojiOpen(on) {
    emojiOpen = on;
    paint();
    if (on) emojiPop.querySelector('button')?.focus({ preventScroll: true });
  }

  function paint() {
    count.textContent = charCount(d.statusText) + ' / ' + STATUS_TEXT_MAX;
    clearBtn.hidden = !hadStatus;
    clearBtn.disabled = busy;
    okBtn.disabled = busy;
    emojiBtn.textContent = d.emoji || '🙂';
    emojiBtn.setAttribute('aria-expanded', String(emojiOpen));
    emojiPop.hidden = !emojiOpen;
    EXPIRIES.forEach(([v], i) => {
      chips[i].classList.toggle('on', d.expiry === v);
      chips[i].setAttribute('aria-pressed', String(d.expiry === v));
    });
    keepHint.hidden = !(d.expiry === 'keep' && d.expiresAt);
    if (!keepHint.hidden) keepHint.textContent = 'Efface le ' + new Date(d.expiresAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function pick(e) {
    d.emoji = e;
    emojiOpen = false;
    touched = true;
    paint();
    input.focus({ preventScroll: true });
  }

  input.addEventListener('input', () => { d.statusText = input.value; touched = true; showError(''); paint(); });

  async function save(clear = false) {
    if (busy) return;
    // « Effacer » n'abîme pas le brouillon : si l'envoi échoue, le formulaire reste ce que la personne voit.
    const after = customStatusOf(clear ? { ...d, emoji: '', statusText: '' } : d, Date.now());
    if (after === null && !hadStatus) { close(); return; }
    busy = true;
    showError('');
    paint();
    try {
      await store.saveProfile({ customStatus: after });
      toast(after === null ? 'Statut effacé' : 'Statut enregistré');
      close();
    } catch (e) {
      busy = false;
      showError('Statut non enregistré : ' + socialErrorMessage(e));
      paint();
    }
  }

  const form = h('form', { class: 'ss-dlg ss-se', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ss-se-t', novalidate: true, on: { submit: (e) => { e.preventDefault(); save(); } } },
    h('h3', { class: 'ss-dlg-t', id: 'ss-se-t', text: 'Mon statut' }),
    h('div', { class: 'ss-se-field' },
      h('label', { class: 'ss-se-lb', for: 'ss-se-text', text: 'Statut personnalisé' }),
      h('div', { class: 'ss-se-row' }, emojiZone, input),
      count),
    h('div', { class: 'ss-se-field' }, h('span', { class: 'ss-se-lb', id: 'ss-se-exp', text: 'Effacer automatiquement' }), expiryZone),
    err,
    h('div', { class: 'ss-dlg-acts' }, clearBtn, h('span', { class: 'ss-se-sp' }), cancelBtn, okBtn));

  const bk = h('div', { class: 'ss-dlg-bk ss-se-bk', on: { click: (e) => { if (e.target === bk) close(); } } }, form);
  bk.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (emojiOpen) { emojiOpen = false; paint(); emojiBtn.focus({ preventScroll: true }); } else close();
    } else if (e.key === 'Tab') {
      const items = Array.from(form.querySelectorAll(FOCUSABLE)).filter((el) => !el.closest('[hidden]') && !el.hidden);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  function close() {
    bk.remove();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  }

  paint();
  host.append(bk);
  input.focus({ preventScroll: true });

  // Le profil peut ne pas être chargé (ouverture directe) : on le lit, sans écraser ce que la personne a déjà tapé.
  if (!store.getState().profile) {
    store.loadProfile().then((p) => {
      if (!bk.isConnected || touched) return;
      fillFrom(p);
      input.value = d.statusText;
      paint();
    }).catch(() => { /* l'éditeur reste utilisable à vide */ });
  }
  return close;
}
