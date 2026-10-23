// Sources progressives (ODY-255) : la feuille « Télécharger » reçoit la première source dès la réponse de l'addon, sans attendre
// les addons lents ; le cache récent du titre s'affiche tout de suite ; une seule recherche (aucune sonde) ; la surveillance
// s'arrête à la fermeture de la feuille. La recherche des addons est simulée (loadSources, watchSources).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSourceChoices, resetDownloadsForTests, type DownloadTarget } from '../src/downloads/service';
import { sourceKeyOf, type SourceView } from '../src/sources/info';
import { httpStream, viewOf } from './downloads-fixtures';

const GB = 1024 ** 3;

const h = vi.hoisted(() => ({
  calls: 0,
  load: (): Promise<unknown> => Promise.resolve(undefined),
  watches: [] as Array<{ onUpdate: (next: unknown, added: number) => void; onEnd?: (last: unknown) => void; stop: () => void }>,
}));

vi.mock('../src/sources/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/load')>();
  return {
    ...actual,
    loadSources: () => {
      h.calls += 1;
      return h.load();
    },
    watchSources: (_req: unknown, _start: unknown, onUpdate: (next: unknown, added: number) => void, opts: { onEnd?: (last: unknown) => void } = {}) => {
      const stop = vi.fn();
      h.watches.push({ onUpdate, onEnd: opts.onEnd, stop });
      return stop;
    },
  };
});

const target = (n: number): DownloadTarget => ({ key: 'movie:' + n, type: 'movie', id: String(n), name: 'Film ' + n });
const flush = () => new Promise((r) => setTimeout(r, 0));
const full = (views: SourceView[], pending: string[] = []) => ({ imdb: 'tt1', views, pending });
const a = viewOf(httpStream({ filename: 'a.mkv', size: GB, resolution: '1080p' }), 0);
const b = viewOf(httpStream({ filename: 'b.mkv', size: 2 * GB, resolution: '2160p' }), 1);
const c = viewOf(httpStream({ filename: 'c.mkv', size: 3 * GB, resolution: '720p' }), 2);
const [kA, kB, kC] = [a, b, c].map(sourceKeyOf);

beforeEach(() => {
  localStorage.clear();
  resetDownloadsForTests();
  h.calls = 0;
  h.watches = [];
  h.load = () => Promise.resolve(full([]));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('sources progressives (feuille « Télécharger »)', () => {
  it('la première source s’affiche avant que l’addon lent réponde, puis la liste se complète', async () => {
    h.load = () => Promise.resolve(full([a], ['Lent']));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const seen: Array<[string[], boolean]> = [];
    const done = listSourceChoices(target(1), { onUpdate: (l, pending) => seen.push([l.map((x) => x.key), pending]) });
    await flush();
    expect(seen).toEqual([[[kA], true]]); // affichée alors que l'addon « Lent » n'a pas encore répondu
    expect(debug.mock.calls.some(([msg]) => String(msg).includes('premier résultat'))).toBe(true);
    expect(h.watches).toHaveLength(1);
    h.watches[0].onUpdate(full([a, b]), 1); // l'addon lent répond
    expect(seen.at(-1)).toEqual([[kB, kA], false]); // le 2160p passe devant
    h.watches[0].onEnd?.(full([a, b]));
    const choices = await done;
    expect(choices.map((x) => x.key)).toEqual([kB, kA]);
    expect(h.calls).toBe(1);
  });

  it('sans addon en attente : une seule réponse complète, aucune surveillance, aucune nouvelle recherche', async () => {
    h.load = () => Promise.resolve(full([a, b]));
    const seen: boolean[] = [];
    const choices = await listSourceChoices(target(2), { onUpdate: (_c, pending) => seen.push(pending) });
    expect(seen).toEqual([false]);
    expect(choices).toHaveLength(2);
    expect(h.watches).toHaveLength(0);
    expect(h.calls).toBe(1);
  });

  it('le cache récent du titre s’affiche tout de suite, avant la réponse de la nouvelle recherche', async () => {
    h.load = () => Promise.resolve(full([a, b]));
    await listSourceChoices(target(3)); // remplit le cache du titre (chemin sans onUpdate)
    h.load = () => new Promise(() => undefined); // la nouvelle recherche ne répond pas
    const seen: string[][] = [];
    void listSourceChoices(target(3), { onUpdate: (l) => seen.push(l.map((x) => x.key)) });
    await flush();
    expect(seen).toEqual([[kB, kA]]);
  });

  it('fermeture (signal) : la surveillance s’arrête, et une réponse tardive n’est plus affichée', async () => {
    h.load = () => Promise.resolve(full([a], ['Lent']));
    const ctrl = new AbortController();
    const seen: number[] = [];
    const done = listSourceChoices(target(4), { onUpdate: (l) => seen.push(l.length), signal: ctrl.signal });
    await flush();
    ctrl.abort();
    expect(h.watches[0].stop).toHaveBeenCalled();
    h.watches[0].onUpdate(full([a, b]), 1); // réponse arrivée après la fermeture
    expect(seen).toEqual([1]);
    await done; // se termine dès l'annulation
  });

  it('réouverture : une recherche partielle ne retire aucune source affichée ni de la liste gardée, la liste finale remplace', async () => {
    h.load = () => Promise.resolve(full([a, b]));
    await listSourceChoices(target(5)); // la liste gardée du titre a 2 sources
    h.load = () => Promise.resolve(full([a], ['Lent'])); // nouvelle recherche partielle : 1 source, un addon lent en attente
    const seen: Array<[string[], boolean]> = [];
    const done = listSourceChoices(target(5), { onUpdate: (l, pending) => seen.push([l.map((x) => x.key).sort(), pending]) });
    await flush();
    expect(seen.at(-1)).toEqual([[kA, kB].sort(), true]); // les 2 lignes restent affichées pendant la recherche partielle
    expect(seen.every(([keys]) => keys.length === 2)).toBe(true);
    expect(await listSourceChoices(target(5), { exclude: { filename: 'inconnu.mkv' } })).toHaveLength(2); // liste gardée non réduite
    h.watches[0].onUpdate(full([a], ['Lent']), 0); // toujours en attente : aucune retrait
    expect(seen.at(-1)).toEqual([[kA, kB].sort(), true]);
    h.watches[0].onEnd?.(full([a])); // recherche finie : la liste finale s'applique
    const choices = await done;
    expect(choices.map((x) => x.key)).toEqual([kA]);
    expect(seen.at(-1)).toEqual([[kA], false]);
    expect(await listSourceChoices(target(5), { exclude: { filename: 'inconnu.mkv' } })).toHaveLength(1);
  });

  it('clé stable : l’ordre des réponses change, aucune source perdue ni en double, la clé désigne toujours la même source', async () => {
    h.load = () => Promise.resolve(full([a, b, c], ['Lent']));
    const seen: Array<[string[], boolean]> = [];
    const done = listSourceChoices(target(6), { onUpdate: (l, pending) => seen.push([l.map((x) => x.key).sort(), pending]) });
    await flush();
    const before = new Map<string, SourceView>();
    const first = await listSourceChoices(target(6), { exclude: { filename: 'inconnu.mkv' } });
    first.forEach((x) => before.set(x.key, x.view));
    // Une réponse partielle plus tard : une source s'est insérée en tête, les positions (index) ont toutes bougé.
    const shifted = [viewOf(httpStream({ filename: 'z.mkv', size: GB, resolution: '1080p' }), 0), { ...a, index: 1 }, { ...c, index: 2 }];
    h.watches[0].onUpdate(full(shifted, ['Lent']), 1);
    const [kZ] = [shifted[0]].map(sourceKeyOf);
    expect(seen.at(-1)).toEqual([[kA, kB, kC, kZ].sort(), true]); // B conservée, C une seule fois
    h.watches[0].onEnd?.(full(shifted));
    const choices = await done;
    expect(choices.map((x) => x.key).sort()).toEqual([kA, kC, kZ].sort());
    for (const x of choices) expect(sourceKeyOf(x.view)).toBe(x.key);
    expect(choices.find((x) => x.key === kC)?.view.filename).toBe('c.mkv');
    expect(before.get(kB)?.filename).toBe('b.mkv');
  });

  it('onEnd encore en attente (20 s écoulées) : les sources de l’addon lent déjà reçues sont conservées', async () => {
    h.load = () => Promise.resolve(full([a], ['Lent']));
    const done = listSourceChoices(target(7), { onUpdate: () => undefined });
    await flush();
    h.watches[0].onUpdate(full([a, b], ['Lent']), 1);
    h.watches[0].onEnd?.(full([a], ['Lent'])); // délai atteint : une réponse partielle, l'addon n'a pas fini
    const choices = await done;
    expect(choices.map((x) => x.key).sort()).toEqual([kA, kB].sort());
  });

  it('même release débridée, jeton /play/c/ différent d’une réponse à l’autre (copie ajoutée) : une seule ligne', async () => {
    const play = (tok: string, origin: string) => viewOf(httpStream({ filename: 'Film.2024.1080p.mkv', size: 4 * GB, url: 'https://lastaddon.example.test/cfg/play/c/' + tok + '?k=1', origin }), 0);
    const first = play('jetonA', 'Lumio');
    const second = play('jetonB', 'Autre'); // un addon lent a ajouté une copie : nouveau jeton, autre addon en tête
    expect(sourceKeyOf(first)).toBe(sourceKeyOf(second));
    h.load = () => Promise.resolve(full([first], ['Lent']));
    const seen: string[][] = [];
    const done = listSourceChoices(target(8), { onUpdate: (l) => seen.push(l.map((x) => x.key)) });
    await flush();
    h.watches[0].onUpdate(full([second], ['Lent']), 0);
    expect(seen.at(-1)).toHaveLength(1);
    h.watches[0].onEnd?.(full([second], ['Lent'])); // 20 s écoulées, addon encore en attente
    expect(await done).toHaveLength(1);
  });

  it('fermeture pendant la recherche : la liste partielle n’est pas gardée, la recherche suivante repart du réseau (ODY-260)', async () => {
    h.load = () => Promise.resolve(full([a], ['Lent']));
    const ctrl = new AbortController();
    void listSourceChoices(target(10), { onUpdate: () => undefined, signal: ctrl.signal });
    await flush();
    ctrl.abort(); // feuille d'épisode fermée alors qu'un addon répond encore
    h.load = () => Promise.resolve(full([a, b]));
    const next = await listSourceChoices(target(10), { exclude: { filename: 'inconnu.mkv' } }); // « autre source » ou saison : reprise de la liste gardée
    expect(next.map((x) => x.key).sort()).toEqual([kA, kB].sort());
    expect(h.calls).toBe(2);
  });
});

describe('clé stable sans taille connue (ODY-260)', () => {
  it('deux fichiers débridés de même nom, taille inconnue : deux sources distinctes, pas de fusion', () => {
    const play = (tok: string): SourceView => viewOf(httpStream({ filename: 'Film.2024.1080p.mkv', url: 'https://lastaddon.example.test/cfg/play/c/' + tok + '?k=1' }), 0);
    const x = play('jetonA');
    const y = play('jetonB');
    expect(x.sizeBytes).toBe(0);
    expect(sourceKeyOf(x).startsWith('u:')).toBe(true);
    expect(sourceKeyOf(x)).not.toBe(sourceKeyOf(y));
  });

  it('taille connue : la clé de release r: reste la même d’un jeton à l’autre', () => {
    const play = (tok: string): SourceView => viewOf(httpStream({ filename: 'Film.2024.1080p.mkv', size: 4 * GB, url: 'https://lastaddon.example.test/cfg/play/c/' + tok + '?k=1' }), 0);
    expect(sourceKeyOf(play('jetonA'))).toBe(sourceKeyOf(play('jetonB')));
    expect(sourceKeyOf(play('jetonA')).startsWith('r:')).toBe(true);
  });
});
