// Bulle de message entrant du lecteur (Social v2, lot 4b) : décision (dnd, moi, nouveauté), troncature, rendu DOM sans
// injection, clic vers la discussion, réponse rapide (R, Entrée, Échap), file d'attente d'une place, erreurs d'envoi.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUBBLE_MS, BUBBLE_TEXT_MAX, createMessageBubble, knownMessages, senderOf, shouldShowBubble, truncateText, type BubbleDeps,
} from '../src/player/messageBubble';
import { initialSocialState, type SocialState } from '../src/data/socialStore';
import type { Handle, Message, SocialMe } from '../src/data/socialV2Api';

const H = (name: string, tag: string): Handle => ({ name, tag, full: `${name}#${tag}` });
const ME: SocialMe = { pid: 'me', handle: H('Greg', 'A7K2'), status: 'online', avatarColor: '#111111' };
const AMY = { pid: 'amy', handle: H('Amy', 'B2C3'), avatarColor: '#aa0000', household: false, status: 'online' as const };
const NOW = 1_000_000;
const msg = (id: string, from: string, to: string, body: string, createdAt = NOW): Message => ({ id, from, to, body, createdAt });

describe('décision', () => {
  it('affiche un message reçu d’un autre profil, hors « Ne pas déranger »', () => {
    const m = msg('1', 'amy', 'me', 'Salut');
    expect(shouldShowBubble(m, ME, 'online')).toBe(true);
    expect(shouldShowBubble(m, ME, 'away')).toBe(true);
  });

  it('rien en « Ne pas déranger »', () => {
    expect(shouldShowBubble(msg('1', 'amy', 'me', 'Salut'), ME, 'dnd')).toBe(false);
  });

  it('jamais un message envoyé par moi, ni sans profil connu, ni adressé à un autre profil', () => {
    expect(shouldShowBubble(msg('1', 'me', 'amy', 'Salut'), ME, 'online')).toBe(false);
    expect(shouldShowBubble(msg('1', 'amy', 'me', 'Salut'), null, 'online')).toBe(false);
    expect(shouldShowBubble(msg('1', 'amy', 'autre', 'Salut'), ME, 'online')).toBe(false);
    expect(shouldShowBubble(undefined, ME, 'online')).toBe(false);
  });

  it('texte : espaces repliés, au plus 120 caractères « … » compris, caractères et non unités UTF-16', () => {
    expect(truncateText('  Salut\n\n  les   amis ')).toBe('Salut les amis');
    const long = truncateText('a'.repeat(300));
    expect(Array.from(long)).toHaveLength(BUBBLE_TEXT_MAX);
    expect(long.endsWith('…')).toBe(true);
    const emojis = truncateText('😀'.repeat(130));
    expect(Array.from(emojis)).toHaveLength(BUBBLE_TEXT_MAX);
    expect(Array.from(emojis).at(-1)).toBe('…');
  });

  it('expéditeur : ami puis conversation, couleur validée, repli si inconnu', () => {
    const s: SocialState = { ...initialSocialState(), me: ME, friends: [{ ...AMY, avatarColor: 'url(x)' }] };
    expect(senderOf(s, 'amy')).toEqual({ who: 'Amy', color: '#94a3b8' });
    expect(senderOf(s, 'inconnu')).toEqual({ who: 'Un ami', color: '#94a3b8' });
  });

  it('messages connus : sans doublon, dernier message de conversation inclus', () => {
    const m1 = msg('1', 'amy', 'me', 'un');
    const m2 = msg('2', 'amy', 'me', 'deux');
    const s: SocialState = {
      ...initialSocialState(), me: ME,
      conversations: [{ pid: 'amy', handle: AMY.handle, avatarColor: AMY.avatarColor, last: m2, unread: 1 }],
      messages: { amy: [m1, m2] },
    };
    expect(knownMessages(s).map((m) => m.id).sort()).toEqual(['1', '2']);
  });
});

// ---- Rendu et interactions ----
let state: SocialState;
let listener: ((s: SocialState) => void) | null;
let host: HTMLElement;

function stateWith(over: Partial<SocialState> = {}): SocialState {
  return { ...initialSocialState(), me: ME, status: 'online', friends: [AMY], ...over };
}
function push(over: Partial<SocialState>): void {
  state = { ...state, ...over };
  listener?.(state);
}
function makeDeps(over: Partial<BubbleDeps> = {}): BubbleDeps & { send: ReturnType<typeof vi.fn>; openConversation: ReturnType<typeof vi.fn> } {
  return {
    getState: () => state,
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    send: vi.fn(async () => ({})),
    openConversation: vi.fn(),
    now: () => NOW,
    ...over,
  } as BubbleDeps & { send: ReturnType<typeof vi.fn>; openConversation: ReturnType<typeof vi.fn> };
}
/** Un message de l'amie arrive : conversation et messages mis à jour comme le store les réduit. */
const incoming = (m: Message): Partial<SocialState> => ({
  conversations: [{ pid: 'amy', handle: AMY.handle, avatarColor: AMY.avatarColor, last: m, unread: 1 }],
  messages: { amy: [m] },
});
const $ = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector(sel) as T | null;
const keyOnDocument = (key: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('bulle dans le lecteur', () => {
  let bubble: ReturnType<typeof createMessageBubble>;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    state = stateWith();
    listener = null;
    host = document.createElement('div');
    document.body.append(host);
    deps = makeDeps();
    bubble = createMessageBubble(host, deps);
    bubble.start();
  });

  afterEach(() => {
    bubble.stop();
    host.remove();
    vi.useRealTimers();
  });

  it('crée une bulle cachée dans le lecteur, qui apparaît à l’arrivée d’un message', () => {
    expect($('.lp-bubble')).not.toBeNull();
    expect($('.lp-bubble')!.hidden).toBe(true);
    push(incoming(msg('m1', 'amy', 'me', 'On regarde ensemble ce soir ?')));
    expect($('.lp-bubble')!.hidden).toBe(false);
    expect($('.lp-bubble-who')!.textContent).toBe('Amy');
    expect($('.lp-bubble-txt')!.textContent).toBe('On regarde ensemble ce soir ?');
  });

  it('avatar réel de l’ami posé via data-avatar, repli lettre colorée sans avatar', () => {
    push({ friends: [{ ...AMY, avatar: 'col:c1:ch2' } as never], ...incoming(msg('m3', 'amy', 'me', 'Hello')) });
    const av = $('.lp-bubble-av')!;
    expect(av.dataset.avatar).toBe('col:c1:ch2');
    expect(av.textContent).toBe('A');
    expect(av.style.backgroundColor).not.toBe('');
    expect(senderOf({ ...state, friends: [AMY] }, 'amy').avatar).toBeUndefined();
  });

  it('rendu en texte : aucun élément créé à partir du contenu du message', () => {
    push(incoming(msg('m2', 'amy', 'me', '<img src=x onerror="alert(1)"><b class="x">gras</b>')));
    expect($('.lp-bubble img')).toBeNull();
    expect($('.lp-bubble-txt b')).toBeNull();
    expect($('.lp-bubble-txt')!.textContent).toContain('<img src=x');
  });

  it('texte long tronqué à l’affichage', () => {
    push(incoming(msg('m3', 'amy', 'me', 'x'.repeat(400))));
    expect(Array.from($('.lp-bubble-txt')!.textContent!)).toHaveLength(BUBBLE_TEXT_MAX);
  });

  it('se referme seule après 6 secondes', () => {
    vi.useFakeTimers();
    push(incoming(msg('m4', 'amy', 'me', 'Salut')));
    expect($('.lp-bubble')!.hidden).toBe(false);
    vi.advanceTimersByTime(BUBBLE_MS);
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('ne montre pas les messages déjà présents au démarrage, ni ceux que j’envoie', () => {
    bubble.stop();
    const old = msg('old', 'amy', 'me', 'ancien');
    state = stateWith(incoming(old));
    bubble = createMessageBubble(host, deps);
    bubble.start();
    push({});
    expect($('.lp-bubble')!.hidden).toBe(true);
    push(incoming(msg('mine', 'me', 'amy', 'moi')));
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('rien en « Ne pas déranger »', () => {
    push({ status: 'dnd', ...incoming(msg('m5', 'amy', 'me', 'Salut')) });
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('une seule bulle à la fois : le plus récent remplace', () => {
    push({
      conversations: [{ pid: 'amy', handle: AMY.handle, avatarColor: AMY.avatarColor, last: msg('b', 'amy', 'me', 'deux', NOW + 5), unread: 2 }],
      messages: { amy: [msg('a', 'amy', 'me', 'un', NOW), msg('b', 'amy', 'me', 'deux', NOW + 5)] },
    });
    expect($('.lp-bubble-txt')!.textContent).toBe('deux');
  });

  it('clic sur la bulle : ouvre la discussion, le lecteur reste ouvert (la bulle se ferme)', () => {
    push(incoming(msg('m6', 'amy', 'me', 'Salut')));
    $<HTMLButtonElement>('.lp-bubble-main')!.click();
    expect(deps.openConversation).toHaveBeenCalledWith('amy');
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('R ouvre la réponse rapide et y met le focus ; Entrée envoie le texte réduit et referme la bulle', async () => {
    push(incoming(msg('m7', 'amy', 'me', 'Tu es là ?')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    expect($<HTMLFormElement>('.lp-bubble-form')!.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(bubble.isReplying()).toBe(true);

    input.value = '  Oui, à 21 h  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect($<HTMLButtonElement>('.lp-bubble-send')!.disabled).toBe(false);
    $<HTMLFormElement>('.lp-bubble-form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(deps.send).toHaveBeenCalledWith('amy', 'Oui, à 21 h');
    await flush();
    expect($('.lp-bubble')!.hidden).toBe(true);
    expect(bubble.isReplying()).toBe(false);
  });

  it('R ne déclenche rien sans bulle affichée, ni pendant la saisie d’un champ', () => {
    keyOnDocument('r');
    expect($<HTMLFormElement>('.lp-bubble-form')!.hidden).toBe(true);
    push(incoming(msg('m8', 'amy', 'me', 'Salut')));
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    expect(bubble.isReplying()).toBe(false);
    other.remove();
  });

  it('brouillon laissé puis focus hors de la carte (Tab) : R ramène le focus dans le champ', () => {
    push(incoming(msg('m9', 'amy', 'me', 'Salut')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    input.value = 'brouillon';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
    expect(document.activeElement).not.toBe(input);
    expect(bubble.isReplying()).toBe(true);
    keyOnDocument('r');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('brouillon');
  });

  it('Échap annule la réponse sans rien envoyer et referme la bulle', () => {
    push(incoming(msg('m9', 'amy', 'me', 'Salut')));
    keyOnDocument('R');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    input.value = 'brouillon';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(deps.send).not.toHaveBeenCalled();
    expect($('.lp-bubble')!.hidden).toBe(true);
    expect(bubble.isReplying()).toBe(false);
  });

  it('texte vide : le bouton Envoyer reste désactivé', () => {
    push(incoming(msg('m10', 'amy', 'me', 'Salut')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect($<HTMLButtonElement>('.lp-bubble-send')!.disabled).toBe(true);
  });

  it('échec d’envoi : message d’erreur, saisie conservée', async () => {
    deps.send.mockImplementationOnce(async () => { throw { status: 500 }; });
    push(incoming(msg('m11', 'amy', 'me', 'Salut')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    input.value = 'Encore';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLFormElement>('.lp-bubble-form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect($<HTMLParagraphElement>('.lp-bubble-err')!.hidden).toBe(false);
    expect($<HTMLParagraphElement>('.lp-bubble-err')!.textContent).toBe('Message non envoyé, réessaie plus tard');
    expect(input.value).toBe('Encore');
    expect(bubble.isReplying()).toBe(true);
  });

  it('limite d’envoi (429) : message dédié', async () => {
    deps.send.mockImplementationOnce(async () => { throw { status: 429 }; });
    push(incoming(msg('m12', 'amy', 'me', 'Salut')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    input.value = 'Encore';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLFormElement>('.lp-bubble-form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect($<HTMLParagraphElement>('.lp-bubble-err')!.textContent).toBe('Trop de messages : réessaie dans une minute');
  });

  it('pendant une réponse, un message suivant attend une place, puis s’affiche à la fin de la réponse', () => {
    push(incoming(msg('m13', 'amy', 'me', 'Premier')));
    keyOnDocument('r');
    push({
      conversations: [{ pid: 'amy', handle: AMY.handle, avatarColor: AMY.avatarColor, last: msg('m14', 'amy', 'me', 'Second', NOW + 1), unread: 2 }],
      messages: { amy: [msg('m13', 'amy', 'me', 'Premier'), msg('m14', 'amy', 'me', 'Second', NOW + 1)] },
    });
    expect($('.lp-bubble-txt')!.textContent).toBe('Premier');
    $<HTMLInputElement>('.lp-bubble-in')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.lp-bubble')!.hidden).toBe(false);
    expect($('.lp-bubble-txt')!.textContent).toBe('Second');
  });

  it('stop : se désabonne, ferme la bulle et n’écoute plus la touche R', () => {
    push(incoming(msg('m15', 'amy', 'me', 'Salut')));
    bubble.stop();
    expect(listener).toBeNull();
    expect($('.lp-bubble')!.hidden).toBe(true);
    keyOnDocument('r');
    expect(bubble.isReplying()).toBe(false);
  });
});

describe('bulle Social v3', () => {
  let bubble: ReturnType<typeof createMessageBubble>;
  let deps: ReturnType<typeof makeDeps>;
  const mount = (over: Partial<BubbleDeps> = {}) => {
    state = stateWith();
    listener = null;
    host = document.createElement('div');
    document.body.append(host);
    deps = makeDeps(over);
    bubble = createMessageBubble(host, deps);
    bubble.start();
  };
  afterEach(() => { bubble.stop(); host.remove(); vi.useRealTimers(); });

  it('survol : champ et emojis apparaissent, la bulle ne se ferme pas ; départ de la souris : elle repart', () => {
    mount();
    vi.useFakeTimers();
    push(incoming(msg('h1', 'amy', 'me', 'Salut')));
    expect($<HTMLFormElement>('.lp-bubble-form')!.hidden).toBe(true);
    $('.lp-bubble-card')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect($<HTMLFormElement>('.lp-bubble-form')!.hidden).toBe(false);
    vi.advanceTimersByTime(BUBBLE_MS * 3);
    expect($('.lp-bubble')!.hidden).toBe(false);
    $('.lp-bubble-card')!.dispatchEvent(new MouseEvent('mouseleave'));
    expect($<HTMLFormElement>('.lp-bubble-form')!.hidden).toBe(true);
    vi.advanceTimersByTime(BUBBLE_MS);
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('un emoji répond d’un clic', async () => {
    mount();
    push(incoming(msg('h2', 'amy', 'me', 'Salut')));
    $('.lp-bubble-card')!.dispatchEvent(new MouseEvent('mouseenter'));
    ($('.lp-bubble-emo') as HTMLButtonElement).click();
    expect(deps.send).toHaveBeenCalledWith('amy', '😂');
    await flush();
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('un second message s’empile dessous, puis prend la place à la fermeture du premier', () => {
    mount();
    vi.useFakeTimers();
    push(incoming(msg('s1', 'amy', 'me', 'Premier', NOW)));
    push({
      conversations: [{ pid: 'amy', handle: AMY.handle, avatarColor: AMY.avatarColor, last: msg('s2', 'amy', 'me', 'Deuxième', NOW + 1), unread: 2 }],
      messages: { amy: [msg('s1', 'amy', 'me', 'Premier', NOW), msg('s2', 'amy', 'me', 'Deuxième', NOW + 1)] },
    });
    expect($('.lp-bubble-txt')!.textContent).toBe('Premier');
    expect($('.lp-bubble-stack')!.hidden).toBe(false);
    expect($('.lp-bubble-stack .lp-bubble-who')!.textContent).toBe('Amy');
    expect($('.lp-bubble-stack-txt')!.textContent).toBe('Deuxième');
    vi.advanceTimersByTime(BUBBLE_MS);
    expect($('.lp-bubble-txt')!.textContent).toBe('Deuxième');
    expect($('.lp-bubble-stack')!.hidden).toBe(true);
  });

  it('bulles masquées (mode cinéma) : rien ne s’affiche', () => {
    let on = false;
    mount({ enabled: () => on });
    push(incoming(msg('c1', 'amy', 'me', 'Silence')));
    expect($('.lp-bubble')!.hidden).toBe(true);
    on = true;
    push(incoming(msg('c2', 'amy', 'me', 'Voix', NOW + 2)));
    expect($('.lp-bubble')!.hidden).toBe(false);
  });

  it('l’ombre de coin suit la bulle ; le dernier correspondant est connu', () => {
    mount();
    expect($('.lp-bubble-vig')!.hasAttribute('hidden')).toBe(true);
    push(incoming(msg('v1', 'amy', 'me', 'Salut')));
    expect($('.lp-bubble-vig')!.hasAttribute('hidden')).toBe(false);
    expect(bubble.lastPeer()).toEqual({ pid: 'amy', who: 'Amy' });
  });
  it('une réponse abandonnée sans texte : le focus parti, le délai repart et la bulle se ferme', () => {
    mount();
    vi.useFakeTimers();
    push(incoming(msg('f1', 'amy', 'me', 'Salut')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    expect(document.activeElement).toBe(input);
    vi.advanceTimersByTime(BUBBLE_MS * 2);
    expect($('.lp-bubble')!.hidden).toBe(false); // retenue tant que le champ a le focus
    input.blur();
    expect($<HTMLFormElement>('.lp-bubble-form')!.hidden).toBe(true);
    vi.advanceTimersByTime(BUBBLE_MS);
    expect($('.lp-bubble')!.hidden).toBe(true);
    expect($('.lp-bubble-vig')!.hasAttribute('hidden')).toBe(true);
  });

  it('un brouillon non envoyé retient la bulle, même une fois le focus parti', () => {
    mount();
    vi.useFakeTimers();
    push(incoming(msg('d1', 'amy', 'me', 'Salut')));
    keyOnDocument('r');
    const input = $<HTMLInputElement>('.lp-bubble-in')!;
    input.value = 'à tout de suite';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
    vi.advanceTimersByTime(BUBBLE_MS * 2);
    expect($('.lp-bubble')!.hidden).toBe(false);
  });

  it('mode cinéma activé pendant la bulle : la bulle et son ombre disparaissent tout de suite, même survolées', () => {
    let on = true;
    mount({ enabled: () => on });
    vi.useFakeTimers();
    push(incoming(msg('c3', 'amy', 'me', 'Salut')));
    $('.lp-bubble-card')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect($('.lp-bubble')!.hidden).toBe(false);
    on = false;
    push({});
    expect($('.lp-bubble')!.hidden).toBe(true);
    expect($('.lp-bubble-vig')!.hasAttribute('hidden')).toBe(true);
  });

  it('« Ne pas déranger » activé pendant la bulle : elle disparaît tout de suite', () => {
    mount();
    push(incoming(msg('n1', 'amy', 'me', 'Salut')));
    expect($('.lp-bubble')!.hidden).toBe(false);
    push({ status: 'dnd' });
    expect($('.lp-bubble')!.hidden).toBe(true);
  });

  it('survol interrompu par le mode cinéma : à la fin du mode, le délai reprend (pas de survol fantôme)', () => {
    let on = true;
    mount({ enabled: () => on });
    vi.useFakeTimers();
    push(incoming(msg('k2', 'amy', 'me', 'Salut')));
    $('.lp-bubble-card')!.dispatchEvent(new MouseEvent('mouseenter'));
    on = false;
    push({});
    on = true;
    push(incoming(msg('k3', 'amy', 'me', 'Encore', NOW + 2)));
    expect($('.lp-bubble')!.hidden).toBe(false);
    vi.advanceTimersByTime(BUBBLE_MS);
    expect($('.lp-bubble')!.hidden).toBe(true);
  });
});
