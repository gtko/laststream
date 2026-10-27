// Fonctions pures de Réglages > Sources (adresses des addons) : aucun rendu, aucun timer.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Le module lit des éléments de la page au chargement (dom.js) : on pose le squelette de index.html (sans scripts), comme picker-badges.test.ts.
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { configureUrl, normalizeManifestUrl, toHttpsUrl } = await import('../src/ui/settings-sources.js');

describe('adresses des addons (fonctions pures)', () => {
  it('normalise les adresses (stremio://, sans manifest.json)', () => {
    expect(normalizeManifestUrl('stremio://addon.example/abc/manifest.json')).toBe('https://addon.example/abc/manifest.json');
    expect(normalizeManifestUrl('https://addon.example/abc/')).toBe('https://addon.example/abc/manifest.json');
    expect(normalizeManifestUrl('addon.example')).toBe('https://addon.example/manifest.json');
    expect(normalizeManifestUrl('')).toBe('');
  });

  it('calcule la page /configure (préfixe de config et query gardés) et convertit stremio://', () => {
    expect(configureUrl('https://addon.example/manifest.json')).toBe('https://addon.example/configure');
    expect(configureUrl('stremio://addon.example/eyJhIjoxfQ/manifest.json')).toBe('https://addon.example/eyJhIjoxfQ/configure');
    expect(configureUrl('https://addon.example/eyJhIjoxfQ/manifest.json?lang=fr')).toBe('https://addon.example/eyJhIjoxfQ/configure?lang=fr');
    expect(configureUrl('https://addon.example/x/')).toBe('https://addon.example/x/configure');
    expect(configureUrl('')).toBe('');
    expect(toHttpsUrl(' stremio://a.example/manifest.json ')).toBe('https://a.example/manifest.json');
    expect(toHttpsUrl('https://a.example/manifest.json')).toBe('https://a.example/manifest.json');
  });
});
