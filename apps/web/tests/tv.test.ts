// Régression « La TV en direct ne marche plus » : le serveur refuse (400) un filtre de langue à deux lettres (« fr »),
// il attend l'ISO 639-3 (« fra »). Ce test charge la page TV avec un lastAddon simulé aussi strict que le vrai,
// vérifie l'ordre des chaînes (TNT d'abord, avec leur numéro) et le démarrage d'une chaîne (URL du proxy signée).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const hlsLoads: string[] = [];
vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { FRAG_LOADED: 'f', ERROR: 'e', MANIFEST_PARSED: 'm' };
    static ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'd' };
    on() { /* ignoré */ }
    loadSource(u: string) { hlsLoads.push(u); }
    attachMedia() { /* ignoré */ }
    startLoad() { /* ignoré */ }
    destroy() { /* ignoré */ }
  }
  return { default: FakeHls };
});

const fra = [{ code: 'fra', name: 'français' }];
const ch = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, logo: '', group: 'France', cat: 'Généraliste', source: 'freetv', fast: false, url: 'https://up.example/' + id + '.m3u8',
  epgId: id.replace(/^fr:/, ''), flaky: false, country: 'FR', countryName: 'France', languages: fra, categories: [{ id: 'generaliste', label: 'Généraliste' }],
  reliability: 'high', alternatives: [], sig: 'SIG_' + id.replace(/\W/g, ''), ...extra,
});
// Ordre du serveur : alphabétique.
const CHANNELS = [
  ch('fr:4Afghanistan.fr', '4 Afghanistan', { cat: 'Autre', categories: [{ id: 'autre', label: 'Autre' }], languages: [{ code: 'pus', name: 'pachto' }, { code: 'fra', name: 'français' }] }),
  ch('fr:6ter.fr', '6ter'),
  ch('fr:BFMTV.fr', 'BFM TV', { cat: 'Actualités' }),
  ch('fr:M6.fr', 'M6'),
  ch('fr:Persiana.fr', 'Persiana', { languages: [{ code: 'fas', name: 'persan' }] }),
  ch('fr:TF1.fr', 'TF1'),
];

const calls: string[] = [];
function mockFetch(url: string): Response {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  if (u.pathname.endsWith('/lt/tv/channels')) {
    const lang = u.searchParams.get('language');
    if (lang !== null && !/^[a-z]{3}$/.test(lang)) return json({ error: 'bad_request' }, 400); // comme le vrai serveur
    const wanted = lang ? CHANNELS.filter((c) => c.languages.some((l) => l.code === lang)) : CHANNELS;
    return json({ total: wanted.length, page: 1, limit: Number(u.searchParams.get('limit') || 60), channels: wanted });
  }
  if (u.pathname.endsWith('/lt/tv/facets')) {
    return json({ total: 6, countries: [{ code: 'FR', name: 'France', count: 6 }], languages: [{ code: 'fra', name: 'français', count: 5 }], categories: [{ code: 'generaliste', name: 'Généraliste', count: 5 }], sources: [{ code: 'freetv', name: 'freetv', count: 6 }] });
  }
  if (u.pathname.endsWith('/lt/tv/epg')) {
    const now = Math.floor(Date.now() / 1000);
    const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean);
    return json(ids.map((id) => ({ channelId: id, start: now - 600, stop: now + 1800, title: 'Journal de test', desc: '', icon: '', category: 'Info' })));
  }
  if (u.pathname.includes('/lt/tmdb/')) return json({ results: [] });
  return json({ error: 'not_found' }, 404);
}

async function settle(ms = 60): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, ms / 20));
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_tv-1' }));
  // Un ancien réglage enregistré avec « fr » doit être migré, pas envoyé tel quel.
  localStorage.setItem('ls_tv_filters', JSON.stringify({ country: 'FR', language: 'fr', source: '', q: '', reliable: true }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  await import('../src/main.js');
  await settle(300);
});

describe('TV en direct', () => {
  it('charge la page avec le filtre de langue ISO 639-3 et classe les chaînes par pertinence', async () => {
    location.hash = '#/tv-live';
    await settle(500);
    const chanCalls = calls.filter((c) => c.includes('/lt/tv/channels?'));
    expect(chanCalls.length).toBeGreaterThan(0);
    expect(chanCalls.every((c) => !/language=fr(&|$)/.test(c))).toBe(true);
    expect(chanCalls.some((c) => c.includes('language=fra'))).toBe(true);
    const page = document.querySelector('#detail .tv-page')!;
    expect(page).not.toBeNull();
    expect(page.querySelector('.row-msg')).toBeNull(); // pas de « Les chaînes n'ont pas pu être chargées »
    const rows = Array.from(page.querySelectorAll('.epg-row')).map((r) => r.getAttribute('data-chid'));
    // TNT dans l'ordre officiel (TF1 1, M6 6, BFM TV 15, 6ter 22), puis le reste ; la chaîne persane est filtrée.
    expect(rows).toEqual(['fr:TF1.fr', 'fr:M6.fr', 'fr:BFMTV.fr', 'fr:6ter.fr', 'fr:4Afghanistan.fr']);
    const nums = Array.from(page.querySelectorAll('.epg-name .ch-num')).map((n) => n.textContent);
    expect(nums).toEqual(['1', '6', '15', '22']);
    expect(page.querySelector('#tv-filters select[name="language"]')).not.toBeNull();
  });

  it('retombe sur la liste complète si le serveur refuse quand même le filtre de langue', async () => {
    const tvMod = await import('../src/ui/tv.js');
    const r = await tvMod.fetchChannels({ country: 'FR', language: 'fr', page: 1, limit: 500 }, { country: 'FR', language: 'fra', reliable: true }, 'Toutes');
    expect(r.channels.map((c: { name: string }) => c.name)).not.toContain('Persiana');
    expect(r.channels.length).toBeGreaterThan(0);
  });

  it('lance une chaîne : hls.js reçoit l’URL du proxy avec la signature renvoyée par le serveur', async () => {
    const page = document.querySelector('#detail .tv-page')!;
    (page.querySelector('.epg-ch[data-tvplay="fr:TF1.fr"]') as HTMLElement).click();
    await settle(300);
        const player = document.getElementById('player') as HTMLElement;
    expect(player.hidden).toBe(false);
    const expected = 'http://localhost:7000/CFG_tv-1/lt/tv/hls?u=' + encodeURIComponent('https://up.example/fr:TF1.fr.m3u8') + '&s=SIG_frTF1fr';
    expect(hlsLoads).toContain(expected);
    (player.querySelector('[data-pclose]') as HTMLElement).click();
    expect(player.hidden).toBe(true);
  });

  it('application Android : le lecteur natif reçoit l’URL du proxy HLS', async () => {
    const opened: Array<{ url: string; title: string }> = [];
    const plugin = {
      open: vi.fn(async (o: { url: string; title: string }) => { opened.push(o); }),
      addListener: vi.fn(async () => ({ remove: () => undefined })),
      close: vi.fn(async () => undefined),
    };
    (globalThis as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, Plugins: { LaststreamPlayer: plugin } };
    const { openPlayer, closePlayer } = await import('../src/ui/player.js');
    const { tv } = await import('../src/ui/tv.js');
    const c = tv.byId.get('fr:M6.fr');
    openPlayer(c, [c], null);
    await settle(200);
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toBe('http://localhost:7000/CFG_tv-1/lt/tv/hls?u=' + encodeURIComponent('https://up.example/fr:M6.fr.m3u8') + '&s=SIG_frM6fr');
    expect(opened[0].title).toBe('M6');
    closePlayer(true);
    expect(plugin.close).toHaveBeenCalled();
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('coque Windows : mpv charge l’URL du proxy HLS', async () => {
    const sent: Array<[string, unknown]> = [];
    const listeners: Array<(ev: { data: unknown }) => void> = [];
    (window as unknown as { chrome: unknown }).chrome = {
      webview: {
        postMessage: (m: string) => {
          const msg = JSON.parse(m);
          if (msg.type === 3) setTimeout(() => listeners.forEach((l) => l({ data: { type: 3, data: { transport: { properties: [] } } } })), 0);
          else sent.push([msg.args[0], msg.args[1]]);
        },
        addEventListener: (_t: string, fn: (ev: { data: unknown }) => void) => { listeners.push(fn); },
      },
    };
    const { resetShell } = await import('../src/player/shell');
    resetShell();
    const { openPlayer, closePlayer } = await import('../src/ui/player.js');
    const { tv } = await import('../src/ui/tv.js');
    const c = tv.byId.get('fr:TF1.fr');
    openPlayer(c, [c], null);
    await settle(900);
    const load = sent.find(([ev, args]) => ev === 'mpv-command' && Array.isArray(args) && args[0] === 'loadfile');
    expect(load).toBeDefined();
    expect((load![1] as string[])[1]).toBe('http://localhost:7000/CFG_tv-1/lt/tv/hls?u=' + encodeURIComponent('https://up.example/fr:TF1.fr.m3u8') + '&s=SIG_frTF1fr');
    closePlayer(true);
    delete (window as unknown as { chrome?: unknown }).chrome;
    resetShell();
  });
});
