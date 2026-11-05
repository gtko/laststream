import { MESSAGE_MAX, type SocialState } from '../data/socialStore';
import type { Message, SocialMe, Status } from '../data/socialV2Api';
import { requestWake } from './idle';
import { FALLBACK_COLOR, safeColor } from './notesTimeline';
import { advanceBubble, emptyQueue, initialOf, isTouchLayout, pushBubble, type BubbleQueue } from './playbackSocial';

/* Bulle de message entrant, haut gauche du lecteur (Social v3) : transparente, texte à forte ombre, ombre de coin,
 * arrivée animée (ombre qui s'ouvre, avatar avec rebond, texte qui glisse du flou au net). Champ de réponse et emojis
 * UNIQUEMENT au survol (desktop) ou au toucher (mobile) ; la bulle reste tant que la souris est dessus. Touche R =
 * réponse rapide : Entrée envoie, Échap annule ; la saisie ne déclenche aucun raccourci du lecteur. Les messages
 * suivants s'empilent dessous. Rien en « Ne pas déranger », ni quand le mode cinéma masque les bulles. Tout texte
 * passe par textContent, jamais par innerHTML. */

export const BUBBLE_MS = 6_000;
export const BUBBLE_TEXT_MAX = 120;
/** Un message plus ancien que ça, par rapport à l'ouverture du lecteur, n'est pas « nouveau » (horloges désalignées comprises). */
export const RECENT_MS = 30_000;
export const SEND_FAILED = 'Message non envoyé, réessaie plus tard';
export const SEND_LIMIT = 'Trop de messages : réessaie dans une minute';
/** Réponses par emoji de la maquette. */
export const REPLY_EMOJIS: ReadonlyArray<{ e: string; label: string }> = [{ e: '😂', label: 'rire' }, { e: '❤️', label: 'cœur' }];

export interface BubbleDeps {
  getState(): SocialState;
  subscribe(fn: (s: SocialState) => void): () => void;
  send(pid: string, body: string): Promise<unknown>;
  openConversation(pid: string): void;
  now?(): number;
  /** Faux quand le mode cinéma masque les bulles. */
  enabled?(): boolean;
  /** Version tactile (toucher pour répondre) ; par défaut selon l'écran. */
  touch?(): boolean;
}

export interface MessageBubble {
  readonly el: HTMLElement;
  start(): void;
  stop(): void;
  /** Vrai pendant qu'une réponse est saisie. */
  isReplying(): boolean;
  /** Ami du message affiché (ou du dernier reçu) : sert au « aussi envoyer en message » de « Réagir ici ». */
  lastPeer(): { pid: string; who: string } | null;
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

const avatarOf = (a: unknown): string | undefined => (typeof a === 'string' && a !== '' && a.length <= 200 ? a : undefined);

/** Nom et couleur d'un correspondant : amis et foyer, puis conversations ; repli si inconnu. Le nom est sans étiquette `#TAG`. */
export function senderOf(s: SocialState, pid: string): { who: string; color: string; avatar?: string } {
  const f = [...s.friends, ...s.household].find((x) => x.pid === pid);
  if (f) return { who: f.handle.name, color: safeColor(f.avatarColor), avatar: avatarOf(f.avatar) };
  const c = s.conversations.find((x) => x.pid === pid);
  if (c) return { who: c.handle.name, color: safeColor(c.avatarColor), avatar: avatarOf((c as { avatar?: unknown }).avatar) };
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
  return document.querySelector('#modal:not([hidden]), .lp-react:not([hidden]), .lp-cinema-menu:not([hidden])') !== null;
}

/** Relance une animation CSS (retire puis remet la classe). */
function replay(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

const CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const SEND_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/** Crée la bulle dans `host` (le lecteur), cachée. `start` s'abonne au store, `stop` se désabonne et la retire. */
export function createMessageBubble(host: HTMLElement, deps: BubbleDeps): MessageBubble {
  const now = deps.now ?? (() => Date.now());
  const touch = deps.touch ?? isTouchLayout;

  // Ombre radiale du coin haut gauche (≤ rgba(0,0,0,.42)), derrière la bulle.
  const vig = el('div', 'lp-bubble-vig');
  vig.setAttribute('aria-hidden', 'true');
  vig.hidden = true;

  const root = el('div', 'lp-bubble');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;

  const card = el('div', 'lp-bubble-card');
  const main = el('button', 'lp-bubble-main');
  main.type = 'button';
  const av = el('span', 'lp-bubble-av');
  const col = el('span', 'lp-bubble-col');
  const head = el('span', 'lp-bubble-head');
  const who = el('b', 'lp-bubble-who');
  const when = el('span', 'lp-bubble-when', 'à l’instant');
  head.append(who, when);
  const text = el('span', 'lp-bubble-txt');
  col.append(head, text);
  main.append(av, col);

  const form = el('form', 'lp-bubble-form');
  form.hidden = true;
  const input = el('input', 'lp-bubble-in');
  input.type = 'text';
  input.maxLength = MESSAGE_MAX;
  input.autocomplete = 'off';
  input.placeholder = 'Répondre…';
  input.setAttribute('aria-label', 'Réponse, ' + MESSAGE_MAX + ' caractères au plus');
  const send = el('button', 'lp-bubble-send');
  send.type = 'submit';
  send.disabled = true;
  send.setAttribute('aria-label', 'Envoyer');
  send.innerHTML = SEND_ICON;
  const emojiBtns = REPLY_EMOJIS.map(({ e, label }) => {
    const b = el('button', 'lp-bubble-emo', e);
    b.type = 'button';
    b.setAttribute('aria-label', 'Répondre par un emoji : ' + label);
    return b;
  });
  const dismiss = el('button', 'lp-bubble-x');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Masquer');
  dismiss.innerHTML = CLOSE_ICON;
  const open = el('button', 'lp-bubble-open', 'Ouvrir la discussion');
  open.type = 'button';
  const err = el('p', 'lp-bubble-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const hint = el('p', 'lp-bubble-hint', 'La bulle reste tant que la souris est dessus · R pour répondre au clavier');
  form.append(input, send, ...emojiBtns, dismiss, err, hint, open);
  card.append(main, form);

  const stackEl = el('div', 'lp-bubble-stack');
  stackEl.hidden = true;
  const stackAv = el('span', 'lp-bubble-av lp-bubble-av-s');
  const stackWho = el('b', 'lp-bubble-who');
  const stackTxt = el('span', 'lp-bubble-stack-txt');
  stackEl.append(stackAv, stackWho, stackTxt);

  root.append(card, stackEl);
  host.append(vig, root);

  let q: BubbleQueue = emptyQueue();
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let replying = false;
  let hovering = false;
  let sending = false;
  let running = false;
  let unsub: (() => void) | null = null;
  let seen = new Set<string>();
  let since = 0;
  let lastFrom: string | null = null;

  const clearTimer = (): void => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  /**
   * Ce qui retient la bulle : le pointeur dessus, un envoi en cours, le focus dans la carte ou un brouillon écrit. Calculé
   * sur l'état réel (pas sur un drapeau resté à vrai) : sans rien de cela, le délai court et la bulle se ferme.
   */
  const locked = (): boolean => hovering || sending || root.contains(document.activeElement) || input.value.trim() !== '';
  /** Vrai si la bulle peut apparaître : pas en mode cinéma (`enabled`), pas en « Ne pas déranger ». */
  const allowed = (s: SocialState): boolean => (!deps.enabled || deps.enabled()) && s.status !== 'dnd';

  function paintAvatar(node: HTMLElement, pid: string): string {
    const from = senderOf(deps.getState(), pid);
    node.style.backgroundImage = '';
    node.style.backgroundColor = from.color;
    node.textContent = initialOf(from.who); // repli : lettre sur la couleur, tant que l'illustration n'est pas posée
    for (const k of ['art', 'artPending', 'artFailed']) delete node.dataset[k];
    // L'illustration réelle (collection d'avatars) est posée par avatar-art.js sur tout élément [data-avatar].
    if (from.avatar) node.dataset.avatar = from.avatar; else delete node.dataset.avatar;
    return from.who;
  }

  function paintStack(): void {
    const n = q.next[0];
    stackEl.hidden = !n || q.current === null;
    if (!n) return;
    stackWho.textContent = paintAvatar(stackAv, n.from);
    stackTxt.textContent = truncateText(n.body, 60);
    replay(stackEl, 'is-in');
  }

  function showForm(on: boolean): void {
    form.hidden = !on;
    card.classList.toggle('is-open', on);
  }

  function endReply(): void {
    replying = false;
    sending = false;
    showForm(false);
    err.hidden = true;
    input.value = '';
    send.disabled = true;
  }

  function armTimer(): void {
    clearTimer();
    if (locked()) return;
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      // Retenue entre-temps (survol, focus, brouillon) : la bulle reste, le délai repartira au relâchement.
      if (!locked()) hide();
    }, BUBBLE_MS);
  }

  /** Plus rien ne retient la bulle : le champ se referme et le délai repart. */
  function relax(): void {
    if (locked()) return;
    replying = false;
    showForm(false);
    if (q.current) armTimer();
  }

  function render(m: Message): void {
    const name = paintAvatar(av, m.from);
    who.textContent = name;
    when.textContent = touch() ? 'toucher pour répondre' : 'à l’instant';
    text.textContent = truncateText(m.body);
    input.placeholder = 'Répondre à ' + name + '…';
    lastFrom = m.from;
    vig.hidden = false;
    root.hidden = false;
    requestWake(root);
    for (const [node, cls] of [[vig, 'is-in'], [av, 'is-in'], [who.parentElement as HTMLElement, 'is-in'], [text, 'is-in']] as Array<[HTMLElement, string]>) replay(node, cls);
    paintStack();
    armTimer();
  }

  /** Ferme la bulle courante ; la suivante en attente prend la place. */
  function hide(): void {
    clearTimer();
    endReply();
    hovering = false;
    q = advanceBubble(q);
    if (q.current && running) {
      render(q.current);
      return;
    }
    conceal();
  }

  /** Retire la bulle et sa file sans attendre (mode cinéma, « Ne pas déranger », arrêt) : délai, survol et réponse sont levés. */
  function conceal(): void {
    clearTimer();
    endReply();
    hovering = false;
    q = emptyQueue();
    vig.hidden = true;
    root.hidden = true;
    stackEl.hidden = true;
  }

  /** Affiche `m` si la décision le permet ; sinon (bulle occupée ou réponse en cours) il s'empile. */
  function offer(m: Message): void {
    if (deps.enabled && !deps.enabled()) return;
    const s = deps.getState();
    if (!shouldShowBubble(m, s.me, s.status)) return;
    const free = q.current === null;
    q = pushBubble(q, m, replying);
    if (free && q.current === m) render(m);
    else paintStack();
  }

  function openReply(): void {
    if (!q.current || replying) return;
    replying = true;
    clearTimer();
    input.value = '';
    send.disabled = true;
    err.hidden = true;
    showForm(true);
    input.focus({ preventScroll: true });
  }

  function onDocKey(e: KeyboardEvent): void {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (root.hidden || isTyping(e.target) || otherUiOpen()) return;
    if (replying) {
      // Brouillon laissé puis Tab hors de la carte : `replying` reste vrai, R ramène le focus dans le champ.
      if (root.contains(document.activeElement)) return;
      e.preventDefault();
      input.focus({ preventScroll: true });
      return;
    }
    e.preventDefault();
    openReply();
  }

  /** Nouveaux messages dans l'état : chacun n'est considéré qu'une fois ; ceux d'un même lot s'empilent par ordre d'arrivée. */
  function onState(s: SocialState): void {
    const fresh: Message[] = [];
    for (const m of knownMessages(s)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.createdAt < since - RECENT_MS || !shouldShowBubble(m, s.me, s.status)) continue;
      fresh.push(m);
    }
    // Mode cinéma ou « Ne pas déranger » : une bulle déjà affichée s'efface tout de suite, sans attendre son délai.
    if (!allowed(s)) {
      if (q.current) conceal();
      return;
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => a.createdAt - b.createdAt);
    // Un lot : seul le plus récent compte (une seule place), les anciens du lot ne s'empilent pas.
    offer(fresh[fresh.length - 1]);
  }

  function submitBody(body: string): void {
    const m = q.current;
    const t = body.trim();
    if (!m || !t || sending) return;
    sending = true;
    send.disabled = true;
    err.hidden = true;
    deps.send(m.from, t).then(() => {
      if (running) hide();
    }, (x: unknown) => {
      if (!running) return;
      sending = false;
      send.disabled = input.value.trim() === '';
      err.textContent = (x as { status?: number } | null)?.status === 429 ? SEND_LIMIT : SEND_FAILED;
      err.hidden = false;
    });
  }

  // Survol / focus : la bulle prend un fond léger, le champ et les emojis apparaissent, le délai est suspendu.
  card.addEventListener('mouseenter', () => {
    hovering = true;
    clearTimer();
    if (!touch()) showForm(true);
  });
  card.addEventListener('mouseleave', () => {
    hovering = false;
    relax();
  });
  card.addEventListener('focusin', () => {
    clearTimer();
    if (!touch()) showForm(true);
  });
  card.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget;
    if (to instanceof Node && card.contains(to)) return;
    relax();
  });

  main.addEventListener('click', () => {
    const m = q.current;
    if (!m) return;
    if (touch()) {
      // Mobile : toucher la bulle ouvre la réponse (éventail d'emojis compris).
      if (!replying) { replying = true; clearTimer(); showForm(true); input.focus({ preventScroll: true }); }
      return;
    }
    q = emptyQueue();
    hide();
    deps.openConversation(m.from);
  });
  open.addEventListener('click', () => {
    const m = q.current;
    if (!m) return;
    q = emptyQueue();
    hide();
    deps.openConversation(m.from);
  });
  dismiss.addEventListener('click', () => hide());
  for (let i = 0; i < emojiBtns.length; i++) emojiBtns[i].addEventListener('click', () => submitBody(REPLY_EMOJIS[i].e));

  input.addEventListener('focus', () => { replying = true; clearTimer(); });
  input.addEventListener('input', () => {
    send.disabled = input.value.trim() === '';
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // le lecteur ne reçoit pas la saisie
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitBody(input.value);
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
      conceal();
    },
    isReplying: () => replying,
    lastPeer() {
      if (!lastFrom) return null;
      return { pid: lastFrom, who: senderOf(deps.getState(), lastFrom).who };
    },
  };
}
