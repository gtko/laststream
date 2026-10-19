import { MESSAGE_MAX, type SocialState } from '../data/socialStore';
import type { Message, SocialMe, Status } from '../data/socialV2Api';
import { FALLBACK_COLOR, safeColor } from './notesTimeline';

/* Bulle de message entrant, haut gauche du lecteur (Social v2) : un message d'un ami pendant la lecture s'affiche
 * quelques secondes (avatar, handle, texte tronqué). Clic = ouvre la discussion, le lecteur reste ouvert. Touche R =
 * réponse rapide dans la bulle : Entrée envoie, Échap annule ; la saisie ne déclenche aucun raccourci du lecteur.
 * Rien en statut « Ne pas déranger ». Une seule bulle à la fois : un message qui arrive pendant une réponse attend
 * (une seule place). Tout texte passe par textContent, jamais par innerHTML. */

export const BUBBLE_MS = 6_000;
export const BUBBLE_TEXT_MAX = 120;
/** Un message plus ancien que ça, par rapport à l'ouverture du lecteur, n'est pas « nouveau » (horloges désalignées comprises). */
const RECENT_MS = 30_000;
const SEND_FAILED = 'Message non envoyé, réessaie plus tard';
const SEND_LIMIT = 'Trop de messages : réessaie dans une minute';

export interface BubbleDeps {
  getState(): SocialState;
  subscribe(fn: (s: SocialState) => void): () => void;
  send(pid: string, body: string): Promise<unknown>;
  openConversation(pid: string): void;
  now?(): number;
}

export interface MessageBubble {
  readonly el: HTMLElement;
  start(): void;
  stop(): void;
  /** Vrai pendant qu'une réponse est saisie. */
  isReplying(): boolean;
}

/** Décision : un message reçu par moi (pas envoyé par moi), et mon statut n'est pas « Ne pas déranger ». */
export function shouldShowBubble(msg: Message | null | undefined, me: Pick<SocialMe, 'pid'> | null, status: Status): boolean {
  if (!msg || !me || status === 'dnd') return false;
  return msg.from !== me.pid && msg.to === me.pid;
}

/** Texte de la bulle : espaces repliés, au plus `max` caractères (« … » compris). Compte les caractères, pas les unités UTF-16. */
export function truncateText(text: string, max = BUBBLE_TEXT_MAX): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…';
}

/** Messages connus du store : dernier message de chaque conversation et messages chargés, sans doublon. */
export function knownMessages(s: SocialState): Message[] {
  const byId = new Map<string, Message>();
  for (const c of s.conversations) if (c.last) byId.set(c.last.id, c.last);
  for (const list of Object.values(s.messages)) for (const m of list) byId.set(m.id, m);
  return [...byId.values()];
}

/** Nom et couleur d'un correspondant : amis et foyer, puis conversations ; repli si inconnu. */
export function senderOf(s: SocialState, pid: string): { who: string; color: string } {
  const f = [...s.friends, ...s.household].find((x) => x.pid === pid);
  if (f) return { who: f.handle.full, color: safeColor(f.avatarColor) };
  const c = s.conversations.find((x) => x.pid === pid);
  if (c) return { who: c.handle.full, color: safeColor(c.avatarColor) };
  return { who: 'Un ami', color: FALLBACK_COLOR };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Saisie en cours dans un champ : les touches appartiennent à ce champ. */
function isTyping(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

/** Fenêtre de l'application ouverte, ou popover de réaction : la touche R ne doit pas s'y glisser. */
function otherUiOpen(): boolean {
  return document.querySelector('#modal:not([hidden]), .lp-react:not([hidden])') !== null;
}

/** Crée la bulle dans `host` (le lecteur), cachée. `start` s'abonne au store, `stop` se désabonne et la retire. */
export function createMessageBubble(host: HTMLElement, deps: BubbleDeps): MessageBubble {
  const now = deps.now ?? (() => Date.now());

  const root = el('div', 'lp-bubble');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;

  const main = el('button', 'lp-bubble-main');
  main.type = 'button';
  const head = el('span', 'lp-bubble-head');
  const av = el('span', 'lp-bubble-av');
  const who = el('b', 'lp-bubble-who');
  head.append(av, who);
  const text = el('span', 'lp-bubble-txt');
  main.append(head, text);

  const acts = el('div', 'lp-bubble-acts');
  const reply = el('button', 'lp-bubble-reply', 'Répondre ');
  reply.type = 'button';
  reply.append(el('kbd', '', 'R'));
  acts.append(reply);

  const form = el('form', 'lp-bubble-form');
  form.hidden = true;
  const input = el('input', 'lp-bubble-in');
  input.type = 'text';
  input.maxLength = MESSAGE_MAX;
  input.autocomplete = 'off';
  input.placeholder = 'Votre réponse';
  input.setAttribute('aria-label', 'Réponse, ' + MESSAGE_MAX + ' caractères au plus');
  const send = el('button', 'btn btn-primary lp-bubble-send', 'Envoyer');
  send.type = 'submit';
  send.disabled = true;
  const err = el('p', 'lp-bubble-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  form.append(input, send, err);

  root.append(main, acts, form);
  host.append(root);

  let current: Message | null = null;
  let queued: Message | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let replying = false;
  let sending = false;
  let running = false;
  let unsub: (() => void) | null = null;
  let seen = new Set<string>();
  let since = 0;

  const clearTimer = (): void => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };

  function hide(): void {
    clearTimer();
    current = null;
    root.hidden = true;
  }

  function endReply(): void {
    replying = false;
    sending = false;
    form.hidden = true;
    acts.hidden = false;
    err.hidden = true;
    input.value = '';
  }

  /** Fin de réponse (envoyée, annulée ou arrêt) : la bulle en attente prend la place, sinon la bulle se ferme. */
  function settle(): void {
    endReply();
    const next = queued;
    queued = null;
    hide();
    if (next && running) offer(next);
  }

  function showNow(m: Message): void {
    const from = senderOf(deps.getState(), m.from);
    current = m;
    av.style.background = from.color;
    who.textContent = from.who;
    text.textContent = truncateText(m.body);
    root.hidden = false;
    clearTimer();
    hideTimer = setTimeout(hide, BUBBLE_MS);
  }

  /** Affiche `m` si la décision le permet ; pendant une réponse, il attend. */
  function offer(m: Message): void {
    if (!shouldShowBubble(m, deps.getState().me, deps.getState().status)) return;
    if (replying) {
      queued = m;
      return;
    }
    showNow(m);
  }

  function openReply(): void {
    if (!current || replying) return;
    replying = true;
    clearTimer();
    input.value = '';
    send.disabled = true;
    err.hidden = true;
    acts.hidden = true;
    form.hidden = false;
    input.focus({ preventScroll: true });
  }

  function onDocKey(e: KeyboardEvent): void {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (root.hidden || replying || isTyping(e.target) || otherUiOpen()) return;
    e.preventDefault();
    openReply();
  }

  /** Nouveaux messages dans l'état : chacun n'est considéré qu'une fois ; le plus récent s'affiche. */
  function onState(s: SocialState): void {
    let latest: Message | null = null;
    for (const m of knownMessages(s)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.createdAt < since - RECENT_MS || !shouldShowBubble(m, s.me, s.status)) continue;
      if (!latest || m.createdAt >= latest.createdAt) latest = m;
    }
    if (latest) offer(latest);
  }

  reply.addEventListener('click', openReply);

  main.addEventListener('click', () => {
    const m = current;
    if (!m) return;
    queued = null;
    settle();
    deps.openConversation(m.from);
  });

  input.addEventListener('input', () => {
    send.disabled = input.value.trim() === '';
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // le lecteur ne reçoit pas la saisie
    if (e.key === 'Escape') {
      e.preventDefault();
      settle();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = current;
    const body = input.value.trim();
    if (!m || !body || sending) return;
    sending = true;
    send.disabled = true;
    err.hidden = true;
    deps.send(m.from, body).then(() => {
      if (running) settle();
    }, (x: unknown) => {
      if (!running) return;
      sending = false;
      send.disabled = input.value.trim() === '';
      err.textContent = (x as { status?: number } | null)?.status === 429 ? SEND_LIMIT : SEND_FAILED;
      err.hidden = false;
    });
  });

  return {
    el: root,
    start() {
      if (running) return;
      running = true;
      since = now();
      seen = new Set(knownMessages(deps.getState()).map((m) => m.id));
      unsub = deps.subscribe(onState);
      document.addEventListener('keydown', onDocKey);
    },
    stop() {
      if (!running) return;
      running = false;
      unsub?.();
      unsub = null;
      document.removeEventListener('keydown', onDocKey);
      seen = new Set();
      queued = null;
      endReply();
      hide();
    },
    isReplying: () => replying,
  };
}
