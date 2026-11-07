// Social chargé à la demande (LAST-129) : les hooks appelés avant son arrivée sont rejoués dans l'ordre.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
type Hooks = typeof import('../src/ui/socialHooks.js');
let h: Hooks;
let release: () => void;
let fail: (e: Error) => void;

/** Chargeur mémoïsé comme bootSocial : enregistre les hooks puis déclare le Social prêt. */
function install(register: (h: Hooks) => void) {
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  let booted: Promise<void> | null = null;
  h.setSocialLoader(() => booted ?? (booted = gate.then(() => { register(h); h.markSocialReady(); })));
}

beforeEach(async () => {
  vi.resetModules();
  toast.mockClear();
  h = await import('../src/ui/socialHooks.js');
  h.setSocialNotifier(toast);
});

describe('socialHooks', () => {
  it('rejoue dans l’ordre les hooks appelés avant markSocialReady', async () => {
    const seen: string[] = [];
    install((m) => {
      m.registerSocialHook('openShareDialog', (o: unknown) => { seen.push('share:' + String(o)); });
      m.registerSocialHook('openConversation', (c: unknown) => { seen.push('conv:' + String(c)); });
      m.registerSocialHook('inviteToParty', (p: unknown) => { seen.push('invite:' + String(p)); });
    });
    h.openShareDialog('a');
    h.openConversation('b');
    h.inviteToParty('c');
    expect(seen).toEqual([]);
    release();
    await vi.waitFor(() => expect(seen).toEqual(['share:a', 'conv:b', 'invite:c']));
  });

  it('appel direct une fois le Social prêt', () => {
    const fn = vi.fn();
    h.registerSocialHook('openShareDialog', fn);
    h.openShareDialog('x');
    expect(fn).toHaveBeenCalledWith('x');
  });

  it('nettoyage demandé avant l’arrivée du Social : rien n’est rendu', async () => {
    const render = vi.fn(() => vi.fn());
    install((m) => { m.registerSocialHook('renderConversationList', render); });
    const cleanup = h.renderConversationList(document.createElement('div'));
    cleanup();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await h.ensureSocial();
    expect(render).not.toHaveBeenCalled();
  });

  it('nettoyage après l’arrivée : le nettoyage du rendu est appelé', async () => {
    const inner = vi.fn();
    install((m) => { m.registerSocialHook('renderConversationList', () => inner); });
    const cleanup = h.renderConversationList(document.createElement('div'));
    release();
    await h.ensureSocial();
    await new Promise((r) => setTimeout(r, 0));
    cleanup();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('échec du chargement : toast au lieu du silence', async () => {
    install(() => undefined);
    h.openShareDialog('a');
    fail(new Error('réseau'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  });
});
