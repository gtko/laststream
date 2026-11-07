import { describe, expect, it } from 'vitest';
import { slimTmdb, TMDB_MAX_BYTES } from '../src/lt/providers.js';

describe('saisons TMDB volumineuses', () => {
  it('retire équipe et invités des épisodes, garde le reste', () => {
    const season = { name: 'Saison 1', episodes: [{ episode_number: 1, name: 'Ryomen Sukuna', still_path: '/a.jpg', crew: [{ id: 1 }], guest_stars: [{ id: 2 }] }] };
    expect(slimTmdb(season)).toEqual({ name: 'Saison 1', episodes: [{ episode_number: 1, name: 'Ryomen Sukuna', still_path: '/a.jpg' }] });
  });

  it('laisse intactes les réponses sans épisodes', () => {
    const credits = { cast: [{ id: 1 }], crew: [{ id: 2 }] };
    expect(slimTmdb(credits)).toEqual({ cast: [{ id: 1 }], crew: [{ id: 2 }] });
    expect(slimTmdb(null)).toBeNull();
  });

  it('accepte les saisons de plusieurs Mo (anime de 47 épisodes)', () => {
    expect(TMDB_MAX_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  });
});
