// Éditeur du statut personnalisé (ODY-174) : pré-remplissage du statut actuel, enregistrement, effacement, échéances, erreurs,
// clavier. Le store est remplacé par un faux ; l'éditeur est monté dans un conteneur de test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: { profile: null as any },
  saveProfile: vi.fn(),
  loadProfile: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/data/socialStore', () => ({
  getState: () => h.state,
  saveProfile: h.saveProfile,
  loadProfile: h.loadProfile,
}));
vi.mock('../src/ui/dom.js', () => ({ toast: h.toast }));

import { UserApiError } from '../src/data/userApi';
import { openStatusEditor } from '../src/ui/socialStatusEditor.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const input = () => $<HTMLInputElement>('#ss-se-text')!;
const btn = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.ss-se button')).find((b) => b.textContent === label)!;
const type = (v: string) => { input().value = v; input().dispatchEvent(new Event('input', { bubbles: true })); };
const submit = () => $<HTMLFormElement>('.ss-se')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

let host: HTMLElement;
let opener: HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="host"><button id="opener">statut</button></div>';
  host = document.getElementById('host')!;
  opener = document.getElementById('opener') as HTMLButtonElement;
  h.state.profile = null;
  h.saveProfile.mockResolvedValue({});
  h.loadProfile.mockResolvedValue({ customStatus: { emoji: '🎬', text: 'Cinéma' } });
});

describe('ouverture', () => {
  it('pré-remplit le statut actuel, met le champ au premier plan et montre « Effacer le statut »', () => {
    h.state.profile = { customStatus: { emoji: '🍿', text: 'Soirée SF', expiresAt: Date.now() + 3_600_000 } };
    openStatusEditor(host, opener);
    expect(input().value).toBe('Soirée SF');
    expect($('.ss-se-emoji')!.textContent).toBe('🍿');
    expect(document.activeElement).toBe(input());
    expect(btn('Effacer le statut').hidden).toBe(false);
    expect(document.querySelector('.ss-se-chips .ss-hint')!.textContent).toMatch(/^Efface le /);
    expect(document.querySelectorAll('.ss-se-chip[aria-pressed="true"]')).toHaveLength(0);
  });

  it('sans statut : champ vide, « jamais » choisi, pas de bouton d’effacement', () => {
    h.state.profile = { customStatus: undefined };
    openStatusEditor(host, opener);
    expect(input().value).toBe('');
    expect(btn('jamais').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Effacer le statut').hidden).toBe(true);
  });

  it('ignore un statut déjà expiré', () => {
    h.state.profile = { customStatus: { text: 'Vieux', expiresAt: Date.now() - 1000 } };
    openStatusEditor(host, opener);
    expect(input().value).toBe('');
  });

  it('charge le profil s’il n’est pas encore dans le store, sans écraser ce qui est tapé', async () => {
    openStatusEditor(host, opener);
    await tick();
    expect(h.loadProfile).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('Cinéma');
    h.state.profile = null;
    openStatusEditor(host, opener);
    type('Mon texte');
    await tick();
    expect(input().value).toBe('Mon texte');
  });

  it('un seul éditeur à la fois', () => {
    openStatusEditor(host, opener);
    openStatusEditor(host, opener);
    expect(document.querySelectorAll('.ss-se')).toHaveLength(1);
  });
});

describe('enregistrement', () => {
  it('envoie emoji, texte et échéance, puis ferme et rend le focus', async () => {
    openStatusEditor(host, opener);
    $<HTMLButtonElement>('.ss-se-emoji')!.click();
    btn('🌙').click();
    type('  Dodo  ');
    btn('dans 4 h').click();
    const before = Date.now();
    submit();
    await tick();
    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    const cs = h.saveProfile.mock.calls[0][0].customStatus;
    expect(cs).toMatchObject({ emoji: '🌙', text: 'Dodo' });
    expect(cs.expiresAt).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
    expect(h.toast).toHaveBeenCalledWith('Statut enregistré');
    expect($('.ss-se')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('conserve l’échéance déjà posée tant qu’on n’en choisit pas une autre', async () => {
    const at = Date.now() + 7_200_000;
    h.state.profile = { customStatus: { text: 'Soirée', expiresAt: at } };
    openStatusEditor(host, opener);
    type('Soirée SF');
    submit();
    await tick();
    expect(h.saveProfile.mock.calls[0][0]).toEqual({ customStatus: { text: 'Soirée SF', expiresAt: at } });
  });

  it('texte et emoji vides sur un statut existant : l’efface (customStatus null)', async () => {
    h.state.profile = { customStatus: { text: 'Soirée' } };
    openStatusEditor(host, opener);
    type('');
    submit();
    await tick();
    expect(h.saveProfile).toHaveBeenCalledWith({ customStatus: null });
    expect(h.toast).toHaveBeenCalledWith('Statut effacé');
  });

  it('rien à enregistrer sans statut : ferme sans appeler le serveur', async () => {
    openStatusEditor(host, opener);
    submit();
    await tick();
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect($('.ss-se')).toBeNull();
  });

  it('limite le texte à 60 caractères et affiche le compteur', () => {
    openStatusEditor(host, opener);
    expect(input().maxLength).toBe(60);
    type('abc');
    expect($('#ss-se-count')!.textContent).toBe('3 / 60');
  });

  it('erreur serveur : message visible, l’éditeur reste ouvert et réutilisable', async () => {
    h.saveProfile.mockRejectedValueOnce(new UserApiError(0, 'network'));
    openStatusEditor(host, opener);
    type('Dodo');
    submit();
    await tick();
    expect($('.ss-se-err')!.hidden).toBe(false);
    expect($('.ss-se-err')!.textContent).toContain('Serveur injoignable');
    expect($('.ss-se')).not.toBeNull();
    expect(btn('Enregistrer').disabled).toBe(false);
    submit();
    await tick();
    expect(h.saveProfile).toHaveBeenCalledTimes(2);
    expect($('.ss-se')).toBeNull();
  });
});

describe('effacement', () => {
  it('« Effacer le statut » envoie null', async () => {
    h.state.profile = { customStatus: { emoji: '🍿', text: 'Soirée SF' } };
    openStatusEditor(host, opener);
    btn('Effacer le statut').click();
    await tick();
    expect(h.saveProfile).toHaveBeenCalledWith({ customStatus: null });
    expect($('.ss-se')).toBeNull();
  });
});

describe('effacement en échec', () => {
  it('le formulaire garde le statut affiché, et Enregistrer renvoie ce statut (pas null)', async () => {
    h.state.profile = { customStatus: { emoji: '🍿', text: 'Soirée SF' } };
    h.saveProfile.mockRejectedValueOnce(new UserApiError(0, 'network'));
    openStatusEditor(host, opener);
    btn('Effacer le statut').click();
    await tick();
    expect(input().value).toBe('Soirée SF');
    expect($('.ss-se-emoji')!.textContent).toBe('🍿');
    submit();
    await tick();
    expect(h.saveProfile).toHaveBeenLastCalledWith({ customStatus: { emoji: '🍿', text: 'Soirée SF' } });
  });
});

describe('clavier et fermeture', () => {
  it('Échap ferme l’éditeur et n’atteint pas la sidebar', () => {
    const outer = vi.fn();
    host.addEventListener('keydown', outer);
    openStatusEditor(host, opener);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('.ss-se')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('Échap ferme d’abord la grille d’emojis', () => {
    openStatusEditor(host, opener);
    $<HTMLButtonElement>('.ss-se-emoji')!.click();
    expect($('.ss-se-pop')!.hidden).toBe(false);
    expect(document.activeElement).toBe($('.ss-se-pop button'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('.ss-se-pop')!.hidden).toBe(true);
    expect($('.ss-se')).not.toBeNull();
    expect(document.activeElement).toBe($('.ss-se-emoji'));
  });

  it('le focus reste dans la fenêtre quand on change d’échéance ou d’emoji au clavier, et Échap ferme', () => {
    openStatusEditor(host, opener);
    const chip = btn('ce soir');
    chip.focus();
    chip.click();
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(btn('jamais').getAttribute('aria-pressed')).toBe('false');
    const emoji = $<HTMLButtonElement>('.ss-se-emoji')!;
    emoji.focus();
    emoji.click();
    expect(emoji.getAttribute('aria-expanded')).toBe('true');
    btn('🎬').click();
    expect($('.ss-se-emoji')).toBe(emoji);
    expect($('.ss-se')!.contains(document.activeElement)).toBe(true);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('.ss-se')).toBeNull();
  });

  it('Annuler et clic sur le fond ferment sans enregistrer', () => {
    openStatusEditor(host, opener);
    btn('Annuler').click();
    expect($('.ss-se')).toBeNull();
    openStatusEditor(host, opener);
    $<HTMLElement>('.ss-se-bk')!.click();
    expect($('.ss-se')).toBeNull();
    expect(h.saveProfile).not.toHaveBeenCalled();
  });

  it('Tab boucle dans la fenêtre', () => {
    openStatusEditor(host, opener);
    const last = btn('Enregistrer');
    last.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('.ss-se-emoji'));
  });
});
