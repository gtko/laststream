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
});
