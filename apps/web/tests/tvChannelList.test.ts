// Panneau « Chaînes » : puces, recherche, favoris par profil, fenêtre de rendu ; panneau des pistes ; clavier.
import { describe, expect, it, vi } from 'vitest';
import { centerScroll, chipList, favStorageKey, filterChannels, toggleId, windowRange } from '../src/data/tvChannelList';
import { tracksModel, trackRow } from '../src/ui/tvControls.js';

const ch = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, ...extra });
const list = [
  ch('a', 'TF1', { num: 1, categories: [{ id: 'general', label: 'Généraliste' }] }),
  ch('b', 'France 2', { num: 2, cat: 'Généraliste' }),
  ch('c', 'beIN SPORTS 1', { cat: 'Sport', categories: [{ id: 'sports', label: 'Sport' }] }),
  ch('d', 'franceinfo', { num: 27, categories: [{ id: 'news', label: 'Info' }] }),
  ch('e', 'Disney Channel', { categories: [{ id: 'kids', label: 'Jeunesse' }] }),
  ch('f', 'France 2 HD', { source: 'box', boxOnly: true, num: 2, cat: 'Box · TNT' }),
];
const none = new Set<string>();

describe('filtres et recherche', () => {
  it('puces : catégorie, favoris, box', () => {
    expect(filterChannels(list, { chip: 'sport', q: '', favs: none }).map((c) => c.id)).toEqual(['c']);
    expect(filterChannels(list, { chip: 'news', q: '', favs: none }).map((c) => c.id)).toEqual(['d']);
    expect(filterChannels(list, { chip: 'kids', q: '', favs: none }).map((c) => c.id)).toEqual(['e']);
    expect(filterChannels(list, { chip: 'box', q: '', favs: none }).map((c) => c.id)).toEqual(['f']);
    expect(filterChannels(list, { chip: 'fav', q: '', favs: new Set(['b', 'e']) }).map((c) => c.id)).toEqual(['b', 'e']);
  });
  it('recherche instantanée : sans accents, partielle, par numéro, noms qui commencent d’abord', () => {
    const ids = (q: string) => filterChannels(list, { chip: 'all', q, favs: none }).map((c) => c.id);
    expect(ids('franc')).toEqual(['b', 'd', 'f']);
    expect(ids('FRANCE 2')).toEqual(['b', 'f']);
    expect(ids('2')[0]).toBe('b');
    expect(ids('sports')).toEqual(['c']);
    expect(ids('zzz')).toEqual([]);
    expect(ids('')).toHaveLength(6);
  });
  it('recherche et puce se combinent', () => {
    expect(filterChannels(list, { chip: 'box', q: 'france', favs: none }).map((c) => c.id)).toEqual(['f']);
  });
  it('puces affichées : seulement celles qui ont des chaînes', () => {
    const ids = chipList(list, new Set(['a'])).map((k) => k.id);
    expect(ids).toEqual(['all', 'fav', 'box', 'news', 'sport', 'kids', 'fun']);
    expect(chipList(list, new Set(['a'])).find((k) => k.id === 'fav')?.count).toBe(1);
  });
});

describe('favoris par profil', () => {
  it('clé par profil, clé commune sans profil', () => {
    expect(favStorageKey()).toBe('ls_tv_fav');
    expect(favStorageKey('p1')).toBe('ls_tv_fav:p1');
    expect(favStorageKey('p1')).not.toBe(favStorageKey('p2'));
  });
  it('ajout et retrait', () => {
    expect(toggleId(['a'], 'b')).toEqual({ list: ['a', 'b'], on: true });
    expect(toggleId(['a', 'b'], 'a')).toEqual({ list: ['b'], on: false });
  });
});

describe('fenêtre de rendu', () => {
  it('ne dessine que les lignes visibles plus une marge, même pour des milliers de chaînes', () => {
    const w = windowRange(6800, 600, 68, 5000);
    expect(w.start).toBe(94);
    expect(w.end - w.start).toBeLessThan(30);
    expect(windowRange(0, 0, 68, 5)).toEqual({ start: 0, end: 5 });
    expect(windowRange(0, 600, 68, 0)).toEqual({ start: 0, end: 0 });
  });
  it('centre la ligne courante sans dépasser les bornes', () => {
    expect(centerScroll(100, 68, 600, 300)).toBe(100 * 68 - 266);
    expect(centerScroll(0, 68, 600, 300)).toBe(0);
    expect(centerScroll(299, 68, 600, 300)).toBe(300 * 68 - 600);
  });
});

describe('pistes : libellés lisibles', () => {
  const o = (id: string, label: string, selected = false) => ({ id, label, selected });
  it('langue, variante et indicateurs', () => {
    expect(trackRow(o('0', 'Français VFF · AAC Stéréo'), 'audio')).toMatchObject({ text: 'Français', detail: 'VFF · AAC Stéréo' });
    expect(trackRow(o('1', 'English audio description'), 'audio').text).toBe('Anglais (AD)');
    expect(trackRow(o('2', 'Français sourds et malentendants'), 'sub').text).toBe('Français (SME)');
    expect(trackRow(o('3', 'Piste 7'), 'audio').text).toBe('Piste 7');
  });
  it('sous-titres : « Désactivés » en tête ; doublons numérotés ; qualité seulement si plusieurs niveaux', () => {
    const m = tracksModel(
      [o('0', 'Français', true), o('1', 'Français')],
      [o('-1', 'Désactivés', true), o('0', 'Anglais')],
      [o('-1', 'Auto', true), o('0', '1080p'), o('1', '720p')],
    );
    expect(m.audio.map((r: { text: string }) => r.text)).toEqual(['Français', 'Français 2']);
    expect(m.subs[0]).toMatchObject({ text: 'Désactivés', selected: true });
    expect(m.quality.map((r: { detail: string }) => r.detail)).toEqual(['Selon la connexion', 'Full HD', 'HD']);
    expect(tracksModel([], [], [o('-1', 'Auto', true)]).quality).toEqual([]);
  });
});

describe('panneaux dans le DOM', () => {
  it('liste fenêtrée, filtre, favori et choix au clavier', async () => {
    const { mountChannelsPanel, renderTracksPanel, tracksKey } = await import('../src/ui/tvPanels.js');
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => { f(); return 1; });
    const many = Array.from({ length: 400 }, (_, i) => ch('c' + i, 'Chaîne ' + i, { num: i + 1, cat: i % 2 ? 'Sport' : 'Cinéma' }));
    const favs: string[] = [];
    const picked: string[] = [];
    const host = document.createElement('aside');
    document.body.append(host);
    const api = mountChannelsPanel(host, {
      channels: () => many, currentId: () => 'c3', favs: () => favs, toggleFav: (id: string) => { favs.push(id); },
      logoHTML: () => '<span class="chlogo"></span>', nowNext: () => ({ cur: null, next: null }), ensureEpg: async () => {}, onPick: (c: { id: string }) => picked.push(c.id),
    });
    expect(host.querySelectorAll('.cp-row').length).toBeLessThan(40); // fenêtré
    expect(host.querySelector('.cp-main[aria-current="true"]')?.getAttribute('data-pid')).toBe('c3');
    const input = host.querySelector('.cp-q') as HTMLInputElement;
    input.value = 'chaine 399';
    input.dispatchEvent(new Event('input'));
    expect(api.ids()).toEqual(['c399']);
    (host.querySelector('.cp-fav') as HTMLElement).click();
    expect(favs).toEqual(['c399']);
    // Entrée dans la recherche : première chaîne
    input.focus();
    expect(api.key(new KeyboardEvent('keydown', { key: 'Enter' }) as never)).toBe(null);
    const ev = { key: 'Enter', target: input } as unknown as KeyboardEvent;
    expect(api.key(ev)).toBe(true);
    expect(picked).toEqual(['c399']);
    (host.querySelector('.cp-main') as HTMLElement).click();
    expect(picked).toEqual(['c399', 'c399']);
    api.dispose();

    const el = document.createElement('aside');
    document.body.append(el);
    renderTracksPanel(el, { audio: [{ id: '0', label: 'Français', selected: true }, { id: '1', label: 'English', selected: false }], subs: [{ id: '-1', label: 'Désactivés', selected: true }], levels: [], channelName: 'TF1' });
    expect(el.querySelectorAll('[role="radio"]').length).toBe(3);
    expect(el.querySelector('.tp-quality')).toBeNull();
    const first = el.querySelector('[data-pitem="audio"]') as HTMLElement;
    first.focus();
    expect(tracksKey(el, { key: 'ArrowDown', target: first } as unknown as KeyboardEvent)).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.pid).toBe('1');
    vi.unstubAllGlobals();
  });
});
