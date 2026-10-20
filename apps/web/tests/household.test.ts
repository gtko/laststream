// Invitations sur un profil du foyer, côté hôte : panneau « Inviter sur ce profil » (durées, lien, copie, révocation),
// liste « Invitations du foyer » (états) et visibilité : pas pour le profil principal ni un profil enfant, rien en session verrouillée.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as householdApi from '../src/data/householdApi';
import type { Profile } from '../src/data/userStore';

vi.mock('../src/data/householdApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/householdApi')>()),
  createHouseholdInvite: vi.fn(),
  listHouseholdInvites: vi.fn(),
  revokeHouseholdInvite: vi.fn(),
}));

// Modules d'interface : importés une fois le DOM posé (dom.js lit #detail, #toast… à l'import).
let house: typeof import('../src/ui/household.js');
let picker: typeof import('../src/ui/auth-ui.js');
let invites: typeof import('../src/ui/invites.js');
let authMod: typeof import('../src/data/auth');
let foyer: typeof import('../src/data/foyerLink');

const MAIN: Profile = { id: 'main', name: 'Grégoire', isMainProfile: true, isKid: false, avatar: null, avatarColor: '#ff5a36', hasPin: false };
const ADULT: Profile = { id: 'adult-sam', name: 'Sam', isMainProfile: false, isKid: false, avatar: null, avatarColor: '#7b5bf5', hasPin: false };
const KID: Profile = { id: 'kid', name: 'Petits', isMainProfile: false, isKid: true, kidMaxAge: 12, allowedCatalogs: [], avatar: null, avatarColor: '#f5b700', hasPin: false };

const HOUR = 3600000;
const DAY = 24 * HOUR;
const TOKEN_A = 'aZ0_-'.repeat(4) + 'aZ0_';
const TOKEN_B = 'Qw1_-'.repeat(4) + 'Qw1_';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

function setAccount(opts: { locked?: boolean; active?: Profile } = {}): void {
  authMod.auth.status = 'ready';
  authMod.auth.profiles = [MAIN, ADULT, KID];
  authMod.auth.profile = opts.active ?? MAIN;
  authMod.auth.locked = !!opts.locked;
}

/** Ferme ce qui reste ouvert (le panneau et l'éditeur gardent un état de module ou restent dans le DOM). */
function closeAll(): void {
  $<HTMLElement>('[data-hh-done]')?.click();
  $<HTMLElement>('[data-pfe-cancel]')?.click();
  $('.hh-back')?.remove();
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal" hidden><div class="modal"></div></div>' +
    '<div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  house = await import('../src/ui/household.js');
  picker = await import('../src/ui/auth-ui.js');
  invites = await import('../src/ui/invites.js');
  authMod = await import('../src/data/auth');
  foyer = await import('../src/data/foyerLink');
});

beforeEach(() => {
  vi.mocked(householdApi.createHouseholdInvite).mockReset();
  vi.mocked(householdApi.listHouseholdInvites).mockReset().mockResolvedValue({ invites: [] });
  vi.mocked(householdApi.revokeHouseholdInvite).mockReset().mockResolvedValue(undefined);
  setAccount();
});

afterEach(() => {
  closeAll();
  authMod.grantManager(null);
  authMod.auth.locked = false;
});

describe('panneau « Inviter sur ce profil »', () => {
  it('crée un lien de 3 jours par défaut et affiche foyerLink(shareBase(), jeton)', async () => {
    vi.mocked(householdApi.createHouseholdInvite).mockResolvedValue({ id: 'h1', token: TOKEN_A, expiresAt: future(3 * DAY) });
    house.openHouseholdPanel(ADULT);
    await tick();
    expect(householdApi.createHouseholdInvite).toHaveBeenCalledTimes(1);
    expect(householdApi.createHouseholdInvite).toHaveBeenCalledWith('adult-sam', 72);
    expect($<HTMLInputElement>('[data-hh-link]')!.value).toBe(foyer.foyerLink(invites.shareBase(), TOKEN_A));
    expect($('[data-hh-ttl="72"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($('[data-hh-ttl="24"]')!.getAttribute('aria-pressed')).toBe('false');
    expect($('#hh-title')!.textContent).toBe('Sam');
  });

  it('change de durée en régénérant le lien (24 h, puis 168 h)', async () => {
    vi.mocked(householdApi.createHouseholdInvite)
      .mockResolvedValueOnce({ id: 'h1', token: TOKEN_A, expiresAt: future(3 * DAY) })
      .mockResolvedValueOnce({ id: 'h2', token: TOKEN_B, expiresAt: future(DAY) })
      .mockResolvedValueOnce({ id: 'h3', token: TOKEN_A, expiresAt: future(7 * DAY) });
    house.openHouseholdPanel(ADULT);
    await tick();
    $<HTMLElement>('[data-hh-ttl="24"]')!.click();
    await tick();
    expect(householdApi.createHouseholdInvite).toHaveBeenLastCalledWith('adult-sam', 24);
    expect($<HTMLInputElement>('[data-hh-link]')!.value).toBe(foyer.foyerLink(invites.shareBase(), TOKEN_B));
    expect($('[data-hh-ttl="24"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($('[data-hh-ttl="72"]')!.getAttribute('aria-pressed')).toBe('false');
    $<HTMLElement>('[data-hh-ttl="168"]')!.click();
    await tick();
    expect(householdApi.createHouseholdInvite).toHaveBeenLastCalledWith('adult-sam', 168);
    expect(householdApi.createHouseholdInvite).toHaveBeenCalledTimes(3);
  });

  it('copie le lien dans le presse-papiers et affiche « Copié ! »', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.mocked(householdApi.createHouseholdInvite).mockResolvedValue({ id: 'h1', token: TOKEN_A, expiresAt: future(3 * DAY) });
    house.openHouseholdPanel(ADULT);
    await tick();
    $<HTMLElement>('[data-hh-copy]')!.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith(foyer.foyerLink(invites.shareBase(), TOKEN_A));
    expect($('[data-hh-copy]')!.textContent).toBe('Copié !');
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
  });

  it('révoque le lien (revokeHouseholdInvite) et n’affiche plus de lien', async () => {
    vi.mocked(householdApi.createHouseholdInvite).mockResolvedValue({ id: 'h1', token: TOKEN_A, expiresAt: future(3 * DAY) });
    house.openHouseholdPanel(ADULT);
    await tick();
    $<HTMLElement>('[data-hh-revoke]')!.click();
    await tick();
    expect(householdApi.revokeHouseholdInvite).toHaveBeenCalledWith('h1');
    expect($<HTMLInputElement>('[data-hh-link]')!.value).toBe('');
    expect($('[data-hh-msg]')!.textContent).toContain('Lien révoqué');
    expect(($<HTMLButtonElement>('[data-hh-copy]')!).disabled).toBe(true);
  });

  it('une session verrouillée n’ouvre pas le panneau', () => {
    setAccount({ locked: true, active: ADULT });
    house.openHouseholdPanel(ADULT);
    expect($('.hh-back')).toBeNull();
    expect(householdApi.createHouseholdInvite).not.toHaveBeenCalled();
  });

  it('crée le lien au nom du profil qui gère après une sortie de profil enfant', async () => {
    vi.mocked(householdApi.createHouseholdInvite).mockResolvedValue({ id: 'h1', token: TOKEN_A, expiresAt: future(3 * DAY) });
    setAccount({ active: KID });
    authMod.grantManager('main');
    house.openHouseholdPanel(ADULT);
    await tick();
    expect(householdApi.createHouseholdInvite).toHaveBeenCalledWith('adult-sam', 72, 'main');
  });
});

describe('liste « Invitations du foyer »', () => {
  it('affiche les états des invitations', async () => {
    vi.mocked(householdApi.listHouseholdInvites).mockResolvedValue({
      invites: [
        { id: 'i1', profileId: 'adult-sam', profileName: 'Sam', createdAt: future(-HOUR), expiresAt: future(2 * DAY), state: 'pending' },
        { id: 'i2', profileId: 'x', profileName: 'Léa', createdAt: future(-DAY), expiresAt: future(-HOUR), state: 'used', usedAt: future(-HOUR) },
        { id: 'i3', profileId: 'y', profileName: 'Tom', createdAt: future(-DAY), expiresAt: future(-HOUR), state: 'expired' },
        { id: 'i4', profileId: 'z', profileName: 'Ana', createdAt: future(-DAY), expiresAt: future(DAY), state: 'revoked' },
      ],
    });
    const detail = document.getElementById('detail')!;
    detail.innerHTML = house.householdInvitesCard();
    await house.refreshHouseholdInvites();
    const slot = detail.querySelector('#hh-invites-slot')!;
    expect(slot.textContent).toContain('En attente');
    expect(slot.textContent).toContain('Utilisée');
    expect(slot.textContent).toContain('Expirée');
    expect(slot.textContent).toContain('Révoquée');
    expect(slot.querySelectorAll('[data-hh-list-revoke]')).toHaveLength(1);
    detail.innerHTML = '';
  });
});

describe('éditeur de profil : bouton et indicateur', () => {
  /** Ouvre l'éditeur d'un profil par le chemin réel : Gérer les profils, puis la tuile. */
  async function openEditor(p: Profile): Promise<void> {
    picker.openPicker();
    $<HTMLElement>('[data-pf-manage]')!.click();
    await tick();
    $<HTMLElement>(`[data-pf="${p.id}"]`)!.click();
    await tick();
    expect($('.pf-editor')).not.toBeNull(); // sans éditeur ouvert, l'absence du bouton ne prouverait rien
  }

  it('le bouton n’apparaît que pour un profil adulte non principal', async () => {
    await openEditor(ADULT);
    expect($('[data-hh-invite]')).not.toBeNull();
    expect($('[data-hh-invite]')!.textContent).toBe('Inviter quelqu’un sur ce profil');
    $<HTMLElement>('[data-pfe-cancel]')!.click();

    await openEditor(MAIN);
    expect($('[data-hh-invite]')).toBeNull();
    $<HTMLElement>('[data-pfe-cancel]')!.click();

    await openEditor(KID);
    expect($('[data-hh-invite]')).toBeNull();
    $<HTMLElement>('[data-pfe-cancel]')!.click();

    expect(house.profileInviteRowHTML(MAIN)).toBe('');
    expect(house.profileInviteRowHTML(KID)).toBe('');
  });

  it('indique l’invitation en attente avec le temps restant', async () => {
    vi.mocked(householdApi.listHouseholdInvites).mockResolvedValue({
      invites: [{ id: 'i1', profileId: 'adult-sam', profileName: 'Sam', createdAt: future(-HOUR), expiresAt: future(2 * DAY + 23 * HOUR + 30 * 60000), state: 'pending' }],
    });
    await openEditor(ADULT);
    await tick();
    expect($('[data-hh-state]')!.textContent).toBe('Invitation en attente · expire dans 2 j 23 h');
  });

  it('indique « Son propre accès » quand une invitation de ce profil a été utilisée', async () => {
    vi.mocked(householdApi.listHouseholdInvites).mockResolvedValue({
      invites: [{ id: 'i1', profileId: 'adult-sam', profileName: 'Sam', createdAt: future(-DAY), expiresAt: future(-HOUR), state: 'used', usedAt: future(-HOUR) }],
    });
    await openEditor(ADULT);
    await tick();
    expect($('[data-hh-state]')!.textContent).toBe('Son propre accès');
  });

  it('le bouton ouvre le panneau du profil', async () => {
    vi.mocked(householdApi.createHouseholdInvite).mockResolvedValue({ id: 'h1', token: TOKEN_A, expiresAt: future(3 * DAY) });
    await openEditor(ADULT);
    $<HTMLElement>('[data-hh-invite]')!.click();
    await tick();
    expect($('.hh-panel')).not.toBeNull();
    expect(householdApi.createHouseholdInvite).toHaveBeenCalledWith('adult-sam', 72);
  });
});

describe('session verrouillée', () => {
  it('pas de gestion ni d’ajout de profils, ni de bouton d’invitation', async () => {
    setAccount({ locked: true, active: ADULT });
    expect(authMod.isProfileLocked()).toBe(true);
    expect(authMod.canManageProfiles()).toBe(false);
    picker.openPicker();
    expect($('[data-pf-manage]')).toBeNull();
    expect($('[data-pf-add]')).toBeNull();
    expect(house.profileInviteRowHTML(ADULT)).toBe('');
  });

  it('pas de carte « Invitations du foyer » dans les réglages', () => {
    setAccount({ locked: true, active: ADULT });
    expect(house.householdInvitesCard()).toBe('');
  });
});
