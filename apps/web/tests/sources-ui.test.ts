// Réglages > Sources : cartes, manifest, ordre de priorité, activation.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const posts: Array<{ url: string; body: unknown }> = [];

function mockFetch(url: string, init?: RequestInit): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.hostname === 'addon.example') {
    return json({ name: 'Mon Addon', version: '2.1.0', description: 'Des sources en français', logo: 'https://addon.example/logo.png', types: ['movie', 'series'], resources: ['catalog', { name: 'stream' }] });
  }
  if (u.hostname === 'nostream.example') return json({ name: 'Catalogue seul', version: '1.0.0', resources: ['catalog'], types: ['movie'] });
  if (u.hostname === 'blocked.example') throw new TypeError('Failed to fetch'); // CORS
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
