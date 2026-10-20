// Écran de connexion : « J’ai un lien d’invitation » ouvre « Rejoindre Laststream » ; l’adresse avec une invitation l’ouvre d’emblée.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearSession, setSession } from '../src/data/session';

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
      return json({ valid: true, inviter: { name: 'alice', handle: 'alice#K7QD', avatar: null }, message: null, picks: [], expiresAt: null, number: 4242 });
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
    // Pas de « Continuer sans compte » ni de note « sans compte » : la connexion est obligatoire.
    expect($('[data-auth-local]', overlay)).toBeNull();
    expect(overlay.textContent).not.toMatch(/sans compte/i);
    expect(checks).toHaveLength(0);
  });

  it('le bouton ouvre « Rejoindre Laststream » ; un lien collé est vérifié et ouvre le billet puis la création de compte', async () => {
    history.replaceState(null, '', '/');
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    ui.openLogin();
    const overlay = $('#auth')!;
    ($('[data-auth-mode="invite"]', overlay) as HTMLElement).click();
    expect($('h1', overlay)!.textContent).toBe('Rejoindre Laststream');
    expect($('#auth-form', overlay)).toBeNull();
    expect($('[data-auth-local]', overlay)).toBeNull();
    expect(overlay.textContent).not.toMatch(/sans compte/i);
    const input = $<HTMLInputElement>('input[name="code"]', overlay)!;
    input.value = 'https://laststream.example/?invite=Kq3abcd';
    input.dispatchEvent(new Event('paste', { bubbles: true }));
    await tick();
    expect(checks.some((c) => c.endsWith('/user/invites/check?code=Kq3abcd'))).toBe(true);
    // Billet valide : écran « Ta place est réservée », puis « Créer mon compte » ouvre le formulaire.
    expect(overlay.textContent).toContain('Ta place est réservée.');
    expect(overlay.textContent).toContain('alice#K7QD');
    ($('[data-rf-create]', overlay) as HTMLElement).click();
    expect($('#rf-form', overlay)).not.toBeNull();
  });

  it('?invite=abcd ouvre directement le billet « Ta place est réservée », puis la création de compte', async () => {
    history.replaceState(null, '', '/?invite=abcd');
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    void ui.runAuthFlow();
    await tick();
    const overlay = $('#auth')!;
    expect($('h1', overlay)!.textContent).toBe('Ta place est réservée.');
    expect(checks).toEqual(['http://localhost:7000/user/invites/check?code=abcd']);
    expect(overlay.textContent).toContain('alice#K7QD');
    ($('[data-rf-create]', overlay) as HTMLElement).click();
    expect($('#rf-form', overlay)).not.toBeNull();
    expect($('input[name="bootstrap"]', overlay)).toBeNull();
  });

  it('sans session et serveur injoignable : écran de connexion avec le message, jamais le mode local', async () => {
    clearSession();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { initAuth, offlineWithoutSession } = await import('../src/data/auth');
    expect(await initAuth()).toBe('offline');
    expect(offlineWithoutSession()).toBe(true);
    history.replaceState(null, '', '/');
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    void ui.runAuthFlow();
    await tick();
    const overlay = $('#auth')!;
    expect(overlay.hidden).toBe(false);
    expect($('h1', overlay)!.textContent).toBe('Connexion');
    expect($('#auth-msg', overlay)!.textContent).toBe('Serveur Laststream injoignable. Vérifie ta connexion puis réessaie.');
    expect($('#auth-form', overlay)).not.toBeNull();
    expect($('[data-auth-local]', overlay)).toBeNull();
  });

  it('session existante et serveur injoignable : pas d’écran de connexion, le repli local reste', async () => {
    setSession('tok', new Date(Date.now() + 1e9).toISOString(), 'greg');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    try {
      const { initAuth, offlineWithoutSession } = await import('../src/data/auth');
      expect(await initAuth()).toBe('offline');
      expect(offlineWithoutSession()).toBe(false);
      const ui = await import('../src/ui/auth-ui.js');
      const outcome = await Promise.race([ui.runAuthFlow().then(() => 'resolved'), tick(200).then(() => 'pending')]);
      expect(outcome).toBe('resolved');
    } finally {
      clearSession();
    }
  });
});
