// Avatars réels partout dans le social : la lettre colorée n'est qu'un repli. Rendu de la barre latérale (collection, Héros,
// DiceBear), « moi » (serveur puis profil local), notes (puce du lecteur), amis à inviter, avatar de l'invité.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { setUserStore, userStore } from '../src/data/userStore';
import { withLocalAvatar } from '../src/data/socialStore';
import { avatarHTML } from '../src/ui/socialFmt.js';
import { hydrateAvatars } from '../src/ui/avatar-art.js';
import { avatarEl, noteFlashEl } from '../src/player/notesView';
import {
  GUEST_AVATARS, guestAvatarToSend, initialGuestAvatar, isGuestAvatar, loadGuestAvatar, saveGuestAvatar,
} from '../src/party/guestAvatar';

let guestAvatarGridHTML: (selected: string) => string;

const COL = 'col:pokemon:pikachu';
const mount = (html: string): HTMLElement => {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.append(box);
  return box;
};

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div><div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: '' }));
  reloadSettings();
  ({ guestAvatarGridHTML } = (await import('../src/ui/partyjoin.js')) as any);
});
afterEach(() => {
  document.body.querySelectorAll('body > div:not([id])').forEach((n) => n.remove());
  localStorage.removeItem('ls.party.guest.avatar');
});

describe('rendu social des avatars', () => {
  it('avatar de collection : data-avatar posé, image lastAddon ajoutée sur la couleur, lettre en repli', async () => {
    const box = mount(avatarHTML({ handle: { name: 'Greg' }, avatarColor: '#3b82f6', avatar: COL }, 'ss-av-l', 'online'));
    const av = box.querySelector<HTMLElement>('.ss-av')!;
    expect(av.dataset.avatar).toBe(COL);
    expect(av.querySelector('.ss-ini')!.textContent).toBe('G');
    await hydrateAvatars(box as unknown as Document);
    expect(av.querySelector('img')!.getAttribute('src')).toBe('https://srv.example/avatars/i/pokemon/pikachu.webp');
  });

  it('Héros : illustration posée tout de suite, sans réseau', () => {
    const box = mount(avatarHTML({ handle: { name: 'Greg' }, avatarColor: '#3b82f6', avatar: 'hero:heros:Aegis' }));
    const av = box.querySelector<HTMLElement>('.ss-av')!;
    expect(av.dataset.art).toBe('1');
    expect(av.style.backgroundImage).toContain('data:image/svg+xml');
  });

  it('sans avatar ou avatar invalide : lettre sur la couleur, aucun data-avatar', () => {
    for (const avatar of [undefined, '', 'https://evil.example/x.png', 'col:../x:y']) {
      const av = mount(avatarHTML({ handle: { name: 'Greg' }, avatarColor: '#3b82f6', avatar })).querySelector<HTMLElement>('.ss-av')!;
      expect(av.dataset.avatar).toBeUndefined();
      expect(av.querySelector('.ss-ini')!.textContent).toBe('G');
    }
  });

  it('puce de note du lecteur : l\'avatar de l\'auteur est posé', () => {
    const chip = avatarEl('Greg', '#3b82f6', 'lp-nf-d', COL);
    expect(chip.dataset.avatar).toBe(COL);
    expect(avatarEl('Greg', '#3b82f6', 'lp-nf-d').dataset.avatar).toBeUndefined();
    const flash = noteFlashEl({ id: 'n', author: { pid: 'p', handle: { name: 'Greg', tag: '0001', full: 'Greg#0001' }, avatarColor: '#3b82f6', avatar: COL }, pos: 3, kind: 'text', body: 'ok', createdAt: 1 } as any);
    expect(flash.querySelector<HTMLElement>('.lp-nf-d')!.dataset.avatar).toBe(COL);
  });
});

describe('« moi » : avatar du serveur, sinon celui du profil actif', () => {
  const me = { pid: 'p', handle: { name: 'Greg', tag: '0001', full: 'Greg#0001' }, status: 'online', avatarColor: '#3b82f6' } as any;
  const fakeStore = (avatar: unknown) => setUserStore({ currentProfile: () => ({ id: '1', name: 'Greg', avatar }) } as any);

  it('garde l\'avatar renvoyé par le serveur', () => {
    fakeStore('hero:heros:Blaze');
    expect(withLocalAvatar({ ...me, avatar: COL }).avatar).toBe(COL);
  });

  it('reprend l\'avatar du profil local quand le serveur n\'en renvoie pas', () => {
    fakeStore(COL);
    expect(withLocalAvatar(me).avatar).toBe(COL);
  });

  it('sans avatar local : inchangé', () => {
    fakeStore(null);
    expect(withLocalAvatar(me)).toBe(me);
    expect(typeof userStore.currentProfile).toBe('function');
  });
});

describe('avatar de l\'invité', () => {
  it('grille : 24 Héros distincts, tous acceptés par la liste blanche', () => {
    expect(GUEST_AVATARS).toHaveLength(24);
    expect(new Set(GUEST_AVATARS).size).toBe(24);
    for (const a of GUEST_AVATARS) expect(a).toMatch(/^hero:heros:[A-Za-z0-9_-]{1,40}$/);
  });

  it('valide ce qui part au serveur : la grille seulement', () => {
    expect(guestAvatarToSend(GUEST_AVATARS[3])).toBe(GUEST_AVATARS[3]);
    for (const bad of ['', 'https://evil.example/a.png', 'col:pokemon:pikachu', 'hero:vilains:Dax', undefined, 3]) {
      expect(isGuestAvatar(bad)).toBe(false);
      expect(guestAvatarToSend(bad)).toBeUndefined();
    }
  });

  it('mémorise le choix sur l\'appareil, ignore une valeur hors grille', () => {
    expect(initialGuestAvatar()).toBe(GUEST_AVATARS[0]);
    saveGuestAvatar(GUEST_AVATARS[7]);
    expect(loadGuestAvatar()).toBe(GUEST_AVATARS[7]);
    expect(initialGuestAvatar()).toBe(GUEST_AVATARS[7]);
    saveGuestAvatar('https://evil.example/a.png');
    expect(loadGuestAvatar()).toBe(GUEST_AVATARS[7]);
    localStorage.setItem('ls.party.guest.avatar', 'hero:vilains:Dax');
    expect(loadGuestAvatar()).toBeNull();
  });

  it('stockage bloqué : repli sur le premier avatar, sans exception', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadGuestAvatar(broken)).toBeNull();
    expect(() => saveGuestAvatar(GUEST_AVATARS[1], broken)).not.toThrow();
  });

  it('grille HTML : un seul bouton coché, illustrations locales posées', () => {
    const box = mount(guestAvatarGridHTML(GUEST_AVATARS[2]));
    const buttons = box.querySelectorAll<HTMLElement>('[data-pj-av]');
    expect(buttons).toHaveLength(24);
    expect(box.querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
    expect(box.querySelector<HTMLElement>('[aria-checked="true"]')!.dataset.pjAv).toBe(GUEST_AVATARS[2]);
    expect(box.querySelectorAll('.pj-avi[data-art="1"]')).toHaveLength(24);
  });
});
