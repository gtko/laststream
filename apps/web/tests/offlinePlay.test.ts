import { describe, expect, it } from 'vitest';
import { chooseEngine, localWebVerdict } from '../src/player/engine';
import { isOfflineView, offlineFailureView, offlineView } from '../src/player/offlinePlay';
import type { OfflineSource } from '../src/downloads/offline';

const edge = { formats: ['mp4', 'matroska,webm', 'webm'], videoCodecs: ['h264'], audioCodecs: ['aac'], maxAudioChannels: 2 };
const safari = { formats: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'], maxAudioChannels: 2 };
const base = { shell: false, serverUp: false, probe: null, notWebReady: false, name: 'film.mkv' };

const source: OfflineSource = { id: 'movie:1', platform: 'web', url: 'blob:x', filename: 'Film.mkv', container: 'mkv', quality: '1080p', size: 2_500_000_000, release: () => undefined };

describe('lecture hors ligne : moteur', () => {
  it('web : MP4 et WebM passent, MKV seulement sur Chromium, AVI jamais', () => {
    expect(localWebVerdict('mp4', safari)).toEqual({ ok: true });
    expect(localWebVerdict('webm', safari)).toEqual({ ok: true });
    expect(localWebVerdict('mkv', edge)).toEqual({ ok: true });
    expect(localWebVerdict('mkv', safari)).toMatchObject({ ok: false });
    expect(localWebVerdict('avi', edge)).toMatchObject({ ok: false });
    expect(localWebVerdict('', safari)).toEqual({ ok: true });
  });

  it('web : lecture directe locale, jamais par le serveur', () => {
    const c = chooseEngine({ ...base, caps: edge, local: { name: 'film.mkv', container: 'mkv' } });
    expect(c).toMatchObject({ engine: 'direct', viaServer: false, label: 'lecture hors ligne' });
    expect(c.unsupported).toBeUndefined();
  });

  it('web : même avec le serveur annoncé, un fichier local ne passe pas en HLS', () => {
    const c = chooseEngine({ ...base, serverUp: true, caps: safari, local: { name: 'film.mp4' }, notWebReady: true });
    expect(c).toMatchObject({ engine: 'direct', viaServer: false });
  });

  it('web : MKV sous Safari → message explicite', () => {
    const c = chooseEngine({ ...base, caps: safari, local: { name: 'film.mkv' } });
    expect(c.unsupported).toContain('MKV');
  });

  it('Android et Windows : libVLC et mpv lisent le fichier local', () => {
    expect(chooseEngine({ ...base, native: true, caps: safari, local: { name: 'a.mkv' } })).toMatchObject({ engine: 'native', viaServer: false });
    expect(chooseEngine({ ...base, shell: true, caps: safari, local: { name: 'a.mkv' } })).toMatchObject({ engine: 'mpv', viaServer: false });
  });
});

describe('lecture hors ligne : source du lecteur', () => {
  it('source synthétique sans lien ni réseau', () => {
    const v = offlineView(source);
    expect(isOfflineView(v)).toBe(true);
    expect(isOfflineView({})).toBe(false);
    expect(isOfflineView(null)).toBe(false);
    expect(v).toMatchObject({ index: -1, playable: true, client: false, quality: '1080p', filename: 'Film.mkv', sizeLabel: '2,5 Go', notWebReady: false });
    expect(JSON.stringify(v)).not.toContain('http');
  });
});

describe('lecture hors ligne : message d’échec', () => {
  it('web hors ligne, MKV : propose l’app, pas le streaming', () => {
    const v = offlineFailureView({ kind: 'container', reason: 'Ce navigateur ne lit pas les fichiers MKV.', platform: 'web', os: 'windows', online: false });
    expect(v.text).toContain('MKV');
    expect(v.text).toContain('app Windows');
    expect(v.text).toContain('Aucune connexion');
    expect(v.actions.map((a) => a.act)).toEqual(['app-download', 'close']);
  });

  it('web en ligne, HEVC : app Android + streaming', () => {
    const v = offlineFailureView({ kind: 'video', platform: 'web', os: 'android', online: true });
    expect(v.text).toContain('HEVC');
    expect(v.actions.map((a) => a.act)).toEqual(['app-download', 'stream', 'close']);
  });

  it('système sans app : conseil seulement, pas de bouton de téléchargement', () => {
    const v = offlineFailureView({ kind: 'video', platform: 'web', os: 'macos', online: true });
    expect(v.actions.map((a) => a.act)).toEqual(['stream', 'close']);
  });

  it('lecture bloquée : message mesuré, sans accuser le fichier', () => {
    const v = offlineFailureView({ kind: 'stalled', platform: 'web', os: 'windows', online: true });
    expect(v.text).toContain('bloquée');
    expect(v.text).not.toContain('Supprime-le puis');
    expect(v.actions.map((a) => a.act)).toEqual(['retry', 'stream', 'close']);
  });

  it('app native : message d’erreur du lecteur, jamais d’offre d’app', () => {
    const v = offlineFailureView({ kind: 'error', reason: 'open failed', platform: 'android', os: 'android', online: true });
    expect(v.text).toContain('open failed');
    expect(v.actions.map((a) => a.act)).toEqual(['stream', 'close']);
  });
});
