// Invitation au foyer (#/foyer/<jeton>) : arrivée → formulaire → bienvenue, écrans d'erreur (expiré, déjà utilisé, révoqué,
// inconnu), erreur `login_taken` sous le champ identifiant. Les appels API et la session sont simulés.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptSession } from '../src/data/auth';
import { checkHouseholdInvite, redeemHouseholdInvite, type HouseholdCheckDto } from '../src/data/householdApi';
import { UserApiError } from '../src/data/userApi';
import { mountFoyerJoin } from '../src/ui/foyer-join.js';

vi.mock('../src/data/householdApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/householdApi')>()),
  checkHouseholdInvite: vi.fn(),
  redeemHouseholdInvite: vi.fn(),
}));
vi.mock('../src/data/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/auth')>()),
  adoptSession: vi.fn(async () => 'ready'),
}));

const TOKEN = 'tok-' + 'a'.repeat(32);
const OK_CHECK: HouseholdCheckDto = {
  state: 'ok',
  inviter: { name: 'Grégoire', avatar: null },
  profile: { name: 'Sam', avatar: null },
  expiresAt: new Date(Date.now() + (2 * 24 + 23) * 3600e3).toISOString(),
  backdrops: [],
};

let root: HTMLElement;

const h1 = (): string => root.querySelector('h1')?.textContent ?? '';
const field = (id: string): HTMLInputElement => root.querySelector('#' + id) as HTMLInputElement;
const text = (sel: string): string => root.querySelector(sel)?.textContent ?? '';
const click = (sel: string): void => (root.querySelector(sel) as HTMLButtonElement).click();
const type = (id: string, value: string): void => {
  field(id).value = value;
  field(id).dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = (): void => {
  (root.querySelector('[data-fj-form]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

/** Monte la page avec un lien `ok` et attend l'écran d'arrivée. */
async function arrival(check: HouseholdCheckDto = OK_CHECK): Promise<void> {
  vi.mocked(checkHouseholdInvite).mockResolvedValueOnce(check);
  mountFoyerJoin(root, TOKEN);
  await vi.waitFor(() => expect(h1()).not.toBe(''));
}

/** Ouvre le formulaire depuis l'arrivée et remplit les champs (identifiant, mot de passe, conditions). */
function fillForm(login = 'sam@exemple.fr', password = 'correct-horse-battery'): void {
  click('[data-fj-create]');
  type('fj-login', login);
  type('fj-pwd', password);
  field('fj-cgu').checked = true;
  field('fj-cgu').dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  vi.mocked(checkHouseholdInvite).mockReset();
  vi.mocked(redeemHouseholdInvite).mockReset();
  vi.mocked(adoptSession).mockClear();
});

describe('invitation au foyer : arrivée', () => {
  it('état ok : écran d’arrivée avec le nom de l’hôte et celui du profil', async () => {
    await arrival();
    expect(h1()).toBe('Grégoire te garde une place à la maison.');
    expect(text('.fj-lead')).toContain('« Sam »');
    expect(text('[data-fj-create]')).toContain('Créer mon accès');
  });

  it('« Créer mon accès » ouvre le formulaire, avec le nom du profil prérempli', async () => {
    await arrival();
    click('[data-fj-create]');
    expect(h1()).toBe('Crée ton accès');
    expect(field('fj-name').value).toBe('Sam');
    expect(field('fj-login').getAttribute('autocomplete')).toBe('username');
    expect(field('fj-pwd').type).toBe('password');
  });

  it('les textes venant du serveur sont échappés (nom de l’hôte)', async () => {
    await arrival({ ...OK_CHECK, inviter: { name: '<img src=x onerror=alert(1)>', avatar: null } });
    expect(root.querySelector('h1 img')).toBeNull();
    expect(h1()).toBe('<img src=x onerror=alert(1)> te garde une place à la maison.');
  });

  it('fanart : seules les adresses https sont affichées', async () => {
    await arrival({ ...OK_CHECK, backdrops: ['javascript:alert(1)', 'http://img.example/a.jpg', 'https://img.example/b.jpg'] });
    const srcs = Array.from(root.querySelectorAll<HTMLImageElement>('.fj-tile')).map((img) => img.getAttribute('src'));
    expect(srcs.length).toBeGreaterThan(0);
    expect(new Set(srcs)).toEqual(new Set(['https://img.example/b.jpg']));
  });

  it('sans fanart : fond de repli, aucune image', async () => {
    await arrival();
    expect(root.querySelector('.fj-wall--plain')).not.toBeNull();
    expect(root.querySelectorAll('.fj-tile').length).toBe(0);
  });
});

describe('invitation au foyer : soumission', () => {
  it('redeem, puis adoptSession, puis écran bienvenue', async () => {
    await arrival();
    vi.mocked(redeemHouseholdInvite).mockResolvedValueOnce({ token: 'sess-token', expiresAt: '2099-01-01T00:00:00.000Z', profileId: 'prof-sam' });
    fillForm();
    submit();
    await vi.waitFor(() => expect(h1()).toBe('Bienvenue chez toi, Sam'));
    expect(redeemHouseholdInvite).toHaveBeenCalledWith({ token: TOKEN, login: 'sam@exemple.fr', password: 'correct-horse-battery', name: 'Sam' });
    expect(adoptSession).toHaveBeenCalledWith({ token: 'sess-token', expiresAt: '2099-01-01T00:00:00.000Z', profileId: 'prof-sam' });
    const redeemOrder = vi.mocked(redeemHouseholdInvite).mock.invocationCallOrder[0];
    const adoptOrder = vi.mocked(adoptSession).mock.invocationCallOrder[0];
    expect(redeemOrder).toBeLessThan(adoptOrder);
    expect(text('[data-fj-start]')).toContain('Commencer à regarder');
  });

  it('login_taken : message sous le champ identifiant, aucune session ouverte', async () => {
    await arrival();
    vi.mocked(redeemHouseholdInvite).mockRejectedValueOnce(new UserApiError(409, 'login_taken'));
    fillForm();
    submit();
    await vi.waitFor(() => expect(text('#fj-login-err')).toBe('Cet identifiant est déjà pris. Choisis-en un autre.'));
    expect(field('fj-login').getAttribute('aria-invalid')).toBe('true');
    expect((root.querySelector('#fj-login-err') as HTMLElement).hidden).toBe(false);
    expect(adoptSession).not.toHaveBeenCalled();
    expect(h1()).toBe('Crée ton accès');
  });

  it('mot de passe de moins de 8 caractères : erreur sous le champ, sans appel réseau', async () => {
    await arrival();
    fillForm('sam@exemple.fr', 'court');
    submit();
    expect(text('#fj-pwd-err')).toContain('8 caractères minimum');
    expect(redeemHouseholdInvite).not.toHaveBeenCalled();
  });
});

describe('invitation au foyer : écrans d’erreur', () => {
  it.each([
    ['expired', 'Ce lien a expiré'],
    ['used', 'Ce lien a déjà servi'],
    ['revoked', 'Invitation annulée'],
    ['unknown', 'Lien introuvable'],
  ] as const)('état %s : écran d’erreur « %s »', async (state, title) => {
    vi.mocked(checkHouseholdInvite).mockResolvedValueOnce({ state, backdrops: [] });
    mountFoyerJoin(root, TOKEN);
    await vi.waitFor(() => expect(h1()).toBe(title));
    expect(root.querySelector('[data-fj-create]')).toBeNull();
  });

  it('serveur injoignable pendant la vérification : écran « Réessayer »', async () => {
    vi.mocked(checkHouseholdInvite).mockRejectedValueOnce(new UserApiError(0, 'network'));
    mountFoyerJoin(root, TOKEN);
    await vi.waitFor(() => expect(h1()).toBe('Lien impossible à vérifier'));
    expect(text('[data-fj-action]')).toBe('Réessayer');
  });
});
