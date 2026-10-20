// Billet de parrainage (invitations v3, partie B) : « Ta place est réservée », création du compte, bienvenue, et les billets
// qui ne valent plus (expiré, utilisé, annulé, inconnu).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearSession } from '../src/data/session';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
/** Attend une condition : l'inscription enchaîne plusieurs appels réseau. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition non atteinte');
    await tick();
  }
}
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call { method: string; path: string; body: any }
type Route = (c: Call) => Response | undefined;
const calls: Call[] = [];
let routes: Route = () => undefined;

/** Billet v3 valide : parrain (nom, identifiant, avatar), mot, trois coups de cœur (une seule affiche https). */
const TICKET = {
  valid: true,
  inviter: { name: 'Grégoire', handle: 'Grégoire#X8MV', avatar: null },
  message: 'Tu vas adorer la page d’accueil, crois-moi.',
  picks: [
    { id: 'orbite', type: 'series', name: 'Orbite', poster: 'https://img.example.com/orbite.jpg', background: null },
    { id: 'lunes', type: 'movie', name: 'Les Deux Lunes', poster: 'http://insecure.example.com/lunes.jpg', background: null },
    { id: 'aurore', type: 'movie', name: 'Aurore', poster: null, background: null },
  ],
  expiresAt: '2026-11-03T00:00:00Z',
  number: 41,
};

/** Serveur d'une inscription réussie. `handle` : identifiant attribué, renvoyé par /user/me si fourni. */
function signupRoutes(handle?: string): Route {
  return (c) => {
    if (c.path.startsWith('/user/invites/check')) return json(TICKET);
    if (c.path === '/user/register') return json({ account: { id: 'acc1', username: c.body.username } }, 201);
    if (c.path === '/user/login') return json({ token: 'tok', expiresAt: new Date(Date.now() + 1e9).toISOString() });
    if (c.path === '/user/me') return json({ account: { id: 'acc1', username: 'sam', ...(handle ? { handle } : {}) } });
    if (c.path === '/user/profiles') return json({ profiles: [] });
    return undefined;
  };
}

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
});

beforeEach(async () => {
  calls.length = 0;
  routes = () => undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return routes(call) ?? json({ error: 'not_found' }, 404);
  }));
  clearSession();
  const { auth } = await import('../src/data/auth');
  auth.status = 'needs-login';
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Ouvre l'adresse avec son invitation, comme au chargement de la page. Renvoie l'overlay de connexion. */
async function openInvite(path: string): Promise<HTMLElement> {
  history.replaceState(null, '', path);
  const ui = await import('../src/ui/auth-ui.js');
  ui.readInviteFromLocation();
  void ui.runAuthFlow();
  return $('#auth') as HTMLElement;
}

/** Ouvre le formulaire depuis l'arrivée. */
async function openForm(overlay: HTMLElement): Promise<void> {
  await until(() => !!$('[data-rf-create]', overlay));
  ($('[data-rf-create]', overlay) as HTMLElement).click();
  await until(() => !!$('#rf-form', overlay));
}

/** Saisit le nom de profil et le mot de passe (événements « input », comme une frappe). */
function fill(overlay: HTMLElement, name: string, pwd: string): void {
  const n = $<HTMLInputElement>('#rf-name', overlay)!;
  n.value = name;
  n.dispatchEvent(new Event('input', { bubbles: true }));
  const p = $<HTMLInputElement>('#rf-pwd', overlay)!;
  p.value = pwd;
  p.dispatchEvent(new Event('input', { bubbles: true }));
}

const submitForm = (overlay: HTMLElement): void => {
  ($('#rf-form', overlay) as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

describe('billet de parrainage : arrivée', () => {
  it('code valide : « Ta place est réservée », avec le parrain, son mot et ses affiches (https seulement)', async () => {
    routes = signupRoutes();
    const overlay = await openInvite('/?invite=Kq3abcd');
    await until(() => !!$('.rf-page--arrival', overlay));
    expect($('h1', overlay)!.textContent).toBe('Ta place est réservée.');
    expect(overlay.textContent).toContain('Grégoire#X8MV');
    expect(overlay.textContent).toContain('Tu vas adorer la page d’accueil, crois-moi.');
    expect(overlay.querySelectorAll('.rf-poster')).toHaveLength(3);
    // Une seule affiche a une adresse https ; l'adresse http et l'affiche absente tombent sur le dégradé de repli.
    expect(overlay.querySelectorAll('.rf-poster img[src^="https://"]')).toHaveLength(1);
    expect(overlay.querySelectorAll('img[src^="http://"]')).toHaveLength(0);
    expect(overlay.querySelectorAll('.rf-poster--plain')).toHaveLength(2);
    expect(calls.find((c) => c.path.startsWith('/user/invites/check'))!.path).toBe('/user/invites/check?code=Kq3abcd');
    expect($('#auth-form', overlay)).toBeNull();
  });

  it('« Créer mon compte » ouvre le formulaire ; l’aperçu du handle suit la saisie', async () => {
    routes = signupRoutes();
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    expect($('h1', overlay)!.textContent).toBe('Crée ton compte');
    expect($('[data-rf-handle]', overlay)!.textContent).toBe('Toi#····');
    const name = $<HTMLInputElement>('#rf-name', overlay)!;
    name.value = 'sam dupont';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('[data-rf-handle]', overlay)!.textContent).toBe('samdupont#····');
  });

  it('la jauge du mot de passe suit la saisie', async () => {
    routes = signupRoutes();
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    fill(overlay, 'sam', 'Cinema2026');
    expect($('[data-rf-strength]', overlay)!.textContent).toBe('Correct');
    expect($<HTMLFormElement>('#rf-form', overlay)!.dataset.level).toBe('2');
  });
});

describe('billet de parrainage : compte et bienvenue', () => {
  it('case « Devenir ami » cochée par défaut, envoyée à l’inscription ; succès → bienvenue avec le vrai handle', async () => {
    routes = signupRoutes('sam#K7QD');
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    const box = $<HTMLInputElement>('input[name="autoFriend"]', overlay)!;
    expect(box.checked).toBe(true);
    expect(overlay.textContent).toContain('Devenir ami avec Grégoire dès mon arrivée');
    fill(overlay, 'sam', 'motdepasse1');
    submitForm(overlay);
    await until(() => $('h1', overlay)?.textContent === 'Tu es dans la salle, sam');
    expect(calls.find((c) => c.path === '/user/register')!.body).toEqual({ username: 'sam', password: 'motdepasse1', invite: 'Kq3abcd', autoFriend: true });
    expect(overlay.textContent).toContain('sam#K7QD');
    expect(overlay.textContent).toContain('Grégoire#X8MV · ton ami');
    expect($('[data-rf-enter]', overlay)).not.toBeNull();
  });

  it('case décochée : autoFriend = false ; sans handle renvoyé, l’aperçu « Nom#···· » reste', async () => {
    routes = signupRoutes();
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    $<HTMLInputElement>('input[name="autoFriend"]', overlay)!.checked = false;
    fill(overlay, 'sam', 'motdepasse1');
    submitForm(overlay);
    await until(() => $('h1', overlay)?.textContent === 'Tu es dans la salle, sam');
    expect(calls.find((c) => c.path === '/user/register')!.body.autoFriend).toBe(false);
    expect(overlay.textContent).toContain('sam#····');
    expect(overlay.textContent).toContain('Grégoire#X8MV · ton parrain');
  });

  it('« Découvrir l’accueil » rend la main à l’app : le choix de profil', async () => {
    routes = signupRoutes();
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    fill(overlay, 'sam', 'motdepasse1');
    submitForm(overlay);
    await until(() => !!$('[data-rf-enter]', overlay));
    ($('[data-rf-enter]', overlay) as HTMLElement).click();
    await until(() => $('h1', overlay)?.textContent === 'Qui regarde ?');
  });

  it('mot de passe trop court : message local, aucun envoi', async () => {
    routes = signupRoutes();
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    fill(overlay, 'sam', 'court');
    submitForm(overlay);
    expect($('#rf-msg', overlay)!.textContent).toBe('Mot de passe : 8 caractères minimum.');
    expect(calls.some((c) => c.path === '/user/register')).toBe(false);
  });

  it('nom déjà pris : message et formulaire conservé', async () => {
    routes = (c) => (c.path === '/user/register' ? json({ error: 'username_taken' }, 409) : signupRoutes()(c));
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    fill(overlay, 'sam', 'motdepasse1');
    submitForm(overlay);
    await until(() => $('#rf-msg', overlay)!.hidden === false);
    expect($('#rf-msg', overlay)!.textContent).toBe('Ce nom d’utilisateur est déjà pris.');
    expect($('#rf-form', overlay)).not.toBeNull();
  });

  it('billet refusé à l’inscription (invite_invalid) : retour à la saisie du code, avec le message de lien invalide', async () => {
    routes = (c) => (c.path === '/user/register' ? json({ error: 'invite_invalid' }, 403) : signupRoutes()(c));
    const overlay = await openInvite('/?invite=Kq3abcd');
    await openForm(overlay);
    fill(overlay, 'sam', 'motdepasse1');
    submitForm(overlay);
    await until(() => overlay.textContent!.includes('invalide, déjà utilisé ou révoqué'));
    expect($('#rf-form', overlay)).toBeNull();
  });
});

describe('billet de parrainage : billets qui ne valent plus', () => {
  it.each([
    ['expired', 'a expiré'],
    ['used', 'déjà été utilisé'],
    ['revoked', 'a été annulé'],
    ['unknown', 'ne correspond à aucun billet'],
  ] as Array<[string, string]>)('billet « %s » : message adapté, pas de formulaire', async (reason, text) => {
    routes = (c) => (c.path.startsWith('/user/invites/check') ? json({ valid: false, reason }) : undefined);
    const overlay = await openInvite('/?invite=Dead1234');
    await until(() => overlay.textContent!.includes(text));
    expect($('h1', overlay)!.textContent).toBe('Rejoindre Laststream');
    expect($('[data-rf-create]', overlay)).toBeNull();
    expect($('#rf-form', overlay)).toBeNull();
  });
});
