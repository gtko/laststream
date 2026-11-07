// Social v3 (F4) : modèle de partage, QR code local, fenêtre « Partager » (bureau et panneau du bas), routes publiques.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const subs = new Set<(s: any) => void>();
  const st: any = {};
  return { st, subs };
});

vi.mock('../src/data/socialStore', () => ({
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => { h.subs.add(fn); return () => { h.subs.delete(fn); }; },
  refresh: vi.fn(() => Promise.resolve()),
  share: vi.fn(() => Promise.resolve([])),
  loadLists: vi.fn(() => Promise.resolve(h.st.lists)),
  addToList: vi.fn(() => Promise.resolve()),
  createList: vi.fn(() => Promise.resolve({ id: 'L9', name: 'Nouvelle', members: [], count: 0 })),
}));
vi.mock('../src/data/socialV3Api', () => ({ createShareLink: vi.fn(() => Promise.resolve({ url: 'https://x.test/t/ABCDEFGHIJKLMN', code: 'ABCDEFGHIJKLMN', inviteCode: 'inv1' })) }));
vi.mock('../src/data/socialApi', () => ({ getInvites: vi.fn(() => Promise.resolve({ quota: 5, invites: [{ state: 'free' }, { state: 'free' }, { state: 'free' }, { state: 'used' }] })) }));
vi.mock('../src/data/lt', () => ({ tmdb: vi.fn(() => Promise.resolve({ results: [{ id: 438631, media_type: 'movie', title: 'Dune', release_date: '2021-09-15', poster_path: '/p.jpg' }, { id: 7, media_type: 'person', name: 'X' }] })) }));
vi.mock('../src/ui/socialButton.js', () => ({ socialAvailable: () => true }));

import * as store from '../src/data/socialStore';
import * as api from '../src/data/socialV3Api';
import { qrMatrix, rsRemainder, formatBits } from '../src/ui/qrcode.js';
import * as M from '../src/ui/shareModel.js';
import { openShareDialog, closeShareDialog, configureShareDialog } from '../src/ui/shareDialog.js';
import { messageText } from '../src/ui/socialConvModel.js';
import { registerSocialHook } from '../src/ui/socialHooks.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const fr = (pid: string, name: string) => ({ pid, handle: { name, tag: 'AB23', full: name + '#AB23' }, avatarColor: '#7b5cff', household: false, status: 'online' });

describe('QR code local', () => {
  it('calcule les octets de correction d’erreurs de la norme (exemple 1-M)', () => {
    // Données de l'exemple « HELLO WORLD » 1-M (guide de la norme) : 16 octets de données, 10 de correction.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    // Polynôme générateur de degré 10 reconstruit par l'implémentation : on vérifie via une division complète.
    const div = (function gen() {
      const mul = (x: number, y: number) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
      const res = new Array(10).fill(0); res[9] = 1; let root = 1;
      for (let i = 0; i < 10; i++) { for (let j = 0; j < 10; j++) { res[j] = mul(res[j], root); if (j + 1 < 10) res[j] ^= res[j + 1]; } root = mul(root, 2); }
      return res;
    })();
    expect(rsRemainder(data, div)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('bits de format M / masque 0 conformes à la table de la norme', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits(1).toString(2).padStart(15, '0')).toBe('101000100100101');
  });

  it('produit une matrice carrée avec les trois repères et la taille attendue', () => {
    const m = qrMatrix('https://laststream.example/t/AbCdEfGhIjKlMnOpQrStUv');
    const n = m.length;
    expect((n - 17) % 4).toBe(0);
    expect(n).toBeGreaterThanOrEqual(25);
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      expect(m[cy][cx]).toBe(true); // centre sombre
      expect(m[cy][cx + 2]).toBe(false); // anneau clair
      expect(m[cy][cx + 3]).toBe(true); // anneau sombre
    }
    expect(m[n - 8][8]).toBe(true); // module sombre fixe
    expect(m.every((r) => r.length === n)).toBe(true);
  });

  it('refuse un texte trop long', () => {
    expect(() => qrMatrix('x'.repeat(300))).toThrow();
  });
});

describe('modèle de partage', () => {
  const media = M.normalizeMedia({ type: 'movie', tmdbId: 5, title: 'Dune', poster: '/p.jpg' })!;
  it('normalise le média (tv devient series) et refuse l’inutilisable', () => {
    expect(M.normalizeMedia({ type: 'tv', tmdbId: '12', title: ' Dark ' })).toEqual({ type: 'series', tmdbId: 12, title: 'Dark' });
    expect(M.normalizeMedia(null)).toBeNull();
    expect(M.normalizeMedia({ type: 'movie', tmdbId: 0, title: 'x' })).toBeNull();
  });
  it('moment possible pour un film ou un épisode précis seulement', () => {
    expect(M.canShareMoment(media, 100)).toBe(true);
    expect(M.canShareMoment(media, undefined)).toBe(false);
    expect(M.canShareMoment({ ...media, type: 'series' }, 100)).toBe(false);
    expect(M.canShareMoment({ ...media, type: 'series', season: 1, episode: 2 }, 100)).toBe(true);
  });
  it('règle la position par pas de 10 s sans passer sous zéro', () => {
    expect(M.shiftPos(4354, 10)).toBe(4364);
    expect(M.shiftPos(4, -10)).toBe(0);
  });
  it('construit le corps de /share pour un moment et pour le titre', () => {
    const base = { keys: ['p:a', 'g:7'], media, pos: 4354, body: ' CETTE scène ' };
    expect(M.buildShareInput({ ...base, mode: 'moment' })).toEqual({
      to: [{ pid: 'a' }, { group: '7' }], kind: 'moment', moment: { type: 'movie', tmdbId: 5, title: 'Dune', pos: 4354 }, body: 'CETTE scène',
    });
    expect(M.buildShareInput({ ...base, mode: 'title', body: '' })).toEqual({
      to: [{ pid: 'a' }, { group: '7' }], kind: 'title', title: { type: 'movie', tmdbId: 5, title: 'Dune', poster: '/p.jpg' },
    });
    expect(M.buildShareInput({ ...base, keys: [], mode: 'title' })).toBeNull();
  });
  it('libellé d’envoi selon le nombre de destinataires', () => {
    const t = [{ key: 'p:a', name: 'Léa' }, { key: 'p:b', name: 'Hugo' }, { key: 'p:c', name: 'Nora' }, { key: 'p:d', name: 'Sam' }];
    expect(M.sendLabel(t, [])).toBe('Envoyer');
    expect(M.sendLabel(t, ['p:a'])).toBe('Envoyer à Léa');
    expect(M.sendLabel(t, ['p:a', 'p:b'])).toBe('Envoyer à Léa et Hugo');
    expect(M.sendLabel(t, ['p:a', 'p:b', 'p:c', 'p:d'])).toBe('Envoyer à Léa, Hugo et 2 autres');
  });
  it('présélectionne to et conv parmi les destinataires connus', () => {
    const t = [{ key: 'p:a' }, { key: 'p:b' }, { key: 'g:9' }];
    expect(M.preselect(t, ['a', 'zz'], 'g:9')).toEqual(['p:a', 'g:9']);
    expect(M.preselect(t, undefined, 'dm:b')).toEqual(['p:b']);
    expect(M.preselect(t, undefined, 'dm:a').concat(M.preselect(t, ['a'], 'dm:a'))).toEqual(['p:a', 'p:a']);
  });
  it('lien : position seulement pour un moment, note limitée, clé de cache stable', () => {
    const a = M.buildLinkInput({ media, mode: 'moment', pos: 100, withInvite: true, note: 'x'.repeat(300) });
    expect(a.pos).toBe(100);
    expect(a.note!.length).toBe(M.NOTE_MAX);
    const b = M.buildLinkInput({ media, mode: 'title', pos: 100, withInvite: false });
    expect(b.pos).toBeUndefined();
    expect(M.linkKey(a)).not.toBe(M.linkKey(b));
    expect(M.linkKey(a)).toBe(M.linkKey({ ...a }));
  });
  it('reconnaît les routes /t/<code> (hash ou chemin) et #/list/<id>', () => {
    expect(M.shareCodeFrom('#/t/AbCdEfGhIjKlMn', '')).toBe('AbCdEfGhIjKlMn');
    expect(M.shareCodeFrom('', '/t/AbCdEfGhIjKlMn')).toBe('AbCdEfGhIjKlMn');
    expect(M.shareCodeFrom('#/t/court', '')).toBe('');
    expect(M.shareCodeFrom('#/tv/12', '/')).toBe('');
    expect(M.listIdFrom('#/list/abc-1')).toBe('abc-1');
    expect(M.listIdFrom('#/list/a b')).toBe('');
  });
  it('adresse d’inscription avec le code d’invitation', () => {
    expect(M.signupUrl('https://x.test/', 'a b')).toBe('https://x.test/?invite=a%20b');
    expect(M.ficheHash('series', 12)).toBe('#/tv/12');
  });
  it('compte les invitations libres', () => {
    expect(M.freeInvites({ invites: [{ state: 'free' }, { state: 'sent' }, { state: 'free' }] })).toBe(2);
    expect(M.freeInvites(null)).toBe(0);
  });
});

describe('fenêtre Partager', () => {
  const toast = vi.fn();
  const mq = (matches: boolean) => { (window as any).matchMedia = () => ({ matches, addEventListener() {}, removeEventListener() {} }); };
  const party = vi.fn();

  beforeEach(() => {
    closeShareDialog();
    document.body.innerHTML = '';
    vi.clearAllMocks();
    h.subs.clear();
    Object.assign(h.st, {
      me: { pid: 'me', handle: { name: 'Moi', tag: 'ZZ22', full: 'Moi#ZZ22' }, avatarColor: '#ff5a36' },
      friends: [fr('p1', 'Léa'), fr('p2', 'Hugo')], household: [fr('p3', 'Sam')],
      groups: [{ conv: 'g:9', unread: 0, group: { id: '9', name: 'Ciné du dim.', members: [fr('p1', 'Léa'), fr('p2', 'Hugo')] } }],
      lists: [{ id: 'L1', name: 'À voir avec Léa', members: [], count: 2 }],
    });
    configureShareDialog({ toast });
    registerSocialHook('inviteToParty', party);
    mq(false);
  });

  const media = { type: 'movie', tmdbId: 438631, title: 'Dune : Deuxième partie', poster: '/p.jpg' };
  const q = (sel: string) => document.querySelector(sel) as HTMLElement;
  const key = (k: string) => q(`[data-key="${k}"]`) as HTMLButtonElement;

  it('affiche amis, groupes, options moment/titre et le bouton d’envoi inactif sans destinataire', async () => {
    openShareDialog({ media, pos: 4354 });
    await flush();
    const dlg = q('[role="dialog"]');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.getAttribute('aria-label')).toBe('Partager Dune : Deuxième partie');
    expect(document.querySelectorAll('.shd-fr').length).toBe(4); // Léa, Hugo, Sam, groupe
    expect(q('.shd-sub').textContent).toBe('Tu en es à 1:12:34');
    expect(document.querySelectorAll('[role="radio"]').length).toBe(2);
    expect((q('.shd-btn.is-pri') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('.shd-foot .is-sec') as HTMLButtonElement).disabled).toBe(true);
  });

  it('multi-sélection, réglage ±10 s puis envoi d’un moment aux amis et au groupe', async () => {
    openShareDialog({ media, pos: 4354 });
    await flush();
    key('p:p1').click();
    key('g:9').click();
    expect(key('p:p1').getAttribute('aria-pressed')).toBe('true');
    const send = q('.shd-btn.is-pri') as HTMLButtonElement;
    expect(send.textContent).toBe('Envoyer à Léa et Ciné du dim.');
    (document.querySelectorAll('.shd-step-b')[1] as HTMLElement).click();
    expect(q('.shd-step-v').textContent).toBe('1:12:44');
    (q('#shd-mot') as HTMLTextAreaElement).value = 'CETTE scène 🤯';
    q('#shd-mot').dispatchEvent(new Event('input'));
    send.click();
    await flush();
    expect(store.share).toHaveBeenCalledWith({
      to: [{ pid: 'p1' }, { group: '9' }], kind: 'moment',
      moment: { type: 'movie', tmdbId: 438631, title: 'Dune : Deuxième partie', pos: 4364 }, body: 'CETTE scène 🤯',
    });
    expect(toast).toHaveBeenCalled();
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('« Le titre » envoie la fiche sans position', async () => {
    openShareDialog({ media, pos: 100 });
    await flush();
    (document.querySelectorAll('[role="radio"]')[1] as HTMLElement).click();
    key('p:p2').click();
    (q('.shd-btn.is-pri') as HTMLButtonElement).click();
    await flush();
    const arg = (store.share as any).mock.calls[0][0];
    expect(arg.kind).toBe('title');
    expect(arg.title.tmdbId).toBe(438631);
    expect(arg.moment).toBeUndefined();
  });

  it('présélectionne les amis de `to` et la conversation `conv`', async () => {
    openShareDialog({ media, to: ['p2'], conv: 'g:9' });
    await flush();
    expect(key('p:p2').getAttribute('aria-pressed')).toBe('true');
    expect(key('g:9').getAttribute('aria-pressed')).toBe('true');
    expect(key('p:p1').getAttribute('aria-pressed')).toBe('false');
  });

  it('sans média : sélecteur de titre, puis fenêtre principale pour le titre choisi', async () => {
    openShareDialog({ media: null, to: ['p1'] });
    await flush();
    expect(q('[role="dialog"]').getAttribute('aria-labelledby')).toBeTruthy();
    const inp = q('.shd-search input') as HTMLInputElement;
    inp.value = 'dune';
    inp.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 320));
    await flush();
    const res = document.querySelectorAll('.shd-res');
    expect(res.length).toBe(1); // la personne est écartée
    (res[0] as HTMLElement).click();
    expect(q('.shd-title').textContent).toBe('Partager Dune');
    expect(key('p:p1').getAttribute('aria-pressed')).toBe('true');
    expect(q('.shd-sub').textContent).toBe('Film');
  });

  it('crée le lien à la demande, le copie et affiche le QR code localement', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    openShareDialog({ media, pos: 4354 });
    await flush();
    expect(api.createShareLink).not.toHaveBeenCalled();
    expect(q('.shd-inv').textContent).toContain('Il en reste 3.');
    (Array.from(document.querySelectorAll('.shd-btn')).find((b) => b.textContent === 'Copier') as HTMLElement).click();
    await flush();
    expect(api.createShareLink).toHaveBeenCalledWith({ type: 'movie', tmdbId: 438631, pos: 4354, withInvite: true });
    expect(write).toHaveBeenCalledWith('https://x.test/t/ABCDEFGHIJKLMN');
    expect((q('#shd-link') as HTMLInputElement).value).toBe('https://x.test/t/ABCDEFGHIJKLMN');
    (Array.from(document.querySelectorAll('.shd-sh')).find((b) => b.textContent === 'QR code') as HTMLElement).click();
    await flush();
    expect(api.createShareLink).toHaveBeenCalledTimes(1); // même choix : même lien
    expect(q('.shd-qr svg')).not.toBeNull();
    expect(q('.shd-qr svg').getAttribute('role')).toBe('img');
  });

  it('l’interrupteur d’invitation est un switch clavier et retire withInvite', async () => {
    openShareDialog({ media });
    await flush();
    const sw = q('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    (Array.from(document.querySelectorAll('.shd-btn')).find((b) => b.textContent === 'Copier') as HTMLElement).click();
    await flush();
    expect(api.createShareLink).toHaveBeenCalledWith({ type: 'movie', tmdbId: 438631, withInvite: false });
  });

  it('quota épuisé (429) : option coupée, message, pas de lien', async () => {
    (api.createShareLink as any).mockRejectedValueOnce({ status: 429, code: 'invite_quota_reached' });
    openShareDialog({ media });
    await flush();
    (Array.from(document.querySelectorAll('.shd-btn')).find((b) => b.textContent === 'Copier') as HTMLElement).click();
    await flush();
    expect((q('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('.shd-status').textContent).toContain('plus d’invitation');
  });

  it('ajoute le titre à une liste partagée existante', async () => {
    openShareDialog({ media });
    await flush();
    const chip = Array.from(document.querySelectorAll('.shd-chip')).find((b) => b.textContent === 'À voir avec Léa') as HTMLElement;
    chip.click();
    await flush();
    expect(store.addToList).toHaveBeenCalledWith('L1', { type: 'movie', tmdbId: 438631, title: 'Dune : Deuxième partie', poster: '/p.jpg' });
    expect((Array.from(document.querySelectorAll('.shd-chip')).find((b) => b.textContent!.includes('À voir')) as HTMLButtonElement).disabled).toBe(true);
  });

  it('watch party : invite chaque ami choisi, membres des groupes compris', async () => {
    openShareDialog({ media });
    await flush();
    key('p:p3').click();
    key('g:9').click();
    (document.querySelector('.shd-foot .is-sec') as HTMLElement).click();
    expect(party.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('échap ferme et rend le focus ; textContent protège les noms', async () => {
    h.st.friends = [fr('p1', '<img src=x onerror=alert(1)>')];
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openShareDialog({ media });
    await flush();
    expect(document.querySelector('.shd-fr img')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(q('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('mobile : panneau du bas avec amis, mot, actions et bascule moment / titre', async () => {
    mq(true);
    openShareDialog({ media, pos: 4354 });
    await flush();
    expect(q('.shd.is-sheet')).not.toBeNull();
    expect(q('.shd-sub').textContent).toBe('Ce moment · 1:12:34');
    expect(Array.from(document.querySelectorAll('.shd-ac-n')).map((e) => e.textContent)).toEqual(['Lancer une watch party', 'Copier le lien', 'Autres applis', 'Liste partagée']);
    expect(q('.shd-ac-wrap .shd-ac-s').textContent).toBe('Avec une invitation · 3 restantes');
    const pill = q('.shd-pill');
    expect(pill.textContent).toBe('Le titre');
    pill.click();
    expect(q('.shd-sub').textContent).toBe('Film');
    key('p:p1').click();
    (q('#shd-mot') as HTMLInputElement).value = 'ok';
    q('#shd-mot').dispatchEvent(new Event('input'));
    (q('.shd-btn.is-pri') as HTMLElement).click();
    await flush();
    expect((store.share as any).mock.calls[0][0]).toMatchObject({ kind: 'title', body: 'ok', to: [{ pid: 'p1' }] });
  });

  describe('extrait', () => {
    const clipRadio = () => q('[data-opt="clip"]');
    const handle = (w: string) => q(`[data-h="${w}"]`);
    const keydown = (el: HTMLElement, k: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

    it('l’option « Un extrait » n’apparaît qu’avec une durée connue', async () => {
      openShareDialog({ media, pos: 100 });
      await flush();
      expect(document.querySelectorAll('[role="radio"]').length).toBe(2);
      expect(clipRadio()).toBeNull();
      closeShareDialog();
      openShareDialog({ media, pos: 100, duration: 7200 });
      await flush();
      expect(Array.from(document.querySelectorAll('[role="radio"]')).map((r) => r.getAttribute('data-opt'))).toEqual(['moment', 'clip', 'title']);
      expect(q('.shd-clip')).toBeNull(); // dépliée seulement une fois choisie
    });

    it('se déplie : début = position, fin = +30 s, poignées ARIA, en-tête et bouton d’envoi', async () => {
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      expect(q('.shd-clip')).not.toBeNull();
      expect(document.activeElement).toBe(clipRadio());
      expect(handle('start').getAttribute('role')).toBe('slider');
      expect(handle('start').getAttribute('aria-label')).toBe('Début de l’extrait');
      expect(handle('end').getAttribute('aria-label')).toBe('Fin de l’extrait');
      expect(handle('start').getAttribute('aria-valuenow')).toBe('2472');
      expect(handle('start').getAttribute('aria-valuetext')).toBe('41:12');
      expect(handle('end').getAttribute('aria-valuenow')).toBe('2502');
      expect(handle('end').getAttribute('aria-valuemax')).toBe('7200');
      expect(q('.shd-sub').textContent).toBe('Extrait · 0:30 · de 41:12 à 41:42');
      expect(q('.shd-clip-pill').textContent).toBe('Durée 0:30');
      expect(q('.shd-clip-scale').textContent).toContain('Durée du titre 2:00:00');
      key('p:p1').click();
      expect((q('.shd-btn.is-pri') as HTMLButtonElement).textContent).toBe('Envoyer l’extrait à Léa');
    });

    it('flèches (±1 s, Maj ±10 s), Home / End, et l’autre poignée suit au-delà de 5 min', async () => {
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      keydown(handle('end'), 'ArrowRight');
      expect(handle('end').getAttribute('aria-valuenow')).toBe('2503');
      keydown(handle('end'), 'ArrowRight', true);
      expect(handle('end').getAttribute('aria-valuenow')).toBe('2513');
      keydown(handle('start'), 'ArrowLeft');
      expect(handle('start').getAttribute('aria-valuenow')).toBe('2471');
      keydown(handle('start'), 'End'); // dernier début possible : fin − 1 s
      expect(handle('start').getAttribute('aria-valuenow')).toBe('2512');
      keydown(handle('end'), 'End'); // fin = durée, le début suit pour tenir en 5 min
      expect(handle('end').getAttribute('aria-valuenow')).toBe('7200');
      expect(handle('start').getAttribute('aria-valuenow')).toBe('6900');
      expect(q('.shd-sub').textContent).toBe('Extrait · 5:00 · de 1:55:00 à 2:00:00');
      keydown(handle('start'), 'Home');
      expect(handle('start').getAttribute('aria-valuenow')).toBe('0');
      expect(handle('end').getAttribute('aria-valuenow')).toBe('300');
    });

    it('glisser une poignée au pointeur et saisir un temps', async () => {
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      const bar = q('.shd-clip-bar');
      bar.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 64, right: 1000, bottom: 64, x: 0, y: 0, toJSON() {} }) as DOMRect;
      handle('end').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      handle('end').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500 }));
      expect(handle('end').getAttribute('aria-valuenow')).toBe('3600');
      expect(handle('start').getAttribute('aria-valuenow')).toBe('3300'); // la fenêtre glisse
      handle('end').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      handle('end').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 900 }));
      expect(handle('end').getAttribute('aria-valuenow')).toBe('3600'); // plus de glissement
      const inp = q('#shd-clip-start') as HTMLInputElement;
      inp.value = '55:30';
      inp.dispatchEvent(new Event('change'));
      expect(handle('start').getAttribute('aria-valuenow')).toBe('3330');
      inp.value = 'abc';
      inp.dispatchEvent(new Event('change'));
      expect(inp.value).toBe('55:30');
      expect(q('.shd-status').textContent).toContain('illisible');
      (q('.shd-clip-fb[aria-label^="Fin"]') as HTMLElement).click(); // − 1 s sur la fin
      expect(handle('end').getAttribute('aria-valuenow')).toBe('3599');
    });

    it('« Prendre la position actuelle » remet le début à la position d’ouverture', async () => {
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      keydown(handle('start'), 'ArrowLeft', true);
      keydown(handle('end'), 'ArrowRight', true);
      expect(handle('start').getAttribute('aria-valuenow')).toBe('2462');
      (Array.from(document.querySelectorAll('.shd-clip-acts .shd-btn')).find((b) => b.textContent === 'Prendre la position actuelle') as HTMLElement).click();
      expect(handle('start').getAttribute('aria-valuenow')).toBe('2472');
      expect(handle('end').getAttribute('aria-valuenow')).toBe('2522'); // même durée (50 s)
    });

    it('envoie le moment avec la fin, puis le lien avec pos et end', async () => {
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      keydown(handle('end'), 'ArrowRight', true);
      key('p:p1').click();
      (q('.shd-btn.is-pri') as HTMLButtonElement).click();
      await flush();
      expect(store.share).toHaveBeenCalledWith({
        to: [{ pid: 'p1' }], kind: 'moment',
        moment: { type: 'movie', tmdbId: 438631, title: 'Dune : Deuxième partie', pos: 2472, end: 2512 },
      });
      expect(q('[role="dialog"]')).toBeNull();
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      (Array.from(document.querySelectorAll('.shd-btn')).find((b) => b.textContent === 'Copier') as HTMLElement).click();
      await flush();
      expect(api.createShareLink).toHaveBeenCalledWith({ type: 'movie', tmdbId: 438631, pos: 2472, end: 2502, withInvite: true });
    });

    it('revenir à « Ce moment » n’envoie plus de fin', async () => {
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      clipRadio().click();
      q('[data-opt="moment"]').click();
      expect(q('.shd-clip')).toBeNull();
      key('p:p1').click();
      (q('.shd-btn.is-pri') as HTMLButtonElement).click();
      await flush();
      expect((store.share as any).mock.calls[0][0].moment).toEqual({ type: 'movie', tmdbId: 438631, title: 'Dune : Deuxième partie', pos: 2472 });
    });

    it('mobile : trois puces et éditeur d’extrait', async () => {
      mq(true);
      openShareDialog({ media, pos: 2472, duration: 7200 });
      await flush();
      expect(Array.from(document.querySelectorAll('.shd-modes [role="radio"]')).map((b) => b.textContent)).toEqual(['Ce moment', 'Un extrait', 'Le titre']);
      expect(q('.shd-pill')).toBeNull();
      clipRadio().click();
      expect(q('.shd-sub').textContent).toBe('Extrait · 0:30 · de 41:12 à 41:42');
      expect(q('.shd-clip')).not.toBeNull();
      key('p:p1').click();
      (q('.shd-btn.is-pri') as HTMLElement).click();
      await flush();
      expect((store.share as any).mock.calls[0][0].moment).toMatchObject({ pos: 2472, end: 2502 });
    });

    it('début proche de la fin du titre : la plage reste dans la durée', async () => {
      openShareDialog({ media, pos: 7195, duration: 7200 });
      await flush();
      clipRadio().click();
      expect(handle('start').getAttribute('aria-valuenow')).toBe('7195');
      expect(handle('end').getAttribute('aria-valuenow')).toBe('7200');
    });
  });
});

describe('extrait partagé (modèle)', () => {
  const media = M.normalizeMedia({ type: 'movie', tmdbId: 5, title: 'Dune', poster: '/p.jpg' })!;
  const ep = M.normalizeMedia({ type: 'tv', tmdbId: 9, title: 'Dark', season: 1, episode: 2 })!;

  it('bornes : 1 s minimum, 5 min maximum', () => {
    expect([M.CLIP_MIN_SEC, M.CLIP_MAX_SEC]).toEqual([1, 300]);
    expect(M.clampClip(100, 130, 7200)).toEqual({ start: 100, end: 130 });
    expect(M.clampClip(100, 100, 7200, 'start')).toEqual({ start: 100, end: 101 });
    expect(M.clampClip(100, 100, 7200, 'end')).toEqual({ start: 99, end: 100 });
    expect(M.clampClip(0, 0, 7200, 'end')).toEqual({ start: 0, end: 1 });
    expect(M.clampClip(7200, 7200, 7200, 'start')).toEqual({ start: 7199, end: 7200 });
  });
  it('au-delà de 5 min l’autre poignée suit (la fenêtre glisse)', () => {
    expect(M.clampClip(100, 1000, 7200, 'end')).toEqual({ start: 700, end: 1000 });
    expect(M.clampClip(100, 1000, 7200, 'start')).toEqual({ start: 100, end: 400 });
    expect(M.clampClip(100, 1000, 7200)).toEqual({ start: 700, end: 1000 });
    expect(M.clampClip(500, 100, 7200)).toEqual({ start: 200, end: 500 }); // inversés : remis dans l’ordre, le début s’ajuste
  });
  it('début et fin bornés à [0, durée] et arrondis', () => {
    expect(M.clampClip(-50, 20, 600, 'start')).toEqual({ start: 0, end: 20 });
    expect(M.clampClip(590, 9999, 600, 'end')).toEqual({ start: 590, end: 600 });
    expect(M.clampClip(10.4, 20.6, 600)).toEqual({ start: 10, end: 21 });
    expect(M.clampClip(0, 5, 0)).toEqual({ start: 0, end: 0 }); // durée inconnue : rien de valable
  });
  it('lit un temps saisi', () => {
    expect(M.parseTimecode('41:12')).toBe(2472);
    expect(M.parseTimecode(' 1:02:03 ')).toBe(3723);
    expect(M.parseTimecode('0:05')).toBe(5);
    expect(M.parseTimecode('90')).toBe(90);
    for (const bad of ['', '  ', 'abc', '1:75', '1:2:3:4', '-5', '1:xx', null, undefined]) expect(M.parseTimecode(bad as any)).toBeNull();
  });
  it('libellés', () => {
    expect(M.clipLabel(2472, 2523)).toBe('41:12 → 42:03');
    expect(M.shareText(media, 2472, 'clip', 2523)).toBe('Dune de 41:12 à 42:03 sur Laststream');
    expect(M.shareText(media, 2472, 'clip')).toBe('Dune sur Laststream'); // sans fin valable : le titre
    expect(M.shareText(media, 2472, 'moment')).toBe('Dune à 41:12 sur Laststream');
    expect(M.sendLabel([{ key: 'p:a', name: 'Léa' } as any], ['p:a'], true)).toBe('Envoyer l’extrait à Léa');
    expect(M.sendLabel([], [], true)).toBe('Envoyer l’extrait');
  });
  it('un extrait se partage s’il a une plage de 1 s à 5 min dans la durée', () => {
    expect(M.canShareClip(media, 100, 130, 7200)).toBe(true);
    expect(M.canShareClip(media, 100, 101, 7200)).toBe(true);
    expect(M.canShareClip(media, 100, 400, 7200)).toBe(true);
    expect(M.canShareClip(media, 100, 401, 7200)).toBe(false);
    expect(M.canShareClip(media, 100, 100, 7200)).toBe(false);
    expect(M.canShareClip(media, 100, 7300, 7200)).toBe(false);
    expect(M.canShareClip(media, 100, 130, 0)).toBe(false);
    expect(M.canShareClip(media, 100, 130, undefined as any)).toBe(false);
    expect(M.canShareClip({ ...media, type: 'series' }, 100, 130, 7200)).toBe(false); // série sans épisode
    expect(M.canShareClip(ep, 100, 130, 2700)).toBe(true);
  });
  it('corps de /share avec et sans fin', () => {
    const base = { keys: ['p:a'], media, pos: 2472 };
    expect(M.buildShareInput({ ...base, mode: 'clip', end: 2523 })).toEqual({
      to: [{ pid: 'a' }], kind: 'moment', moment: { type: 'movie', tmdbId: 5, title: 'Dune', pos: 2472, end: 2523 },
    });
    expect(M.buildShareInput({ ...base, mode: 'moment', end: 2523 })).toEqual({
      to: [{ pid: 'a' }], kind: 'moment', moment: { type: 'movie', tmdbId: 5, title: 'Dune', pos: 2472 },
    });
    expect(M.buildShareInput({ ...base, mode: 'clip', end: 2472 })!.kind).toBe('title'); // plage vide : le titre
    expect(M.buildShareInput({ ...base, mode: 'clip', end: 3000 })!.kind).toBe('title'); // plus de 5 min
    expect(M.buildShareInput({ ...base, mode: 'clip' })!.kind).toBe('title');
  });
  it('corps de /share-links : end seulement avec pos, clés de cache distinctes', () => {
    const clip = M.buildLinkInput({ media, mode: 'clip', pos: 2472, end: 2523, withInvite: false });
    expect(clip).toEqual({ type: 'movie', tmdbId: 5, withInvite: false, pos: 2472, end: 2523 });
    const moment = M.buildLinkInput({ media, mode: 'moment', pos: 2472, end: 2523, withInvite: false });
    expect(moment.end).toBeUndefined();
    expect(moment.pos).toBe(2472);
    const title = M.buildLinkInput({ media, mode: 'title', pos: 2472, end: 2523, withInvite: false });
    expect(title.pos).toBeUndefined();
    expect(title.end).toBeUndefined();
    expect(M.buildLinkInput({ media, mode: 'clip', pos: 2472, end: 2999, withInvite: false }).end).toBeUndefined();
    const keys = new Set([M.linkKey(clip), M.linkKey(moment), M.linkKey(title), M.linkKey({ ...clip, end: 2524 })]);
    expect(keys.size).toBe(4);
    expect(M.linkKey(clip)).toBe(M.linkKey({ ...clip }));
  });
  it('« Mes liens », page publique et discussion affichent la plage', () => {
    expect(M.linkRow({ title: 'Dune', pos: 2472, end: 2523 }, 0).title).toBe('Dune · de 41:12 à 42:03');
    expect(M.linkRow({ title: 'Dune', pos: 2472 }, 0).title).toBe('Dune · à 41:12');
    expect(M.linkRow({ title: 'Dune' }, 0).title).toBe('Dune');
    expect(M.momentNote({ pos: 2472, end: 2523 })).toBe('Recommandé de 41:12 à 42:03');
    expect(M.momentNote({ pos: 0, end: 30 })).toBe('Recommandé de 0:00 à 0:30');
    expect(M.momentNote({ pos: 2472 })).toBe('Recommandé à partir de 41:12');
    expect(M.momentNote({ pos: 0 })).toBe('');
    expect(M.momentNote(null as any)).toBe('');
    expect(messageText({ kind: 'moment', moment: { title: 'Dune', pos: 2472, end: 2523 } } as any)).toBe('Dune de 41:12 à 42:03');
    expect(messageText({ kind: 'moment', moment: { title: 'Dune', pos: 2472 } } as any)).toBe('Dune à 41:12');
  });
});
