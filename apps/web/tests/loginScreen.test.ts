// Écran de connexion : « J’ai un lien d’invitation » ouvre « Rejoindre Laststream » ; l’adresse avec une invitation l’ouvre d’emblée.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const checks: string[] = [];

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
});

beforeEach(async () => {
  checks.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/user/invites/check')) {
      checks.push(String(url));
      return json({ valid: true, inviter: 'alice' });
    }
    return json({ error: 'not_found' }, 404);
  }));
  const { auth } = await import('../src/data/auth');
  auth.status = 'needs-login';
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('écran de connexion', () => {
  it('propose « J’ai un lien d’invitation » à côté de la connexion, sans les anciennes pastilles', async () => {
    history.replaceState(null, '', '/');
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    ui.openLogin();
    const overlay = $('#auth')!;
    expect($('h1', overlay)!.textContent).toBe('Connexion');
    expect($('#auth-form', overlay)).not.toBeNull();
    expect($('.pills', overlay)).toBeNull();
    expect($('[data-auth-mode="invite"]', overlay)!.textContent).toBe('J’ai un lien d’invitation');
    expect($('[data-auth-local]', overlay)!.className).toContain('btn-ghost');
    expect(checks).toHaveLength(0);
  });

  it('le bouton ouvre « Rejoindre Laststream » ; un lien collé est vérifié et ouvre la création de compte', async () => {
    history.replaceState(null, '', '/');
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    ui.openLogin();
    const overlay = $('#auth')!;
    ($('[data-auth-mode="invite"]', overlay) as HTMLElement).click();
    expect($('h1', overlay)!.textContent).toBe('Rejoindre Laststream');
    expect($('#auth-form', overlay)).toBeNull();
    const input = $<HTMLInputElement>('input[name="code"]', overlay)!;
    input.value = 'https://laststream.example/?invite=Kq3abcd';
    input.dispatchEvent(new Event('paste', { bubbles: true }));
    await tick();
    expect(checks.some((c) => c.endsWith('/user/invites/check?code=Kq3abcd'))).toBe(true);
    expect(overlay.textContent).toContain('Invité par alice');
    expect($('#auth-form', overlay)).not.toBeNull();
  });

  it('?invite=abcd ouvre directement « Rejoindre Laststream », avec l’invitation reconnue', async () => {
    history.replaceState(null, '', '/?invite=abcd');
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    void ui.runAuthFlow();
    await tick();
    const overlay = $('#auth')!;
    expect($('h1', overlay)!.textContent).toBe('Rejoindre Laststream');
    expect(checks).toEqual(['http://localhost:7000/user/invites/check?code=abcd']);
    expect(overlay.textContent).toContain('Invité par alice');
    expect($('#auth-form', overlay)).not.toBeNull();
    expect($('input[name="bootstrap"]', overlay)).toBeNull();
  });
});
