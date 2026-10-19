// Chat du salon côté invité (src/ui/guestchat.js) : texte échappé, badge des non-lus, limite de 500 caractères, envoi,
// réactions et emojis flottants, raccourcis du lecteur ignorés pendant la saisie. Le port (client du salon) est simulé.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuestChat, clockOf, FLOAT_MS, REACTION_BAR } from '../src/ui/guestchat.js';
import { createGuestControls } from '../src/ui/guestplayer.js';

type Any = any;

interface FakePort {
  chat: Array<{ id: string; from: string; text: string; at: number }>;
  sendChat: ReturnType<typeof vi.fn>;
  sendReact: ReturnType<typeof vi.fn>;
  on: (ev: string, fn: (p: Any) => void) => () => void;
  emit: (ev: string, p?: Any) => void;
}

/** Faux client du salon : `on` renvoie le désabonnement, `emit` joue un événement serveur. */
function fakePort(chat: FakePort['chat'] = []): FakePort {
  const handlers = new Map<string, Array<(p: Any) => void>>();
  return {
    chat: [...chat],
    sendChat: vi.fn(() => true),
    sendReact: vi.fn(() => true),
    on(ev, fn) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
      return () => handlers.set(ev, (handlers.get(ev) ?? []).filter((f) => f !== fn));
    },
    emit(ev, p) {
      for (const fn of [...(handlers.get(ev) ?? [])]) fn(p);
    },
  };
}

const line = (id: string, from = 'bob', text = 'salut', at = Date.UTC(2026, 9, 19, 10, 5)) => ({ id, from, text, at });

let stages: HTMLElement[] = [];
let controls: Any[] = [];
let chats: Any[] = [];

afterEach(() => {
  for (const c of chats) c.destroy();
  for (const c of controls) c.destroy();
  for (const s of stages) s.remove();
  stages = [];
  controls = [];
  chats = [];
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function setup(port: FakePort = fakePort(), handlers: Record<string, unknown> = {}, chatOpts: Record<string, unknown> = {}) {
  const stage = document.createElement('div');
  document.body.appendChild(stage);
  stages.push(stage);
  const c = createGuestControls(stage, handlers as Any);
  controls.push(c);
  const chat = createGuestChat(c, chatOpts as Any);
  chats.push(chat);
  chat.bind(port);
  const btn = stage.querySelector('[data-id="chat"]') as HTMLButtonElement;
  const drawer = stage.querySelector('.gc') as HTMLElement;
  const log = stage.querySelector('.gc-log') as HTMLElement;
  const form = stage.querySelector('.gc-form') as HTMLFormElement;
  const input = stage.querySelector('.gc-input') as HTMLInputElement;
  const status = stage.querySelector('.gc-status') as HTMLElement;
  const badge = () => btn.querySelector('.gp-badge') as HTMLElement | null;
  const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return { stage, c, chat, port, btn, drawer, log, form, input, status, badge, submit };
}

describe('texte du salon', () => {
  it('pseudo et texte restent du texte : aucune balise ni attribut du salon n’est interprété', () => {
    const { port, log } = setup();
    port.emit('chat', line('m1', '<img src=x onerror="window.__pwn=1">', '<script>window.__pwn=2</script><b>gras</b>'));
    expect(log.querySelector('img, script, b')).toBeNull();
    expect(log.querySelector('.gc-who')?.textContent).toBe('<img src=x onerror="window.__pwn=1">');
    expect(log.querySelector('.gc-text')?.textContent).toBe('<script>window.__pwn=2</script><b>gras</b>');
    expect((window as Any).__pwn).toBeUndefined();
  });

  it('l’heure s’affiche HH:MM en heure locale', () => {
    const at = Date.UTC(2026, 9, 19, 10, 5);
    const { port, log } = setup();
    port.emit('chat', line('m1', 'bob', 'ok', at));
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date(at);
    expect(log.querySelector('.gc-time')?.textContent).toBe(pad(d.getHours()) + ':' + pad(d.getMinutes()));
    expect(clockOf(at)).toMatch(/^\d{2}:\d{2}$/);
    expect(clockOf(Number.NaN)).toBe('');
  });

  it('une ligne déjà affichée (historique puis événement) n’est pas dupliquée', () => {
    const port = fakePort([line('m1'), line('m2', 'alice')]);
    const { log } = setup(port);
    port.emit('welcome', {});
    port.emit('chat', line('m1'));
    port.emit('chat', line('m2', 'alice'));
    expect(log.querySelectorAll('.gc-msg')).toHaveLength(2);
  });

  it('la suppression par la modération retire la ligne', () => {
    const { port, log } = setup(fakePort([line('m1'), line('m2')]));
    port.emit('welcome', {});
    port.emit('removed', { messageId: 'm1' });
    expect(Array.from(log.querySelectorAll('.gc-msg')).map((el) => (el as HTMLElement).dataset.id)).toEqual(['m2']);
  });

  it('200 lignes au plus à l’écran : les plus anciennes partent', () => {
    const { port, log } = setup();
    for (let i = 0; i < 205; i++) port.emit('chat', line('m' + i));
    const ids = Array.from(log.querySelectorAll('.gc-msg')).map((el) => (el as HTMLElement).dataset.id);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('m5');
    expect(ids[199]).toBe('m204');
  });
});

describe('badge des messages non lus', () => {
  it('compte les nouveaux messages tant que le tiroir est fermé, puis repasse à zéro à l’ouverture', () => {
    const { port, btn, drawer, badge } = setup();
    port.emit('chat', line('a'));
    port.emit('chat', line('b'));
    port.emit('chat', line('c'));
    expect(badge()?.textContent).toBe('3');
    expect(badge()?.hidden).toBe(false);

    btn.click();
    expect(drawer.hidden).toBe(false);
    expect(badge()?.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    port.emit('chat', line('d'));
    expect(badge()?.hidden).toBe(true);

    btn.click();
    expect(drawer.hidden).toBe(true);
    port.emit('chat', line('e'));
    expect(badge()?.textContent).toBe('1');
  });

  it('l’historique reçu à la connexion ne compte pas ; une reconnexion ne compte que les lignes manquées', () => {
    const port = fakePort([line('h1'), line('h2')]);
    const { badge } = setup(port);
    port.emit('welcome', {});
    port.emit('chat', line('h1'));
    port.emit('chat', line('h2'));
    expect(badge()?.hidden).toBe(true);

    port.emit('chat', line('n1'));
    expect(badge()?.textContent).toBe('1');

    port.chat = [line('h1'), line('h2'), line('n1'), line('n2')];
    port.emit('welcome', {});
    expect(badge()?.textContent).toBe('2');
  });
});

describe('envoi', () => {
  it('le champ porte la limite de 500 caractères ; un envoi trop long part tronqué à 500', () => {
    const { port, input, submit } = setup();
    expect(input.maxLength).toBe(500);
    input.value = 'a'.repeat(600);
    submit();
    expect(port.sendChat).toHaveBeenCalledTimes(1);
    expect(port.sendChat.mock.calls[0][0]).toHaveLength(500);
  });

  it('le texte est épuré des espaces ; un message vide n’est pas envoyé ; la saisie est vidée après envoi', () => {
    const { port, input, submit } = setup();
    input.value = '   ';
    submit();
    expect(port.sendChat).not.toHaveBeenCalled();

    input.value = '  salut  ';
    submit();
    expect(port.sendChat).toHaveBeenCalledWith('salut');
    expect(input.value).toBe('');
  });

  it('hors connexion : le message reste dans le champ et un statut le dit', () => {
    const port = fakePort();
    port.sendChat.mockReturnValue(false);
    const { input, status, submit } = setup(port);
    input.value = 'encore';
    submit();
    expect(input.value).toBe('encore');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('non envoyé');
  });
});

describe('réactions', () => {
  it('la barre propose six emojis de la liste du salon ; un clic appelle sendReact', () => {
    const { port, stage } = setup();
    const buttons = Array.from(stage.querySelectorAll('.gc-emoji')) as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(REACTION_BAR);
    expect(buttons).toHaveLength(6);
    buttons[0].click();
    expect(port.sendReact).toHaveBeenCalledWith(REACTION_BAR[0]);
  });

  it('une réaction reçue flotte dans le cadre puis disparaît ; un emoji hors liste est ignoré', () => {
    vi.useFakeTimers();
    const { port, stage } = setup();
    port.emit('react', { user: 'bob', emoji: '🔥', at: 1 });
    const floats = () => Array.from(stage.querySelectorAll('.gc-fl')) as HTMLElement[];
    expect(floats().map((f) => f.textContent)).toEqual(['🔥']);

    port.emit('react', { user: 'bob', emoji: '💩', at: 2 });
    expect(floats()).toHaveLength(1);

    vi.advanceTimersByTime(FLOAT_MS);
    expect(floats()).toHaveLength(0);
  });
});

describe('raccourcis et cycle de vie', () => {
  it('pendant la saisie, la barre espace et les touches du lecteur ne déclenchent rien', () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const onMute = vi.fn();
    const { c, input } = setup(fakePort(), { onPlay, onPause, onMute });
    c.setState({ ready: true, duration: 100, position: 10, playing: false });
    for (const key of [' ', 'k', 'm', 'f']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    expect(onPlay).not.toHaveBeenCalled();
    expect(onPause).not.toHaveBeenCalled();
    expect(onMute).not.toHaveBeenCalled();
  });

  it('le bouton ouvre le tiroir et prévient onOpen (le menu des sous-titres se referme)', () => {
    const onOpen = vi.fn();
    const { btn, drawer } = setup(fakePort(), {}, { onOpen });
    expect(drawer.hidden).toBe(true);
    btn.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('unbind vide le tiroir, désactive la saisie et remet le badge à zéro', () => {
    const { chat, port, log, input, badge, stage } = setup(fakePort([line('m1')]));
    port.emit('welcome', {});
    port.emit('chat', line('n1'));
    chat.unbind();
    expect(log.children).toHaveLength(0);
    expect(input.disabled).toBe(true);
    expect(badge()?.hidden).toBe(true);
    const reactions = Array.from(stage.querySelectorAll('.gc-emoji')) as HTMLButtonElement[];
    expect(reactions.every((b) => b.disabled)).toBe(true);
  });

  it('destroy retire le bouton, le tiroir et les emojis flottants', () => {
    const { chat, stage, port } = setup();
    port.emit('react', { user: 'bob', emoji: '👍', at: 1 });
    chat.destroy();
    expect(stage.querySelector('.gc')).toBeNull();
    expect(stage.querySelector('[data-id="chat"]')).toBeNull();
    expect(stage.querySelector('.gc-fx')).toBeNull();
  });
});

describe('Échap', () => {
  /** Écouteur de bulle sur document, comme le gestionnaire global de la page (events.js) qui quitte la page. */
  function globalKeydown() {
    const fn = vi.fn();
    document.addEventListener('keydown', fn);
    return { fn, off: () => document.removeEventListener('keydown', fn) };
  }
  const escape = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  it('ferme le tiroir, focus sur le bouton ou dans le tiroir, sans remonter au gestionnaire global', () => {
    const global = globalKeydown();
    try {
      const { btn, drawer, input } = setup();
      btn.click();
      expect(drawer.hidden).toBe(false);
      escape(btn);
      expect(drawer.hidden).toBe(true);
      btn.click();
      escape(input);
      expect(drawer.hidden).toBe(true);
      expect(global.fn).not.toHaveBeenCalled();
    } finally {
      global.off();
    }
  });

  it('tiroir fermé : Échap suit son cours et atteint le gestionnaire global', () => {
    const global = globalKeydown();
    try {
      const { btn } = setup();
      escape(btn);
      expect(global.fn).toHaveBeenCalledTimes(1);
    } finally {
      global.off();
    }
  });
});
