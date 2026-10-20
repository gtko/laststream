// Validateur d'images partagé (billets de parrainage, arrivée du foyer) : https seulement, hôtes d'images autorisés, serveur de l'app.
import { describe, expect, it } from 'vitest';
import { IMAGE_HOSTS, safeImageUrl } from '../src/data/imageUrl';

const SERVER = 'https://laststream.gtux-prog.workers.dev';

describe('safeImageUrl : adresses acceptées', () => {
  it('liste blanche : affiches TMDB et fonds fanart.tv', () => {
    expect(IMAGE_HOSTS).toEqual(['image.tmdb.org', 'assets.fanart.tv']);
  });

  it.each([
    'https://image.tmdb.org/t/p/w342/abc.jpg',
    'https://assets.fanart.tv/fanart/movies/550/background.jpg',
    'https://laststream.gtux-prog.workers.dev/img/x.png',
  ])('accepte %s', (u) => {
    expect(safeImageUrl(u, SERVER)).toBe(u);
  });

  it('l’origine du serveur de l’app est acceptée, pas une autre origine', () => {
    expect(safeImageUrl(SERVER + '/img/x.png', SERVER)).toBe(SERVER + '/img/x.png');
    expect(safeImageUrl('https://other.workers.dev/img/x.png', SERVER)).toBe('');
  });
});

describe('safeImageUrl : adresses refusées', () => {
  it.each([
    'http://image.tmdb.org/t/p/w342/abc.jpg',
    'https://evil.example/x.jpg',
    'https://image.tmdb.org.evil.example/x.jpg',
    'https://assets.fanart.tv.evil.example/x.jpg',
    'https://image.tmdb.org@evil.example/x.jpg',
    'https://image.tmdb.org:8443/x.jpg',
    'http://laststream.gtux-prog.workers.dev/img/x.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://image.tmdb.org/x.jpg" onerror="alert(1)',
    'https://image.tmdb.org/x.jpg\\',
    ' https://image.tmdb.org/x.jpg',
    '',
  ])('refuse %j', (u) => {
    expect(safeImageUrl(u, SERVER)).toBe('');
  });

  it('valeurs non textuelles refusées', () => {
    for (const v of [null, undefined, 42, {}, ['https://image.tmdb.org/a.jpg']]) {
      expect(safeImageUrl(v, SERVER)).toBe('');
    }
  });

  it('sans origine de serveur connue, seul l’hôte d’image passe', () => {
    expect(safeImageUrl(SERVER + '/img/x.png', '')).toBe('');
    expect(safeImageUrl('https://image.tmdb.org/t/p/w342/abc.jpg', '')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
  });
});
