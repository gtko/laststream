import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/index.js';
import { decodeCopiesToken } from '../src/play/token.js';
import { cand, cfg } from './engine-fixtures.js';

describe('runEngine : filtre, déduplication, classement, formatage', () => {
  it('enchaîne les étapes et tronque à maxResults', () => {
    const config = cfg({ maxResults: 2, resolutions: { allowed: ['1080p', '720p'] } });
    const streams = runEngine(
      [
        cand({ parsed: { resolution: '2160p', infoHash: 'a'.repeat(40) }, raw: { title: 'uhd' } }),
        cand({ parsed: { resolution: '720p', infoHash: 'b'.repeat(40), seeders: 5 }, raw: { title: 'hd-low' } }),
        cand({ parsed: { resolution: '720p', infoHash: 'b'.repeat(40), seeders: 50 }, raw: { title: 'hd-high' } }),
        cand({ parsed: { resolution: '1080p', infoHash: 'c'.repeat(40) }, raw: { title: 'fhd' } }),
        cand({ parsed: { resolution: '1080p', infoHash: 'd'.repeat(40) }, raw: { title: 'fhd-cached' }, cached: true }),
      ],
      config,
      { playBaseUrl: 'https://addon.example.com', configToken: 'TOKEN', secret: 'pipeline-test-secret', hasDebrid: true },
    );
    const hashes = streams.map((s) => decodeCopiesToken(decodeURIComponent(s.url?.split('/play/c/')[1] ?? ''), 'pipeline-test-secret')?.copies[0]?.infoHash);
    expect(hashes).toEqual(['d'.repeat(40), 'c'.repeat(40)]);
    expect(streams.every((s) => s.infoHash === undefined)).toBe(true);
  });
});
