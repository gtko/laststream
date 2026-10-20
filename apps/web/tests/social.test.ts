// Fonctions sociales : inscription par invitation, tableau des invitations, présence (la barre des amis est testée dans socialSidebar.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { inviteLink, normalizeInviteCode, parseInviteCode, withoutInvite } from '../src/data/invite';
import { socialErrorText } from '../src/data/socialText';
import { UserApiError } from '../src/data/userApi';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call { method: string; url: string; path: string; body: any }
const calls: Call[] = [];
let routes: (c: Call) => Response | undefined = () => undefined;

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = { method: init?.method ?? 'GET', url: String(url), path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return routes(call) ?? json({ error: 'not_found' }, 404);
  }));
}

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  calls.length = 0;
  routes = () => undefined;
  stubFetch();
});

// ---------- Fonctions pures ----------
describe('liens de parrainage', () => {
  it('lit le code dans ?invite= ou #/join/<code>', () => {
    expect(parseInviteCode('?invite=Kq3abcd', '')).toBe('Kq3abcd');
    expect(parseInviteCode('', '#/join/Zp9_xyz-1')).toBe('Zp9_xyz-1');
    expect(parseInviteCode('?x=1&invite=Kq3abcd', '#/library')).toBe('Kq3abcd');
    expect(parseInviteCode('?invite=a b', '')).toBe('');
    expect(parseInviteCode('', '#/library')).toBe('');
  });
  it('accepte un code seul ou un lien collé', () => {
    expect(normalizeInviteCode('  Kq3abcd ')).toBe('Kq3abcd');
    expect(normalizeInviteCode('https://laststream.gtux-prog.workers.dev/?invite=Kq3abcd')).toBe('Kq3abcd');
    expect(normalizeInviteCode('https://x.fr/#/join/Zp9abcd')).toBe('Zp9abcd');
    expect(normalizeInviteCode('n’importe quoi !')).toBe('');
  });
  it('fabrique le lien à partager et nettoie l’adresse', () => {
    expect(inviteLink('https://exemple.fr/', 'Kq3abcd')).toBe('https://exemple.fr/?invite=Kq3abcd');
    expect(withoutInvite('?invite=Kq3abcd&x=1', '#/join/Kq3abcd')).toEqual({ search: '?x=1', hash: '' });
    expect(withoutInvite('?invite=Kq3abcd', '#/library')).toEqual({ search: '', hash: '#/library' });
  });
});

describe('messages d’erreur', () => {
  it('textes lisibles des erreurs de salon et de parrainage', () => {
    expect(socialErrorText(new UserApiError(404, 'room_not_found'))).toContain('n’existe plus');
    expect(socialErrorText(new UserApiError(429, 'rate_limited'))).toContain('Trop de tentatives');
  });
});

// ---------- Inscription par invitation ----------
describe('écran d’inscription', () => {
  async function openAuth(url: string, check?: (c: Call) => Response | undefined) {
    history.replaceState(null, '', url);
    routes = (c) => check?.(c) ?? (c.path.startsWith('/user/login') ? json({ error: 'invalid_credentials' }, 401) : undefined);
    const { auth } = await import('../src/data/auth');
    auth.status = 'needs-login';
    const ui = await import('../src/ui/auth-ui.js');
    ui.readInviteFromLocation();
    void ui.runAuthFlow();
    await tick(60);
    return ui;
  }
  const overlay = () => $('#auth')!;

  it('?invite= : « invité par alice », formulaire d’inscription, code envoyé au serveur', async () => {
    await openAuth('/?invite=Kq3abcd', (c) => (c.path.startsWith('/user/invites/check') ? json({ valid: true, inviter: 'alice' }) : c.path === '/user/register' ? json({ account: { id: 'a', username: 'bob' } }, 201) : undefined));
    expect(calls.find((c) => c.path.startsWith('/user/invites/check'))!.path).toBe('/user/invites/check?code=Kq3abcd');
    expect(overlay().textContent).toContain('Invité par alice');
    expect($('#auth-form', overlay())).not.toBeNull();
    expect($('input[name="bootstrap"]', overlay())).toBeNull();
    const form = $<HTMLFormElement>('#auth-form', overlay())!;
    form.elements.namedItem('username') && ((form.elements.namedItem('username') as HTMLInputElement).value = 'bob');
    (form.elements.namedItem('password') as HTMLInputElement).value = 'motdepasse1';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(80);
    const reg = calls.find((c) => c.path === '/user/register')!;
    expect(reg.body).toEqual({ username: 'bob', password: 'motdepasse1', invite: 'Kq3abcd' });
  });

  it('#/join/<code> est lu aussi', async () => {
    await openAuth('/#/join/Zp9abcd', (c) => (c.path.startsWith('/user/invites/check') ? json({ valid: true, inviter: 'carl' }) : undefined));
    expect(calls[0].path).toBe('/user/invites/check?code=Zp9abcd');
    expect(overlay().textContent).toContain('Invité par carl');
  });

  it('lien invalide ou déjà utilisé : message clair, pas de formulaire', async () => {
    await openAuth('/?invite=Dead1234', (c) => (c.path.startsWith('/user/invites/check') ? json({ valid: false, inviter: null }) : undefined));
    expect(overlay().textContent).toContain('invalide, déjà utilisé ou révoqué');
    expect($('#auth-form', overlay())).toBeNull();
  });

  it('sans invitation : « Rejoindre Laststream » et aucun formulaire ; le code se saisit à la main', async () => {
    await openAuth('/', (c) => (c.path.startsWith('/user/invites/check') ? json({ valid: c.path.endsWith('Good1234'), inviter: 'dana' }) : undefined));
    ($('[data-auth-mode="invite"]', overlay()) as HTMLElement).click();
    await tick();
    expect(overlay().textContent).toContain('Rejoindre Laststream');
    expect($('#auth-form', overlay())).toBeNull();
    const f = $<HTMLFormElement>('[data-invite-form]', overlay())!;
    (f.elements.namedItem('code') as HTMLInputElement).value = 'https://x.fr/?invite=Good1234';
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(80);
    expect(overlay().textContent).toContain('Invité par dana');
    expect($('#auth-form', overlay())).not.toBeNull();
  });

  it('premier compte d’un serveur vide : accès au formulaire avec le jeton d’amorçage', async () => {
    await openAuth('/');
    ($('[data-auth-mode="invite"]', overlay()) as HTMLElement).click();
    await tick();
    ($('[data-invite-first]', overlay()) as HTMLElement).click();
    await tick();
    expect($('#auth-form', overlay())).not.toBeNull();
    expect($('input[name="bootstrap"]', overlay())).not.toBeNull();
    const form = $<HTMLFormElement>('#auth-form', overlay())!;
    (form.elements.namedItem('username') as HTMLInputElement).value = 'premier';
    (form.elements.namedItem('password') as HTMLInputElement).value = 'motdepasse1';
    routes = (c) => (c.path === '/user/register' ? json({ error: 'signup_disabled' }, 403) : undefined);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(80);
    expect(calls.find((c) => c.path === '/user/register')!.body).toEqual({ username: 'premier', password: 'motdepasse1' }); // pas d'invite
    expect($('#auth-msg', overlay())!.textContent).toContain('Inscription sur invitation');
  });

  it('lien refusé à l’inscription (invite_invalid) : retour au message de lien invalide', async () => {
    await openAuth('/?invite=Used1234', (c) => (c.path.startsWith('/user/invites/check') ? json({ valid: true, inviter: 'eve' }) : c.path === '/user/register' ? json({ error: 'invite_invalid' }, 403) : undefined));
    const form = $<HTMLFormElement>('#auth-form', overlay())!;
    (form.elements.namedItem('username') as HTMLInputElement).value = 'bob';
    (form.elements.namedItem('password') as HTMLInputElement).value = 'motdepasse1';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(80);
    expect(overlay().textContent).toContain('invalide, déjà utilisé ou révoqué');
    expect($('#auth-form', overlay())).toBeNull();
  });
});

// ---------- Tableau « Mes invitations » ----------
describe('Mes invitations', () => {
  const inv = (id: string, code: string, state: string, invitee: string | null = null) => ({ id, code, state, createdAt: '2026-01-01T00:00:00Z', sentAt: state === 'free' ? null : '2026-01-02T00:00:00Z', usedAt: state === 'used' ? '2026-01-03T00:00:00Z' : null, invitee });
  let mod: typeof import('../src/ui/invites.js');
  let authMod: typeof import('../src/data/auth');
  let list: ReturnType<typeof inv>[];

  beforeEach(async () => {
    history.replaceState(null, '', '/');
    list = [inv('i1', 'FreeCode1', 'free'), inv('i2', 'SentCode2', 'sent'), inv('i3', 'UsedCode3', 'used', 'bob'), inv('i4', 'FreeCode4', 'free')];
    routes = (c) => {
      if (c.method === 'GET' && c.path === '/user/invites') return json({ quota: 4, invites: list });
      if (c.method === 'PUT' && /\/user\/invites\/[^/]+\/sent$/.test(c.path)) return new Response(null, { status: 204 });
      if (c.method === 'DELETE' && c.path === '/user/invites/i1') { list[0] = inv('i1', 'NewCode99', 'free'); return json({ invite: list[0] }); }
      if (c.method === 'DELETE' && c.path === '/user/invites/i3') return json({ error: 'invite_used' }, 409);
      if (c.method === 'PUT' && c.path === '/user/accounts/greg/invite-quota') return json({ username: 'greg', quota: c.body.quota });
      return undefined;
    };
    authMod = await import('../src/data/auth');
    authMod.auth.username = 'greg';
    mod = await import('../src/ui/invites.js');
    document.getElementById('detail')!.innerHTML = mod.invitesCard();
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    vi.stubGlobal('confirm', () => true);
    window.confirm = () => true;
  });

  const rows = () => Array.from(document.querySelectorAll('#detail .inv-row')) as HTMLElement[];

  it('affiche les 4 liens avec leur état (libre, envoyé, utilisé par le filleul)', async () => {
    await mod.refreshInvites();
    expect(rows()).toHaveLength(4);
    expect(rows().map((r) => r.className.match(/is-(free|sent|used)/)![1])).toEqual(['free', 'sent', 'used', 'free']);
    expect(rows()[2].textContent).toContain('Utilisé');
    expect(rows()[2].textContent).toContain('par bob');
    expect(rows()[2].querySelector('[data-inv-revoke],[data-inv-copy],[data-inv-share]')).toBeNull();
    expect(rows()[0].textContent).toContain('Libre');
    expect(rows()[1].textContent).toContain('Envoyé');
    expect((rows()[0].querySelector('[data-inv-input]') as HTMLInputElement).value).toContain('/?invite=FreeCode1');
  });

  it('Copier met le lien dans le presse-papiers et marque « envoyé »', async () => {
    await mod.refreshInvites();
    (rows()[0].querySelector('[data-inv-copy]') as HTMLElement).click();
    await tick(60);
    expect((navigator.clipboard.writeText as any).mock.calls[0][0]).toMatch(/\/\?invite=FreeCode1$/);
    expect(calls.find((c) => c.path === '/user/invites/i1/sent')!.body).toEqual({ sent: true });
    expect(rows()[0].className).toContain('is-sent');
  });

  it('Partager utilise navigator.share quand il existe, sinon copie', async () => {
    await mod.refreshInvites();
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { share });
    await mod.shareInvite('i4');
    expect(share).toHaveBeenCalledTimes(1);
    expect((share.mock.calls[0] as any)[0].url).toMatch(/\/\?invite=FreeCode4$/);
    Object.assign(navigator, { share: undefined });
    await mod.shareInvite('i1');
    expect((navigator.clipboard.writeText as any).mock.calls.at(-1)[0]).toMatch(/FreeCode1$/);
  });

  it('Révoquer remplace le lien par un nouveau lien libre ; un lien utilisé ne se révoque pas', async () => {
    await mod.refreshInvites();
    expect(await mod.revokeOne('i1')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/user/invites/i1')).toBe(true);
    expect((rows()[0].querySelector('[data-inv-input]') as HTMLInputElement).value).toContain('NewCode99');
    expect(await mod.revokeOne('i3')).toBe(false);
    expect(calls.some((c) => c.path === '/user/invites/i3')).toBe(false); // refusé sans appel : déjà utilisé
  });

  it('le propriétaire règle le quota d’un compte', async () => {
    authMod.auth.isOwner = true;
    await mod.refreshInvites();
    expect(document.querySelector('#detail [data-inv-quota]')).not.toBeNull();
    expect(await mod.applyQuota('Greg', 6)).toBe(true);
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/user/accounts/greg/invite-quota')!.body).toEqual({ quota: 6 });
    authMod.auth.isOwner = false;
    document.getElementById('detail')!.innerHTML = mod.invitesCard();
    await mod.refreshInvites();
    expect(document.querySelector('#detail [data-inv-quota]')).toBeNull();
  });

  it('serveur injoignable : message et bouton Réessayer', async () => {
    routes = () => { throw new Error('réseau'); };
    await mod.refreshInvites();
    expect(document.getElementById('inv-slot')!.textContent).toContain('Invitations indisponibles');
  });
});
