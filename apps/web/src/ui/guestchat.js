/* Chat du salon, côté invité d'une watch party : tiroir latéral droit (controls.sideSlot) ouvert par le bouton « Chat » de la barre,
 * pastille de messages non lus tant qu'il est fermé, envoi (500 caractères au plus, Entrée), réactions emoji et affichage flottant
 * bref dans le cadre. Les messages sont posés en texte (textContent) : aucun balisage venu du salon n'est interprété.
 * Le port vient de GuestRelaySession.chatPort() (client du salon) ; rien d'autre (ni jeton, ni adresse) n'entre ici. */
import { CHAT_MAX_CHARS, REACTIONS } from '../party/protocol';
import { LI } from '../player/icons.js';
import { pad2 } from '../data/format';

/** Lignes gardées à l'écran (miroir de CHAT_MEMORY_LINES du client). */
export const CHAT_KEEP = 200;
/** Durée d'un emoji flottant (ms) et nombre maximal à l'écran. */
export const FLOAT_MS = 1800;
export const FLOAT_MAX = 12;
/** Barre de réactions : les six premières de la liste du salon. */
export const REACTION_BAR = REACTIONS.slice(0, 6);
const CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/></svg>';

/** Heure locale HH:MM d'un horodatage en millisecondes ; vide si illisible. */
export function clockOf(at) {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** Structure statique du tiroir (aucune donnée du salon ici). */
function drawerHtml() {
  return '<header class="gc-head"><h3>Chat du salon</h3>' +
    '<button type="button" class="lp-btn lp-btn-s gc-close" data-gc="close" aria-label="Fermer le chat" data-tip="Fermer le chat">' + LI.close + '</button></header>' +
    '<div class="gc-log" role="log" aria-live="polite" aria-label="Messages du salon"></div>' +
    '<div class="gc-react" role="group" aria-label="Réactions"></div>' +
    '<form class="gc-form" autocomplete="off">' +
    '<input class="gc-input" type="text" name="message" maxlength="' + CHAT_MAX_CHARS + '" placeholder="Écrire un message" aria-label="Message" enterkeyhint="send">' +
    '<button type="submit" class="btn btn-primary btn-sm">Envoyer</button></form>' +
    '<p class="gc-status" role="status" hidden></p>';
}

/**
 * Crée le tiroir, le bouton « Chat » (badge des non-lus) et les emojis flottants dans `controls` (createGuestControls).
 * Retourne : bind(port) (à appeler après GuestRelaySession.start()), unbind(), open(), close(), destroy().
 * onOpen() est appelé à l'ouverture du chat (le menu des sous-titres se referme alors).
 */
export function createGuestChat(controls, { onOpen } = {}) {
  const doc = controls.root.ownerDocument;
  const drawer = doc.createElement('section');
  drawer.className = 'gc';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Chat du salon');
  drawer.innerHTML = drawerHtml();
  controls.sideSlot.appendChild(drawer);
  const log = drawer.querySelector('.gc-log');
  const form = drawer.querySelector('.gc-form');
  const input = drawer.querySelector('.gc-input');
  const send = form.querySelector('button');
  const status = drawer.querySelector('.gc-status');
  const reactBar = drawer.querySelector('.gc-react');
  const closeBtn = drawer.querySelector('[data-gc="close"]');

  /** Emojis flottants, au-dessus de la barre (le cadre ignore les clics sur ce calque). */
  const fx = doc.createElement('div');
  fx.className = 'gc-fx';
  fx.setAttribute('aria-hidden', 'true');
  controls.root.appendChild(fx);

  const btn = controls.addMenuButton({ id: 'chat', icon: CHAT_ICON, label: 'Chat du salon', onClick: toggle });
  btn.setAttribute('aria-expanded', 'false');

  let port = null;
  let portOff = [];
  let open = false;
  let unread = 0;
  /** Vrai une fois le premier « bienvenue » de cette liaison reçu : les lignes suivantes comptent comme non lues. */
  let counting = false;
  let destroyed = false;
  /** Identifiants des lignes affichées (évite les doublons entre l'historique et les événements). */
  const shown = new Set();
  const timers = new Set();
  const listeners = [];
  const listen = (target, type, fn, capture = false) => {
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  };

  for (const e of REACTION_BAR) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'gc-emoji';
    b.textContent = e;
    b.setAttribute('aria-label', 'Réagir avec ' + e);
    listen(b, 'click', () => react(e));
    reactBar.appendChild(b);
  }

  function setStatus(msg) {
    status.textContent = msg || '';
    status.hidden = !msg;
  }

  function setEnabled(enabled) {
    input.disabled = !enabled;
    send.disabled = !enabled;
    for (const b of reactBar.querySelectorAll('button')) b.disabled = !enabled;
    input.placeholder = enabled ? 'Écrire un message' : 'Chat indisponible hors salon';
  }

  function showBadge() {
    if (!destroyed) controls.setChatBadge(unread);
  }

  /** Une ligne du salon : pseudo, heure locale, texte (posés avec textContent). */
  function lineEl(l, key) {
    const el = doc.createElement('div');
    el.className = 'gc-msg';
    el.dataset.id = key;
    const meta = doc.createElement('div');
    meta.className = 'gc-meta';
    const who = doc.createElement('span');
    who.className = 'gc-who';
    who.textContent = String(l.from ?? '');
    const time = doc.createElement('time');
    time.className = 'gc-time';
    time.textContent = clockOf(l.at);
    meta.append(who, time);
    const text = doc.createElement('p');
    text.className = 'gc-text';
    text.textContent = String(l.text ?? '');
    el.append(meta, text);
    return el;
  }

  function append(l, count) {
    const key = String(l?.id ?? '');
    if (!key || shown.has(key)) return;
    shown.add(key);
    log.appendChild(lineEl(l, key));
    while (log.childElementCount > CHAT_KEEP) {
      const old = log.firstElementChild;
      shown.delete(old.dataset.id);
      old.remove();
    }
    if (open) log.scrollTop = log.scrollHeight;
    else if (count) {
      unread += 1;
      showBadge();
    }
  }

  function onWelcome() {
    if (!port) return;
    // Historique à la (re)connexion : au premier accueil il ne compte pas ; ensuite, les lignes manquées comptent.
    for (const l of port.chat ?? []) append(l, counting);
    counting = true;
  }

  function onChat(l) {
    append(l, true);
  }

  function onRemoved(p) {
    const key = String(p?.messageId ?? '');
    if (!key || !shown.has(key)) return;
    shown.delete(key);
    for (const el of Array.from(log.children)) if (el.dataset.id === key) el.remove();
  }

  function onReact(r) {
    const emoji = r?.emoji;
    if (typeof emoji === 'string' && REACTIONS.includes(emoji)) float(emoji);
  }

  /** Emoji flottant bref dans le cadre ; le plus ancien part quand il y en a trop. */
  function float(emoji) {
    if (destroyed) return;
    while (fx.childElementCount >= FLOAT_MAX) fx.firstElementChild.remove();
    const el = doc.createElement('span');
    el.className = 'gc-fl';
    el.textContent = emoji;
    el.style.left = Math.round(Math.random() * 80) + '%';
    fx.appendChild(el);
    const id = setTimeout(() => {
      timers.delete(id);
      el.remove();
    }, FLOAT_MS);
    timers.add(id);
  }

  function sendText(e) {
    e.preventDefault();
    if (destroyed) return;
    if (!port) {
      setStatus('Chat indisponible : rejoins le salon.');
      return;
    }
    const text = input.value.trim().slice(0, CHAT_MAX_CHARS);
    if (!text) return;
    if (port.sendChat(text)) {
      input.value = '';
      setStatus('');
    } else {
      setStatus('Message non envoyé : connexion au salon en cours.');
    }
  }

  function react(emoji) {
    if (destroyed || !port) return;
    setStatus(port.sendReact(emoji) ? '' : 'Réaction non envoyée : connexion au salon en cours.');
  }

  function openDrawer() {
    if (destroyed || open) return;
    open = true;
    drawer.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    unread = 0;
    showBadge();
    log.scrollTop = log.scrollHeight;
    onOpen?.();
  }

  function closeDrawer() {
    if (!open) return;
    open = false;
    drawer.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (open) closeDrawer();
    else openDrawer();
  }

  /** Lie le chat au client du salon : historique affiché, événements écoutés, saisie activée. */
  function bind(p) {
    unbind();
    if (destroyed || !p) return;
    port = p;
    counting = false;
    portOff = [
      p.on('welcome', onWelcome),
      p.on('chat', onChat),
      p.on('react', onReact),
      p.on('removed', onRemoved),
    ];
    for (const l of p.chat ?? []) append(l, false);
    setEnabled(true);
  }

  /** Délie du salon et vide le tiroir (la séance est finie ou quittée). */
  function unbind() {
    for (const off of portOff) off();
    portOff = [];
    port = null;
    counting = false;
    shown.clear();
    log.textContent = '';
    unread = 0;
    showBadge();
    setStatus('');
    setEnabled(false);
  }

  listen(form, 'submit', sendText);
  listen(closeBtn, 'click', closeDrawer);
  // Phase de capture sur la page : Échap ferme le tiroir (où qu'est le focus) avant le gestionnaire global (events.js) qui quitterait la page.
  listen(doc, 'keydown', (e) => {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDrawer();
    }
  }, true);

  setEnabled(false);

  function destroy() {
    if (destroyed) return;
    unbind();
    destroyed = true;
    for (const [t, type, fn, capture] of listeners) t.removeEventListener(type, fn, capture);
    listeners.length = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    drawer.remove();
    fx.remove();
    btn.remove();
  }

  return { bind, unbind, open: openDrawer, close: closeDrawer, destroy };
}
