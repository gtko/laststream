import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markTrailerFailed } from '../src/data/trailerHealth';

let trailerFields: (videos: unknown[]) => { trailer: string; trailerVO: boolean; trailers: Array<{ key: string }> };

beforeAll(async () => {
  // Squelette réel : catalog.js lit le DOM à l'import.
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  trailerFields = (await import('../src/ui/catalog.js')).trailerFields;
});

const yt = (key: string, name: string) => ({ key, site: 'YouTube', type: 'Trailer', name, iso_639_1: 'en' });

describe('trailerFields : repli des bandes-annonces', () => {
  beforeEach(() => localStorage.clear());

  it('garde toutes les candidates dans l\'ordre, la première devient trailer', () => {
    const f = trailerFields([yt('a', 'Official Trailer'), yt('b', 'Trailer 2')]);
    expect(f.trailers.length).toBe(2);
    expect(f.trailer).toBe(f.trailers[0].key);
  });

  it('écarte les vidéos mémorisées en échec', () => {
    const first = trailerFields([yt('a', 'Official Trailer'), yt('b', 'Trailer 2')]).trailer;
    markTrailerFailed(first);
    const f = trailerFields([yt('a', 'Official Trailer'), yt('b', 'Trailer 2')]);
    expect(f.trailers.map((t) => t.key)).not.toContain(first);
    expect(f.trailer).not.toBe(first);
    expect(f.trailer).not.toBe('');
  });

  it('plus aucune candidate lisible : trailer vide', () => {
    markTrailerFailed('a');
    markTrailerFailed('b');
    const f = trailerFields([yt('a', 'Official Trailer'), yt('b', 'Trailer 2')]);
    expect(f.trailer).toBe('');
    expect(f.trailers).toEqual([]);
  });
});
