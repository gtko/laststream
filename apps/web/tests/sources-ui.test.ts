// Réglages > Sources : cartes, manifest, ordre de priorité, activation.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const posts: Array<{ url: string; body: unknown }> = [];

function mockFetch(url: string, init?: RequestInit): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  // Sécurité : flux de test (Matrix) selon l’addon ; à traiter avant les manifests.
  if (u.pathname.includes('/stream/movie/')) {
    if (u.hostname === 'configurable.example' || u.hostname === 'torrentio.example') return json({ streams: [{ infoHash: 'a'.repeat(40), title: 'Matrix' }] });
    if (u.hostname === 'opaque.example') return json({ streams: [{ url: 'https://opaque.example/resolve/abc', title: 'Matrix' }] });
  }
  if (u.hostname === 'addon.example') {
    return json({ name: 'Mon Addon', version: '2.1.0', description: 'Des sources en français', logo: 'https://addon.example/logo.png', types: ['movie', 'series'], resources: ['catalog', { name: 'stream' }] });
  }
  if (u.hostname === 'nostream.example') return json({ name: 'Catalogue seul', version: '1.0.0', resources: ['catalog'], types: ['movie'] });
  if (u.hostname === 'blocked.example') throw new TypeError('Failed to fetch'); // CORS
  if (u.hostname === 'configurable.example') {
    return json({ name: 'Addon configurable', version: '1.0.0', logo: 'https://configurable.example/logo.png', types: ['movie'], resources: ['catalog', 'stream'], behaviorHints: { configurable: true } });
  }
  if (u.hostname === 'torrentio.example') return json({ name: 'Torrentio', version: '0.1.0', resources: ['stream'], types: ['movie'] });
  if (u.hostname === 'opaque.example') return json({ name: 'Opaque', version: '1.0.0', resources: ['stream'], types: ['movie'] });
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') {
    return json({
      services: {}, languages: {}, sources: [
        { type: 'upstream', name: 'Addon amont', url: 'https://addon.example/manifest.json' },
        { type: 'torznab', name: 'Prowlarr', baseUrl: 'https://prowlarr.example/api', apiKey: { set: true, last4: '…abcd' } },
        { type: 'upstream', name: 'Bloqué', url: 'https://blocked.example/manifest.json', enabled: false },
      ],
    });
  }
  if (u.pathname === '/config/test') {
    posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return json({ sources: [{ name: 'Bloqué', type: 'upstream', ok: true, manifest: { name: 'Addon via lastAddon', logo: 'https://x.example/l.png', version: '3.0.0' } }], services: [] });
  }
  return json({ error: 'not_found' }, 404);
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const names = () => Array.from(document.querySelectorAll('#detail .src-card .src-name')).map((n) => n.textContent);

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  location.hash = '#/settings';
  await import('../src/main.js');
  await settle(900);
});

describe('manifest', () => {
  it('normalise les adresses (stremio://, sans manifest.json)', async () => {
    const { normalizeManifestUrl, manifestInfo } = await import('../src/ui/settings-sources.js');
    expect(normalizeManifestUrl('stremio://addon.example/abc/manifest.json')).toBe('https://addon.example/abc/manifest.json');
    expect(normalizeManifestUrl('https://addon.example/abc/')).toBe('https://addon.example/abc/manifest.json');
    expect(normalizeManifestUrl('addon.example')).toBe('https://addon.example/manifest.json');
    expect(normalizeManifestUrl('')).toBe('');
    expect(manifestInfo({ name: 'A', icon: '/i.png', resources: ['stream'] })).toMatchObject({ name: 'A', logo: '/i.png', hasStream: true });
    expect(manifestInfo({ resources: [{ name: 'catalog' }] }).hasStream).toBe(false);
  });
});

describe('cartes de sources', () => {
  it('Sources : seulement les addons Stremio et « Préférences de lecture » (qualité maximale) ; plus de débrideurs', () => {
    expect(document.querySelector('[data-set-addsrc="torznab"]')).toBeNull();
    expect(document.querySelector('[data-set-addsrc="upstream"]')!.textContent).toContain('addon Stremio');
    const titles = Array.from(document.querySelectorAll('#set-p-sources h3')).map((h) => h.textContent);
    expect(titles).toEqual(['Addons Stremio', 'Préférences de lecture']);
    const max = document.querySelector('#set-p-sources select[name="resMax"]') as HTMLSelectElement;
    expect(Array.from(max.options).map((o) => o.textContent)).toEqual(['Aucune limite', '4K', '1080p', '720p']);
    const panel = document.querySelector('#set-p-sources')!.cloneNode(true) as HTMLElement;
    panel.querySelectorAll('.src-card').forEach((c) => c.remove()); // sources existantes de la configuration
    const text = panel.textContent!;
    expect(text).not.toMatch(/Prowlarr|indexeur|AllDebrid|TorBox|Real-Debrid|Débridage|Résolutions|Tailles/i);
    expect(document.querySelector('#detail details.set-adv, #set-debrid, [name="onlyCached"], [name="minGb"], [name="maxResults"]')).toBeNull();
    expect(document.querySelector('#set-h-sources')!.textContent).toBe('Sources');
  });

  it('affiche des cartes compactes avec logo, nom du manifest, version, types et état', () => {
    const cards = Array.from(document.querySelectorAll('#detail .src-card')) as HTMLElement[];
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelector('.src-pos')!.textContent).toBe('1');
    expect(cards[0].querySelector('.src-name')!.textContent).toBe('Mon Addon'); // nom pris dans le manifest
    expect(cards[0].querySelector('.src-logo img')!.getAttribute('src')).toBe('https://addon.example/logo.png');
    expect(cards[0].querySelector('.src-sub')!.textContent).toContain('v2.1.0');
    expect(cards[0].querySelector('.src-sub')!.textContent).toContain('Films, Séries');
    expect(cards[0].querySelector('.src-dot')!.classList.contains('is-ok')).toBe(true);
    expect(cards[0].querySelector('.src-edit')!.hasAttribute('hidden')).toBe(true); // compacte
    // Torznab : icône générique et indexeur.
    expect(cards[1].querySelector('.src-logo svg')).not.toBeNull();
    expect(cards[1].querySelector('.src-sub')!.textContent).toContain('prowlarr.example');
    // CORS : lastAddon a testé la source à la place du navigateur.
    expect(cards[2].querySelector('.src-name')!.textContent).toBe('Bloqué'); // nom choisi par l’utilisateur : conservé
    expect(cards[2].querySelector('.src-logo img')!.getAttribute('src')).toBe('https://x.example/l.png');
    expect(cards[2].querySelector('.src-sub')!.textContent).toContain('v3.0.0');
    expect(cards[2].querySelector('.src-dot')!.classList.contains('is-ok')).toBe(true);
    expect((posts[0].body as { config: { sources: Array<{ url: string }> } }).config.sources[0].url).toBe('https://blocked.example/manifest.json');
  });

  it('désactive une source (case et menu) sans la perdre', async () => {
    const { serializeSources } = await import('../src/ui/settings-sources.js');
    const cards = () => Array.from(document.querySelectorAll('#detail .src-card')) as HTMLElement[];
    expect(cards()[2].classList.contains('is-off')).toBe(true); // enabled:false du serveur
    const box = cards()[0].querySelector('[data-src-enabled]') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(cards()[0].classList.contains('is-off')).toBe(true);
    expect(serializeSources().map((s) => s.enabled)).toEqual([false, undefined, false]);
    // Menu « … » : Activer.
    (cards()[0].querySelector('[data-src-menu]') as HTMLElement).click();
    expect(cards()[0].querySelector('.ep-menu')!.hasAttribute('hidden')).toBe(false);
    (cards()[0].querySelector('[data-src-toggle]') as HTMLElement).click();
    expect(cards()[0].classList.contains('is-off')).toBe(false);
    expect(serializeSources()[0]).not.toHaveProperty('enabled');
  });

  it('réordonne par boutons et au clavier ; l’ordre est enregistré comme priorité', async () => {
    const { serializeSources } = await import('../src/ui/settings-sources.js');
    const cards = () => Array.from(document.querySelectorAll('#detail .src-card')) as HTMLElement[];
    (cards()[0].querySelector('[data-src-down]') as HTMLElement).click();
    expect(names()).toEqual(['Prowlarr', 'Mon Addon', 'Bloqué']);
    expect(cards().map((c) => c.querySelector('.src-pos')!.textContent)).toEqual(['1', '2', '3']);
    // Clavier sur la poignée.
    const handle = cards()[2].querySelector('[data-src-handle]') as HTMLElement;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(names()).toEqual(['Prowlarr', 'Bloqué', 'Mon Addon']);
    expect(document.getElementById('src-live')!.textContent).toMatch(/déplacée en position 2 sur 3/);
    const out = serializeSources();
    expect(out.map((s) => s.type)).toEqual(['torznab', 'upstream', 'upstream']);
    expect(out[0]).toMatchObject({ name: 'Prowlarr', apiKey: { set: true } }); // la clé masquée est conservée
    expect(out.every((s) => !('id' in s) && !('open' in s))).toBe(true);
  });

  it('modifier ouvre l’édition ; une nouvelle URL relit le manifest et préremplit le nom', async () => {
    const cards = () => Array.from(document.querySelectorAll('#detail .src-card')) as HTMLElement[];
    (document.querySelector('[data-set-addsrc="upstream"]') as HTMLElement).click();
    expect(cards()).toHaveLength(4);
    const fresh = cards()[3];
    expect(fresh.querySelector('.src-edit')!.hasAttribute('hidden')).toBe(false);
    const url = fresh.querySelector('[data-sf="url"]') as HTMLInputElement;
    url.value = 'stremio://nostream.example/manifest.json';
    url.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(200);
    expect(cards()[3].querySelector('.src-name')!.textContent).toBe('Catalogue seul');
    expect(cards()[3].querySelector('.src-dot')!.classList.contains('is-warn')).toBe(true); // pas de ressource « stream »
    // Retirer.
    (cards()[3].querySelector('[data-src-menu]') as HTMLElement).click();
    (cards()[3].querySelector('[data-src-remove]') as HTMLElement).click();
    expect(cards()).toHaveLength(3);
  });
});

describe('rendre mes addons sûrs', () => {
  const cards = () => Array.from(document.querySelectorAll('#detail .src-card')) as HTMLElement[];
  const addUpstream = (url: string) => {
    (document.querySelector('[data-set-addsrc="upstream"]') as HTMLElement).click();
    const input = cards()[cards().length - 1].querySelector('[data-sf="url"]') as HTMLInputElement;
    input.value = url;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const KEY = 'ABCDEFGH12345678';

  it('classe chaque addon (débride lui-même, torrents seulement), sans traiter une clé comme un problème', async () => {
    const before = cards().length; // 3 : aucune carte de test
    addUpstream('https://configurable.example/cfg123/manifest.json'); // sûr : infoHash
    addUpstream(`https://torrentio.example/alldebrid=${KEY}|sort=qualitysize/manifest.json`); // clé dans l’adresse
    addUpstream('https://opaque.example/3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab/manifest.json'); // config chez l’addon, débrideur
    await settle(300);
    expect(cards()).toHaveLength(before + 3);
    const [sure, keyed, opaque] = [cards()[3], cards()[4], cards()[5]];

    (document.querySelector('[data-set-safe]') as HTMLElement).click();
    await settle(400);
    // infoHash seul : aucune source lisible sans débrideur (avertissement).
    expect(sure.querySelector('.src-safety')!.classList.contains('is-torrents')).toBe(true);
    expect(sure.querySelector('.src-safety')!.textContent).toContain('Ne renvoie que des torrents : aucune source lisible sans débrideur');
    expect(sure.querySelector('[data-safe-config]')).not.toBeNull();
    // Clé dans l’adresse : l’addon débride lui-même, en vert, sans afficher la clé ni proposer de la retirer.
    expect(keyed.querySelector('.src-safety')!.classList.contains('is-self')).toBe(true);
    expect(keyed.querySelector('.src-safety')!.textContent).toContain('Débride lui-même (mode recommandé)');
    expect(keyed.querySelector('.src-safety')!.textContent).not.toContain(KEY);
    expect(keyed.querySelector('[data-safe-fix]')).toBeNull();
    expect(keyed.querySelector('[data-safe-config]')).toBeNull();
    expect(opaque.querySelector('.src-safety')!.classList.contains('is-self')).toBe(true);
    expect(opaque.querySelector('[data-safe-config]')).toBeNull();
    expect(document.getElementById('src-safe-sum')!.textContent).toContain('2 débride(nt) eux-mêmes');
    expect(document.getElementById('src-safe-sum')!.textContent).toContain('1 torrents seulement');

    // Configurer : ouvre la page de l’addon hors de l’app et affiche l’aide de collage.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    (sure.querySelector('[data-safe-config]') as HTMLElement).click();
    expect(open).toHaveBeenCalledWith('https://configurable.example/cfg123/configure', '_blank', 'noopener');
    expect((sure.querySelector('.src-cfg-help') as HTMLElement).hidden).toBe(false);
    open.mockRestore();

    // Nettoyage : retirer les trois cartes de test.
    for (let i = cards().length - 1; i >= before; i -= 1) {
      (cards()[i].querySelector('[data-src-menu]') as HTMLElement).click();
      (cards()[i].querySelector('[data-src-remove]') as HTMLElement).click();
    }
    expect(cards()).toHaveLength(before);
  });
});

describe('configuration de l’addon', () => {
  const cards = () => Array.from(document.querySelectorAll('#detail .src-card')) as HTMLElement[];
  const clip = { readText: vi.fn(async () => 'stremio://configurable.example/cfg456/manifest.json'), writeText: vi.fn(async () => undefined) };

  it('calcule la page /configure (préfixe de config et query gardés) et convertit stremio://', async () => {
    const { configureUrl, toHttpsUrl, manifestInfo } = await import('../src/ui/settings-sources.js');
    expect(configureUrl('https://addon.example/manifest.json')).toBe('https://addon.example/configure');
    expect(configureUrl('stremio://addon.example/eyJhIjoxfQ/manifest.json')).toBe('https://addon.example/eyJhIjoxfQ/configure');
    expect(configureUrl('https://addon.example/eyJhIjoxfQ/manifest.json?lang=fr')).toBe('https://addon.example/eyJhIjoxfQ/configure?lang=fr');
    expect(configureUrl('https://addon.example/x/')).toBe('https://addon.example/x/configure');
    expect(configureUrl('')).toBe('');
    expect(toHttpsUrl(' stremio://a.example/manifest.json ')).toBe('https://a.example/manifest.json');
    expect(toHttpsUrl('https://a.example/manifest.json')).toBe('https://a.example/manifest.json');
    expect(manifestInfo({ behaviorHints: { configurationRequired: true } }).configurable).toBe(true);
    expect(manifestInfo({ resources: ['stream'] }).configurable).toBe(false);
  });

  it('bouton « Configurer » seulement pour un manifest configurable', async () => {
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => c.querySelector('.src-cfg') === null)).toBe(true); // aucun addon configurable
    (document.querySelector('[data-set-addsrc="upstream"]') as HTMLElement).click();
    const url = cards()[3].querySelector('[data-sf="url"]') as HTMLInputElement;
    url.value = 'stremio://configurable.example/cfg123/manifest.json';
    url.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(200);
    expect(cards()[3].querySelector('.src-name')!.textContent).toBe('Addon configurable');
    expect(cards()[3].querySelector('.src-cfg')).not.toBeNull();
    expect(url.value).toBe('https://configurable.example/cfg123/manifest.json'); // stremio:// converti dans le champ
  });

  it('ouvre la configuration dans un nouvel onglet (web) et affiche l’aide ; le menu propose ouvrir et copier', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const card = cards()[3];
    (card.querySelector('.src-cfg') as HTMLElement).click();
    expect(open).toHaveBeenCalledWith('https://configurable.example/cfg123/configure', '_blank', 'noopener');
    expect((card.querySelector('.src-cfg-help') as HTMLElement).hidden).toBe(false);
    expect(card.querySelector('.src-cfg-steps')!.textContent).toContain('Configure l’addon dans la page ouverte');
    (card.querySelector('[data-src-menu]') as HTMLElement).click();
    expect(card.querySelector('[data-src-open-config]')).not.toBeNull();
    expect(card.querySelector('[data-src-copy]')).not.toBeNull();
    open.mockRestore();
  });

  it('« Coller » remplit le champ avec le lien d’installation, relit le manifest ; sans lien, le dit', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clip });
    const card = cards()[3];
    (card.querySelector('[data-src-paste]') as HTMLElement).click();
    await settle(200);
    const url = card.querySelector('[data-sf="url"]') as HTMLInputElement;
    expect(url.value).toBe('https://configurable.example/cfg456/manifest.json');
    expect(card.querySelector('.src-cfg-status')!.textContent).toContain('Addon lu');
    clip.readText.mockResolvedValueOnce('bonjour');
    (card.querySelector('[data-src-paste]') as HTMLElement).click();
    await settle(50);
    expect(url.value).toBe('https://configurable.example/cfg456/manifest.json');
    expect(card.querySelector('.src-cfg-status')!.textContent).toContain('Pas de lien');
  });

  it('« Copier l’URL » copie l’adresse du manifest ; retirer ramène à trois sources', async () => {
    const card = cards()[3];
    (card.querySelector('[data-src-menu]') as HTMLElement).click();
    (card.querySelector('[data-src-copy]') as HTMLElement).click();
    expect(clip.writeText).toHaveBeenCalledWith('https://configurable.example/cfg456/manifest.json');
    (cards()[3].querySelector('[data-src-menu]') as HTMLElement).click();
    (cards()[3].querySelector('[data-src-remove]') as HTMLElement).click();
    expect(cards()).toHaveLength(3);
  });
});
