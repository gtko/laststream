import { describe, expect, it, vi } from 'vitest';
import { fillRow, ROW_PAGES_MAX, rankTop, TOP_COUNT, type RowPage } from '../src/data/rows';

type Item = { key: string };

/** Source paginée : chaque page donne `raw` titres reçus, dont seuls `visible` passent le filtre « accueil ». */
const source = (pages: Array<{ raw: number; visible: string[] }>) =>
  vi.fn(async (page: number): Promise<RowPage<Item> | null> => {
    const p = pages[page - 1];
    if (!p) return null;
    return { title: 'Top 10 films', raw: p.raw, items: p.visible.map((key) => ({ key })) };
  });

const keep = async (fresh: Item[]) => fresh;

describe('remplissage des rangées (filtre de l’accueil)', () => {
  it('le Top 10 est recomplété à 10 titres à partir des pages suivantes, dans l’ordre', async () => {
    const load = source([
      { raw: 20, visible: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }, // 12 déjà vus retirés
      { raw: 20, visible: ['i', 'j', 'k', 'l', 'm', 'n', 'o'] },
    ]);
    const res = await fillRow(load, TOP_COUNT, keep);
    expect(res?.title).toBe('Top 10 films');
    expect(res?.items.map((it) => it.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('numérotation du Top 10 continue de 1 à 10 après filtrage', async () => {
    const load = source([
      { raw: 20, visible: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      { raw: 20, visible: ['i', 'j', 'k', 'l', 'm', 'n', 'o'] },
    ]);
    const res = await fillRow(load, TOP_COUNT, keep);
    const ranked = rankTop(res!.items);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ranked.map((r) => r.item.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('une rangée déjà complète ne charge pas de page supplémentaire', async () => {
    const load = source([{ raw: 20, visible: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }, { raw: 20, visible: ['z'] }]);
    const res = await fillRow(load, TOP_COUNT, keep);
    expect(res?.items).toHaveLength(TOP_COUNT);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('s’arrête à la fin de la source (page vide)', async () => {
    const load = source([{ raw: 20, visible: ['a', 'b'] }, { raw: 0, visible: [] }]);
    const res = await fillRow(load, TOP_COUNT, keep);
    expect(res?.items.map((it) => it.key)).toEqual(['a', 'b']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('ne dépasse pas le nombre de pages prévu même si tout est filtré', async () => {
    const load = source(Array.from({ length: 10 }, () => ({ raw: 20, visible: [] as string[] })));
    const res = await fillRow(load, TOP_COUNT, keep);
    expect(res?.items).toEqual([]);
    expect(load).toHaveBeenCalledTimes(ROW_PAGES_MAX);
  });

  it('applique la disponibilité et écarte les doublons entre pages', async () => {
    const load = source([
      { raw: 20, visible: ['a', 'b', 'c'] },
      { raw: 20, visible: ['b', 'd', 'e', 'f'] },
    ]);
    const accept = vi.fn(async (fresh: Item[]) => fresh.filter((it) => it.key !== 'c'));
    const res = await fillRow(load, 5, accept);
    expect(res?.items.map((it) => it.key)).toEqual(['a', 'b', 'd', 'e', 'f']);
  });

  it('rangée absente : null ; absence sur une page suivante : on garde ce qu’on a', async () => {
    expect(await fillRow(source([]), TOP_COUNT, keep)).toBeNull();
    const res = await fillRow(source([{ raw: 20, visible: ['a', 'b'] }]), TOP_COUNT, keep);
    expect(res?.items.map((it) => it.key)).toEqual(['a', 'b']);
  });
});
