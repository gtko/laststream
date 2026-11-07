import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platform, setPlatform, type Platform } from '../src/platform/index.js';
import { type CatalogSnapshot, type EpgSnapshot, TV_KEYS, type TvBlobStore } from '../src/lt/tv-build.js';
import { buildCatalog } from '../src/lt/tv-catalog.js';
import { fullToken, startApp, type RunningApp } from './lt-harness.js';

/** Routes /lt/tv/* d'une plateforme à stockage TV (Workers : R2 alimenté par le Cron), avec un R2 simulé en mémoire. */

const now = Math.floor(Date.now() / 1000);

const catalog = buildCatalog({
  freetv: null,
  iptv: {
    channels: [
      { id: 'TF1.fr', name: 'TF1', country: 'FR', categories: ['general'] },
      { id: 'Web.fr', name: 'Web libre', country: 'FR', categories: ['news'] },
      { id: 'Relais.fr', name: 'Relais requis', country: 'FR', categories: ['news'] },
    ],
    streams: [
      { channel: 'TF1.fr', feed: 'SD', url: 'https://tf1.example/tf1.m3u8', quality: '720p', labels: [] },
      { channel: 'Web.fr', feed: 'SD', url: 'https://web.example/w.m3u8', quality: '720p', labels: [] },
      { channel: 'Relais.fr', feed: 'SD', url: 'https://relais.example/r.m3u8', quality: '720p', labels: [] },
    ],
    feeds: [],
    logos: [],
    countries: [{ code: 'FR', name: 'France', languages: ['fra'] }],
    languages: [{ code: 'fra', name: 'French' }],
    blocklist: [],
  },
  fast: [],
  partial: false,
});
for (const channel of catalog.channels) {
  if (channel.name === 'Web libre') channel.direct = true;
  if (channel.name === 'Relais requis') channel.direct = false;
}

const catalogSnapshot: CatalogSnapshot = { v: 1, builtAt: Date.now(), catalog };
const epgSnapshot: EpgSnapshot = {
  v: 1,
  builtAt: Date.now(),
  epgStats: [{ url: 'xmltvfr.fr/xmltv/xmltv_tnt.xml.gz', programmes: 1, ok: true }],
  programmes: { 'TF1.fr': [{ start: now - 600, stop: now + 600, title: 'Journal', desc: 'Infos', icon: '', category: 'News' }] },
};

function memoryStore(initial: Record<string, string>): { blobs: TvBlobStore; reads: string[]; data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    data,
    reads,
    blobs: {
      get: (key) => {
        reads.push(key);
        return Promise.resolve(data.get(key));
      },
      put: (key, value) => Promise.resolve(void data.set(key, value)),
    },
  };
}

describe('routes /lt/tv/* sur une plateforme à stockage TV', () => {
  const original = platform();
  const full = memoryStore({ [TV_KEYS.catalog]: JSON.stringify(catalogSnapshot), [TV_KEYS.epg]: JSON.stringify(epgSnapshot) });
  const refresh = vi.fn();
  let app: RunningApp;
  let base: string;

  beforeAll(async () => {
    setPlatform({
      ...original,
      capabilities: { ...original.capabilities, tvHls: false },
      tvStore: { blobs: full.blobs, requestRefresh: refresh },
    } satisfies Platform);
    app = await startApp({});
    base = `${app.baseUrl}/${fullToken()}/lt`;
  });
  afterAll(async () => {
    await app.close();
    setPlatform(original);
  });

  it('liste les chaînes lues dans le stockage, sans signature de proxy HLS ni téléchargement des sources', async () => {
    const res = await fetch(`${base}/tv/channels`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { name: string; sig: string | null; direct?: boolean; alternatives: { sig: string | null }[] }[];
    expect(list.map((c) => c.name).sort()).toEqual(['Relais requis', 'TF1', 'Web libre']);
    expect(list.every((c) => c.sig === null && c.alternatives.every((a) => a.sig === null))).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('direct=1 écarte les chaînes dont le flux exige le relais', async () => {
    const res = await fetch(`${base}/tv/channels?direct=1`);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((c) => c.name).sort()).toEqual(['TF1', 'Web libre']);
    expect((await fetch(`${base}/tv/channels?direct=oui`)).status).toBe(400);
  });

  it('EPG lu dans le stockage ; le proxy HLS reste désactivé', async () => {
    const res = await fetch(`${base}/tv/epg?ids=TF1.fr&from=${now - 3600}&to=${now + 3600}`);
    const programmes = (await res.json()) as { channelId: string; title: string }[];
    expect(programmes).toEqual([expect.objectContaining({ channelId: 'TF1.fr', title: 'Journal' })]);
    expect((await fetch(`${base}/tv/hls?u=https%3A%2F%2Ftf1.example%2Ftf1.m3u8&s=x`)).status).toBe(501);
    const health = (await (await fetch(`${base}/health`)).json()) as { capabilities: { tvHls: boolean } };
    expect(health.capabilities.tvHls).toBe(false);
  });

  it('stockage vide : 503 tv_building et construction demandée en arrière-plan', async () => {
    const empty = memoryStore({});
    const ask = vi.fn();
    setPlatform({ ...platform(), tvStore: { blobs: empty.blobs, requestRefresh: ask } });
    const other = await startApp({});
    try {
      const res = await fetch(`${other.baseUrl}/${fullToken()}/lt/tv/channels`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('tv_building');
      expect(ask).toHaveBeenCalledOnce();
    } finally {
      await other.close();
      setPlatform({ ...platform(), tvStore: { blobs: full.blobs, requestRefresh: refresh } });
    }
  });

  it('EPG absent : les chaînes restent servies, sans programmes', async () => {
    const noEpg = memoryStore({ [TV_KEYS.catalog]: JSON.stringify(catalogSnapshot) });
    setPlatform({ ...platform(), tvStore: { blobs: noEpg.blobs, requestRefresh: vi.fn() } });
    const other = await startApp({});
    try {
      const b = `${other.baseUrl}/${fullToken()}/lt`;
      expect((await fetch(`${b}/tv/channels`)).status).toBe(200);
      expect(await (await fetch(`${b}/tv/epg?ids=TF1.fr`)).json()).toEqual([]);
    } finally {
      await other.close();
      setPlatform({ ...platform(), tvStore: { blobs: full.blobs, requestRefresh: refresh } });
    }
  });
});
