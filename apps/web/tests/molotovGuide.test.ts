// Guide TV Molotov dans la grille : `epgKey` renvoie l'id de la chaîne Molotov, `loadMolotovChannels` remplit `tv.epg`
// (start/stop en secondes, title, desc, icon), la grille ne rend que les programmes de sa fenêtre, `nowNext` donne
// courant/suivant (« En cours » / « Ensuite » dans le lecteur), et le guide se recharge quand la fenêtre de grille
// change — sinon `tvWindow()` vide `tv.epg` et la grille se vide au-delà d'une heure. Le repli « Programme
// indisponible » / titre du catalogue reste en place pour les chaînes sans guide.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/** État piloté par les tests : catalogue et guide renvoyés par le client Molotov simulé. */
const mocked = vi.hoisted(() => ({
  channels: [] as Array<Record<string, unknown>>,
  epg: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/data/molotovApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/molotovApi')>()),
  getMolotovStatus: vi.fn(async () => ({ connected: true })),
  getMolotovChannels: vi.fn(async () => mocked.channels),
  getMolotovEpg: vi.fn(async () => mocked.epg),
}));

// La lecture DASH n'est pas celle de ces tests : le lecteur est ouvert pour son cartouche (« Ensuite »).
vi.mock('../player/molotov', () => ({
  destroyMolotov: vi.fn(),
  startMolotovPlayback: vi.fn(async () => undefined),
}));

const CHANNEL = { id: '600046', name: 'TF1', callSign: 'tf1', logo: '', group: 'France', program: 'Émission du catalogue' };
const iso = (at: number) => new Date(at * 1000).toISOString();

/** Guide renvoyé par le serveur : programmes autour de `now` (secondes), tel que le compactage serveur les livre. */
function guideAt(now: number) {
  return [
    {
      id: CHANNEL.id,
      name: CHANNEL.name,
      programs: [
        { id: 'vieux', title: 'Vieux programme', start: iso(now - 7200), end: iso(now - 3600) },
        { id: 'courant', title: 'Programme courant', start: iso(now - 600), end: iso(now + 600), desc: 'Description', image: 'https://img.example/courant.jpg' },
        { id: 'suivant', title: 'Programme suivant', start: iso(now + 600), end: iso(now + 1800) },
      ],
    },
  ];
}

type PlayerMod = typeof import('../src/ui/player.js');
type TvMod = typeof import('../src/ui/tv.js');
let player: PlayerMod;
let tvMod: TvMod;

/** Chaîne Molotov construite par `loadMolotovChannels` (id = `molotov:<id Molotov>`). */
const molotovChannel = () => tvMod.allChannels().find((x: { id: string }) => x.id === 'molotov:600046');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_tv-1' }));
  // player.js d'abord : tv.js importe (par shows.js) player.js ; dans l'autre sens, playerEl n'est pas encore défini.
  player = await import('../src/ui/player.js');
  tvMod = await import('../src/ui/tv.js');
});

describe('guide TV Molotov', () => {
  it('epgKey : la clé du guide est l\'id de la chaîne Molotov', async () => {
    mocked.channels = [CHANNEL];
    mocked.epg = [];
    await tvMod.loadMolotovChannels();
    const c = molotovChannel();
    expect(c.id).toBe('molotov:600046');
    expect(c.source).toBe('molotov');
    expect(tvMod.epgKey(c)).toBe('molotov:600046');
    expect(tvMod.epgKey(c)).toBe(c.id);
  });

  it('la grille reçoit les programmes (start/stop en secondes, title, desc, icon)', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocked.channels = [CHANNEL];
    mocked.epg = guideAt(now);
    await tvMod.loadMolotovChannels();
    const progs = tvMod.tv.epg.get(tvMod.epgKey(molotovChannel())) || [];
    expect(progs.map((p: { title: string }) => p.title)).toEqual(['Vieux programme', 'Programme courant', 'Programme suivant']);
    expect(progs[1].start).toBe(now - 600);
    expect(progs[1].stop).toBe(now + 600);
    expect(progs[1].desc).toBe('Description');
    expect(progs[1].icon).toBe('https://img.example/courant.jpg');
  });

  it('filtrage temporel : la grille ne rend que les programmes de sa fenêtre', () => {
    const w0 = tvMod.tvWindow();
    const c = molotovChannel();
    tvMod.tv.epg.set(tvMod.epgKey(c), [
      { start: w0 - 3600, stop: w0 - 1800, title: 'Avant la fenêtre' },
      { start: w0 + 600, stop: w0 + 1200, title: 'Dans la fenêtre' },
      { start: w0 + 7 * 3600, stop: w0 + 8 * 3600, title: 'Après la fenêtre' },
    ]);
    const detail = document.getElementById('detail')!;
    detail.innerHTML = '<div class="epg-row" data-chid="molotov:600046"><div class="epg-line"></div></div>';
    tvMod.fillEpgRow(molotovChannel());
    const line = detail.querySelector('.epg-line')!;
    expect(line.textContent).toContain('Dans la fenêtre');
    expect(line.textContent).not.toContain('Avant la fenêtre');
    expect(line.textContent).not.toContain('Après la fenêtre');
  });

  it('nowNext : courant et suivant, repli du titre du catalogue sans guide', () => {
    const now = Math.floor(Date.now() / 1000);
    const c = molotovChannel();
    tvMod.tv.epg.set(tvMod.epgKey(c), [
      { start: now - 600, stop: now + 600, title: 'Programme courant' },
      { start: now + 600, stop: now + 1800, title: 'Programme suivant' },
    ]);
    const nn = tvMod.nowNext(c, now);
    expect(nn.cur?.title).toBe('Programme courant');
    expect(nn.next?.title).toBe('Programme suivant');
    // Sans guide pour cette chaîne : le titre du catalogue tient lieu de programme en cours (repli conservé).
    const repli = tvMod.nowNext({ ...c, id: 'molotov:sans-guide' }, now);
    expect(repli.cur?.title).toBe('Émission du catalogue');
    expect(repli.next).toBeNull();
  });

  it('le lecteur affiche « En cours » et « Ensuite » pour une chaîne Molotov', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocked.channels = [CHANNEL];
    mocked.epg = guideAt(now);
    await tvMod.loadMolotovChannels();
    const c = molotovChannel();
    player.openPlayer(c, [c], null);
    const banner = document.getElementById('player-banner')!;
    expect(banner.textContent).toContain('En cours');
    expect(banner.textContent).toContain('Programme courant');
    expect(banner.textContent).toContain('Ensuite : Programme suivant');
    player.closePlayer(true);
  });

  it('le guide se recharge quand la fenêtre de grille change', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocked.channels = [CHANNEL];
    mocked.epg = guideAt(now);
    await tvMod.loadMolotovChannels();
    const key = tvMod.epgKey(molotovChannel());
    expect(tvMod.tv.epg.get(key).length).toBe(3);
    // La fenêtre de grille recule d'une heure : `tvWindow()` vide `tv.epg`, le guide doit y revenir.
    tvMod.tv.w0 -= 3600;
    tvMod.tvWindow();
    expect(tvMod.tv.epg.size).toBe(0);
    await tvMod.ensureMolotovEpg();
    expect(tvMod.tv.epg.get(key).length).toBe(3);
  });
});
