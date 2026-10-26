// Replay Molotov dans l'écran TV : la catégorie « Replay Molotov » s'affiche avec un compte connecté (absente sinon),
// une tuile programme ouvre la fiche (ses épisodes se lancent), une tuile asset lance la lecture avec la config déjà
// obtenue, et une erreur réseau est annoncée dans la ligne d'état de l'app.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/** État piloté par les tests : catalogue, fiche et config de lecture du client Molotov simulé. */
const mocked = vi.hoisted(() => ({
  connected: true,
  replayErr: false,
  replay: [] as Array<Record<string, unknown>>,
  program: { id: 's-1', title: 'Série une', episodes: [] } as Record<string, unknown> | null,
  play: { manifestUrl: 'https://cdn.example/replay.mpd', drm: null, heartbeatUrl: null, channelId: 'ch-9', assetId: 'LIVE_400' },
  programCalls: [] as string[],
  playCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/data/molotovApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/molotovApi')>()),
  getMolotovStatus: vi.fn(async () => ({ connected: mocked.connected })),
  getMolotovChannels: vi.fn(async () => []),
  getMolotovEpg: vi.fn(async () => []),
  getMolotovReplay: vi.fn(async () => {
    if (mocked.replayErr) throw new TypeError('network down');
    return mocked.replay;
  }),
  getMolotovProgram: vi.fn(async (id: string) => {
    mocked.programCalls.push(id);
    return mocked.program as never;
  }),
  getMolotovPlayAsset: vi.fn(async (req: Record<string, unknown>) => {
    mocked.playCalls.push(req);
    return mocked.play as never;
  }),
}));

// La lecture DASH n'est pas celle de ces tests : seul le chemin d'appel compte (config fournie au lecteur).
vi.mock('../src/player/molotov', () => ({
  destroyMolotov: vi.fn(),
  startMolotovPlayback: vi.fn(async () => undefined),
}));

/** Tuile programme : le clic ouvre la fiche, qui porte ses épisodes. */
const ITEM_FICHE = {
  id: 'p-2',
  title: 'Émission deux',
  subtitle: null,
  image: 'https://img.example/p2.jpg',
  kind: 'program',
  assetId: 'LIVE_200',
  channelId: 'ch-2',
  programId: 'p-2',
  playUrl: null,
};

/** Tuile asset seule : le clic lance directement la lecture, avec l'URL `on_play` de la page. */
const ITEM_PLAY = {
  id: 'LIVE_400',
  title: 'Documentaire seul',
  subtitle: null,
  image: null,
  kind: 'program',
  assetId: 'LIVE_400',
  channelId: 'ch-4',
  programId: null,
  playUrl: 'https://api-eu.fubo.tv/vapi/asset/v1?assetId=LIVE_400&type=scrub',
};

type PlayerMod = typeof import('../src/ui/player.js');
type TvMod = typeof import('../src/ui/tv.js');
type ReplayMod = typeof import('../src/ui/molotovReplay.js');
let player: PlayerMod;
let tvMod: TvMod;
let replayMod: ReplayMod;
let playback: typeof import('../src/player/molotov');

async function settle(ms = 60): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, ms / 6));
}

/** Écran TV ouvert, catégorie Replay Molotov affichée. */
async function openReplayScreen(items: Array<Record<string, unknown>>): Promise<void> {
  mocked.connected = true;
  mocked.replayErr = false;
  mocked.replay = items;
  mocked.programCalls = [];
  mocked.playCalls = [];
  await replayMod.loadMolotovReplay();
  const detail = document.getElementById('detail')!;
  detail.hidden = false;
  detail.innerHTML = tvMod.tvPageHTML();
  await tvMod.setCategory('Replay Molotov');
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_tv-1' }));
  // player.js d'abord : tv.js l'importe (par le routeur) ; dans l'autre sens, playerEl n'est pas encore défini.
  player = await import('../src/ui/player.js');
  tvMod = await import('../src/ui/tv.js');
  replayMod = await import('../src/ui/molotovReplay.js');
  playback = await import('../src/player/molotov');
  // La délégation des clics (tuiles, « Regarder ») vit dans events.js.
  await import('../src/ui/events.js');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

describe('Replay Molotov', () => {
  it('la catégorie s\'affiche avec un compte connecté, absente sinon', async () => {
    await openReplayScreen([ITEM_FICHE, ITEM_PLAY]);
    expect(tvMod.catsHTML()).toContain('Replay Molotov');
    expect(tvMod.catCount('Replay Molotov')).toBe(2);
    // Pas de compte connecté : pas de catégorie (repli propre).
    mocked.connected = false;
    await replayMod.loadMolotovReplay();
    expect(tvMod.catsHTML()).not.toContain('Replay Molotov');
  });

  it('le clic sur une tuile programme ouvre la fiche avec ses épisodes', async () => {
    mocked.program = {
      id: 'p-2',
      title: 'Émission deux',
      description: 'Une longue description.',
      episodes: [{ id: 'e-1', title: 'Épisode 1', subtitle: null, image: null, assetId: 'LIVE_201' }],
    };
    await openReplayScreen([ITEM_FICHE]);
    const tile = document.querySelector<HTMLElement>('[data-tvreplay="p-2"]');
    expect(tile).not.toBeNull();
    tile!.click();
    await settle();
    expect(mocked.programCalls).toEqual(['p-2']);
    const box = document.getElementById('tv-detail')!;
    expect(box.textContent).toContain('Une longue description.');
    expect(box.querySelector('[data-tvreplayplay="LIVE_201"]')).not.toBeNull();
    // L'épisode se lance avec sa config de lecture déjà obtenue.
    box.querySelector<HTMLElement>('[data-tvreplayplay="LIVE_201"]')!.click();
    await settle();
    expect(mocked.playCalls).toEqual([{ assetId: 'LIVE_201', playUrl: undefined }]);
    expect(vi.mocked(playback.startMolotovPlayback)).toHaveBeenCalledWith(
      expect.objectContaining({ play: mocked.play, mediaElement: expect.anything() }),
    );
    player.closePlayer(true);
  });

  it('le clic sur une tuile asset lance la lecture avec la config de lecture fournie', async () => {
    await openReplayScreen([ITEM_PLAY]);
    const tile = document.querySelector<HTMLElement>('[data-tvreplay="LIVE_400"]');
    expect(tile).not.toBeNull();
    tile!.click();
    await settle();
    // L'URL `on_play` de la page est passée telle quelle (sinon le serveur construit l'appel asset).
    expect(mocked.playCalls).toEqual([{ assetId: 'LIVE_400', playUrl: ITEM_PLAY.playUrl }]);
    expect(vi.mocked(playback.startMolotovPlayback)).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ch-4', play: mocked.play, mediaElement: expect.anything() }),
    );
    expect(document.getElementById('player')!.hidden).toBe(false);
    player.closePlayer(true);
  });

  it('erreur réseau : message dans la ligne d\'état, catégorie absente', async () => {
    mocked.connected = true;
    mocked.replayErr = true;
    mocked.replay = [ITEM_PLAY];
    await replayMod.loadMolotovReplay();
    expect(tvMod.catsHTML()).not.toContain('Replay Molotov');
    expect(document.getElementById('toast')!.textContent).toContain('replay Molotov');
  });
});
