import { beforeAll, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const calls: Array<{ url: string; body: string }> = [];
let goodPin = '1234';

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    const pin = JSON.parse(String(init?.body ?? '{}')).pin;
    if (pin === goodPin) return new Response(JSON.stringify({ token: 'pt', expiresAt: new Date(Date.now() + 3e9).toISOString() }), { status: 200 });
    return new Response(JSON.stringify({ error: 'invalid_pin' }), { status: 403 });
  }));
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const press = (digits: string) => digits.split('').forEach((d) => (document.querySelector(`[data-pin-key="${d}"]`) as HTMLElement).click());

describe('clavier PIN', () => {
  it('refuse un mauvais code puis déverrouille avec le bon', async () => {
    const { pinPad } = await import('../src/ui/auth-ui.js');
    const ok = vi.fn(async () => undefined);
    pinPad({ title: 'Code de Greg', profile: { id: 'p1', name: 'Greg' }, onOk: ok });
    expect(document.querySelector('.pin-title')!.textContent).toBe('Code de Greg');
    press('0000');
    await tick();
    expect(document.querySelector('.pin-msg')!.textContent).toBe('Code incorrect.');
    expect(ok).not.toHaveBeenCalled();
    press('1234');
    await tick();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)!.url).toBe('http://localhost:7000/user/profiles/p1/unlock');
    const { validProfileToken } = await import('../src/data/session');
    void validProfileToken; // le jeton n'est gardé que dans une session ouverte
  });

  it('accepte aussi le clavier physique', async () => {
    const { pinPad } = await import('../src/ui/auth-ui.js');
    const ok = vi.fn(async () => undefined);
    pinPad({ title: 'Code', profile: { id: 'p2', name: 'Léo' }, onOk: ok });
    '1234'.split('').forEach((key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    await tick();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
