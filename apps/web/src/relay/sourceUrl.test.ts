// Lien relayé aux invités : seulement une source HTTP(S) que l'appareil de l'hôte lit directement (lien débridé ou lien direct
// d'addon). Jamais un torrent, un magnet, un proxy ou le serveur de streaming local.
import { describe, expect, it } from 'vitest';
import { relayableUrl } from './sourceUrl';

const DIRECT = 'https://gtko.github.io/laststream-test-addon/media/test-720p.mp4';
const DEBRID = 'https://dl1.alldebrid.com/f/abc/film.mkv?token=SECRET';

describe('relayableUrl', () => {
  it('lien direct d’addon (https ou http, lu tel quel) : relayé', () => {
    expect(relayableUrl(DIRECT, { url: DIRECT })).toBe(DIRECT);
    expect(relayableUrl('http://cdn.example.com/film.mp4', { url: 'http://cdn.example.com/film.mp4' })).toBe('http://cdn.example.com/film.mp4');
  });

  it('lien débridé (hébergeur autorisé), y compris pour une source torrent résolue par le débrideur : relayé', () => {
    expect(relayableUrl(DEBRID, null)).toBe(DEBRID);
    expect(relayableUrl(DEBRID, { infoHash: 'abcdef0123456789abcdef0123456789abcdef01', url: undefined })).toBe(DEBRID);
  });

  it('magnet ou torrent (infoHash) : jamais relayé, même avec une URL', () => {
    expect(relayableUrl('magnet:?xt=urn:btih:abcdef', { infoHash: 'abcdef' })).toBeNull();
    expect(relayableUrl(DIRECT, { infoHash: 'abcdef', url: DIRECT })).toBeNull();
  });

  it('serveur de streaming local ou proxy (adresse privée, lien différent du lien direct) : jamais relayé', () => {
    const local = 'http://127.0.0.1:11470/proxy/d=https%3A%2F%2Fgtko.github.io/film.mp4';
    expect(relayableUrl(local, { url: local })).toBeNull();
    expect(relayableUrl(local, { url: DIRECT })).toBeNull();
    expect(relayableUrl('http://192.168.1.20/film.mp4', { url: 'http://192.168.1.20/film.mp4' })).toBeNull();
    expect(relayableUrl(DIRECT, { url: 'https://gtko.github.io/autre.mp4' })).toBeNull();
  });

  it('pas de source connue, schéma non HTTP(S) ou valeur absente : rien', () => {
    expect(relayableUrl(DIRECT, null)).toBeNull();
    expect(relayableUrl(DIRECT, undefined)).toBeNull();
    expect(relayableUrl('ftp://example.com/film.mp4', { url: 'ftp://example.com/film.mp4' })).toBeNull();
    expect(relayableUrl('', { url: '' })).toBeNull();
    expect(relayableUrl(undefined, { url: DIRECT })).toBeNull();
  });
});
