import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPlayProbe, chooseEngine, detectCaps, guessWebPlayable } from '../src/player/engine';
import { failoverOrder, StallWatch } from '../src/player/failover';
import { keyToAction, SEEK_STEP, stepVolume } from '../src/player/keys';
import { bufferedEnd, formatClock, isWatched, nextEpisode, resumeDecision, shouldSave } from '../src/player/progress';
import { createTorrent, hlsMasterUrl, probeUrl, proxyUrl, setShellServerAddress, serverBase, subtitlesVttUrl, torrentUrl } from '../src/player/server';
import { loadfileArgs, mpvAudioTracks, mpvSubtitleTracks, mpvVersionAtLeast, isShellEnvironment } from '../src/player/shell';
import { activeSkip, chapterMarks, creditsStart, movieEndRow, nextEpisodeCard, normalizeSkip } from '../src/player/skip';
import { activeCue, cueHtml, normalizeSubStyle, offsetLabel, parseAss, parseCues, parseSubtitles, stepOffset } from '../src/player/subs';
import { normalizeExternal, mergeExternal, openSubtitlesUrl } from '../src/player/extsubs';
import { audioTrackLabel, normalizeLang, parseProbe, pickDefaultAudio, pickDefaultSubtitle, type AudioTrack, type SubtitleTrack } from '../src/player/tracks';
import { toSourceViews } from '../src/sources/info';

const caps = { formats: ['mp4', 'matroska,webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'opus'], maxAudioChannels: 2 };
const probe = (streams: Array<Record<string, unknown>>, format = 'mov,mp4,m4a,3gp,3g2,mj2') => ({ format: { name: format, duration: 7200 }, streams: streams as never });

describe('choix du moteur', () => {
  const base = { torrent: false, shell: false, serverUp: true, probe: null, caps, notWebReady: false, name: 'film.mp4' };

  it('mp4 h264/aac : lecture directe', () => {
    const p = probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 2 }]);
    expect(chooseEngine({ ...base, probe: p }).engine).toBe('direct');
  });

  it('HEVC, audio DTS, 6 canaux, deux pistes ou sous-titres embarqués : HLS via le serveur', () => {
    expect(canPlayProbe(probe([{ track: 'video', codec: 'hevc' }, { track: 'audio', codec: 'aac', channels: 2 }]), caps)).toBe(false);
    expect(canPlayProbe(probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'dts', channels: 6 }]), caps)).toBe(false);
    expect(canPlayProbe(probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 6 }]), caps)).toBe(false);
    expect(canPlayProbe(probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 2 }, { track: 'audio', codec: 'opus', channels: 2 }]), caps)).toBe(false);
    expect(canPlayProbe(probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 2 }, { track: 'subtitle', codec: 'subrip' }]), caps)).toBe(false);
    const c = chooseEngine({ ...base, probe: probe([{ track: 'video', codec: 'hevc' }, { track: 'audio', codec: 'aac', channels: 2 }]) });
    expect(c.engine).toBe('hls');
    expect(c.viaServer).toBe(true);
  });

  it('conteneur non pris en charge (avi) : HLS', () => {
    expect(canPlayProbe(probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 2 }], 'avi'), caps)).toBe(false);
  });

  it('sans probe : extension et indice de l’addon', () => {
    expect(guessWebPlayable('a.mp4?x=1', false)).toBe(true);
    expect(guessWebPlayable('a.mp4', true)).toBe(false);
    expect(guessWebPlayable('a.mkv', false)).toBe(false);
    expect(chooseEngine({ ...base, name: 'a.mkv' }).engine).toBe('hls');
    expect(chooseEngine({ ...base, name: 'a.mkv', serverUp: false }).engine).toBe('direct');
  });

  it('torrent : passe par le serveur, étiquette dédiée', () => {
    const c = chooseEngine({ ...base, torrent: true, name: 'x.mkv' });
    expect(c.engine).toBe('hls');
    expect(c.label).toContain('Torrent');
    expect(chooseEngine({ ...base, torrent: true, probe: probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 2 }]) }).viaServer).toBe(true);
  });

  it('coque Windows : mpv, quel que soit le fichier', () => {
    expect(chooseEngine({ ...base, shell: true, name: 'a.mkv', notWebReady: true }).engine).toBe('mpv');
  });

  it('transcodage forcé', () => {
    const p = probe([{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 2 }]);
    expect(chooseEngine({ ...base, probe: p, forceTranscoding: true }).engine).toBe('hls');
  });

  it('capacités du navigateur d’après canPlayType', () => {
    const c = detectCaps((m) => (/avc1|mp4a|vp9/.test(m) ? 'probably' : ''), { chromium: true, maxChannels: 2 });
    expect(c.videoCodecs).toEqual(['h264', 'vp9']);
    expect(c.audioCodecs).toEqual(['aac']);
    expect(c.formats).toContain('matroska,webm');
  });
});

describe('serveur de streaming : URL', () => {
  afterEach(() => { setShellServerAddress(''); localStorage.clear(); });

  it('adresse : réglage, puis coque, puis 127.0.0.1:11470', () => {
    expect(serverBase()).toBe('http://127.0.0.1:11470');
    setShellServerAddress('http://192.168.1.5:11470/');
    expect(serverBase()).toBe('http://192.168.1.5:11470');
    localStorage.setItem('laststream.streamingServer', 'http://nas:11470');
    expect(serverBase()).toBe('http://nas:11470');
  });

  it('probe, master HLS, sous-titres, torrent, proxy', () => {
    const b = 'http://127.0.0.1:11470';
    expect(probeUrl(b, 'http://x/a b.mkv')).toBe(b + '/hlsv2/probe?mediaURL=http%3A%2F%2Fx%2Fa+b.mkv');
    const u = new URL(hlsMasterUrl(b, 'abc', 'http://x/a.mkv', { videoCodecs: ['h264'], audioCodecs: ['aac', 'opus'], maxAudioChannels: 2 }));
    expect(u.pathname).toBe('/hlsv2/abc/master.m3u8');
    expect(u.searchParams.get('mediaURL')).toBe('http://x/a.mkv');
    expect(u.searchParams.getAll('audioCodecs')).toEqual(['aac', 'opus']);
    expect(u.searchParams.get('maxAudioChannels')).toBe('2');
    expect(subtitlesVttUrl(b, 'http://s/x.srt')).toBe(b + '/subtitles.vtt?from=http%3A%2F%2Fs%2Fx.srt');
    expect(torrentUrl(b, 'ABC', 3)).toBe(b + '/ABC/3');
    expect(torrentUrl(b, 'abc', null, ['udp://t:1'])).toBe(b + '/abc/-1?tr=udp%3A%2F%2Ft%3A1');
    expect(proxyUrl(b, 'https://h.example/v/a.mp4?t=1', { referer: 'r' })).toBe(b + '/proxy/d=https%3A%2F%2Fh.example&h=referer%3Ar/v/a.mp4?t=1');
  });

  it('torrent avec index connu et sans tracker : pas d’appel réseau', async () => {
    const t = await createTorrent({ infoHash: 'ABCDEF', fileIdx: 2 }, 'http://s');
    expect(t).toEqual({ url: 'http://s/abcdef/2', fileIdx: 2 });
  });

  it('torrent sans index : création côté serveur puis fichier deviné', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ guessedFileIdx: 4 }) }));
    vi.stubGlobal('fetch', f);
    const t = await createTorrent({ infoHash: 'abc', season: 1, episode: 2 }, 'http://s');
    expect(t.url).toBe('http://s/abc/4');
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://s/abc/create');
    expect(JSON.parse(call[1].body as string).guessFileIdx).toEqual({ season: 1, episode: 2 });
    vi.unstubAllGlobals();
  });
});

describe('pistes audio et sous-titres', () => {
  it('normalise les langues et les libelle', () => {
    expect(['fre', 'fra', 'fr-FR', 'French', 'FR'].map(normalizeLang)).toEqual(['fr', 'fr', 'fr', 'fr', 'fr']);
    expect(normalizeLang('eng')).toBe('en');
    expect(normalizeLang('und')).toBe('');
    expect(audioTrackLabel({ lang: 'fr', codec: 'eac3', channels: 6 })).toBe('Français · Dolby Digital+ 5.1');
    expect(audioTrackLabel({ lang: 'en', title: 'Commentary', codec: 'aac', channels: 2 })).toBe('Anglais (Commentary) · AAC Stéréo');
  });

  const tracks = parseProbe(probe([
    { id: 0, track: 'video', codec: 'h264', width: 1920, height: 1080 },
    { id: 1, track: 'audio', codec: 'eac3', channels: 6, lang: 'eng' },
    { id: 2, track: 'audio', codec: 'ac3', channels: 6, lang: 'fre' },
    { id: 3, track: 'audio', codec: 'aac', channels: 2, lang: 'fre' },
    { id: 4, track: 'subtitle', codec: 'subrip', lang: 'fre' },
    { id: 5, track: 'subtitle', codec: 'subrip', lang: 'fre', title: 'Forced' },
    { id: 6, track: 'subtitle', codec: 'hdmv_pgs_subtitle', lang: 'eng' },
  ]));

  it('lit le probe', () => {
    expect(tracks.audio).toHaveLength(3);
    expect(tracks.subtitles).toHaveLength(3);
    expect(tracks.subtitles[2].renderable).toBe(false);
    expect(tracks.subtitles[1].forced).toBe(true);
    expect(tracks.durationSec).toBe(7200);
    expect(tracks.height).toBe(1080);
  });

  it('audio par défaut : langue préférée, la plus riche en canaux', () => {
    expect(pickDefaultAudio(tracks.audio, ['fr'])).toBe(1);
    expect(pickDefaultAudio(tracks.audio, ['en'])).toBe(0);
    expect(pickDefaultAudio(tracks.audio, ['de'])).toBe(0);
    expect(pickDefaultAudio([] as AudioTrack[], ['fr'])).toBe(-1);
  });

  it('sous-titres par défaut selon le mode et la langue de l’audio', () => {
    // Audio français + mode auto : seulement les « forcés ».
    expect(pickDefaultSubtitle(tracks.subtitles, 'fr', 'fr', 'auto')).toBe(1);
    // Audio anglais : sous-titres français complets.
    expect(pickDefaultSubtitle(tracks.subtitles, 'fr', 'en', 'auto')).toBe(0);
    expect(pickDefaultSubtitle(tracks.subtitles, 'fr', 'fr', 'always')).toBe(0);
    expect(pickDefaultSubtitle(tracks.subtitles, 'fr', 'en', 'off')).toBe(-1);
    expect(pickDefaultSubtitle(tracks.subtitles, 'de', 'en', 'auto')).toBe(-1);
    // Les pistes image (PGS) ne sont jamais choisies.
    expect(pickDefaultSubtitle([tracks.subtitles[2]] as SubtitleTrack[], 'en', 'fr', 'auto')).toBe(-1);
  });
});

describe('sous-titres : lecture et affichage', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nBonjour <i>tout</i> le monde\n\n2\n00:00:05,000 --> 00:00:06,000\nDeuxième\nligne\n';

  it('SRT / WebVTT', () => {
    const cues = parseCues(srt);
    expect(cues).toEqual([{ start: 1, end: 3.5, text: 'Bonjour <i>tout</i> le monde' }, { start: 5, end: 6, text: 'Deuxième\nligne' }]);
    const vtt = parseCues('WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nHello\n');
    expect(vtt).toEqual([{ start: 1, end: 2, text: 'Hello' }]);
    expect(parseSubtitles(srt, 'x.srt')).toHaveLength(2);
  });

  it('ASS : texte nettoyé', () => {
    const ass = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Salut, toi\\Nça va{\\i0}\n';
    expect(parseAss(ass)).toEqual([{ start: 1, end: 2.5, text: 'Salut, toi\nça va' }]);
    expect(parseSubtitles(ass)).toHaveLength(1);
  });

  it('cue active avec décalage de synchronisation', () => {
    const cues = parseCues(srt);
    expect(activeCue(cues, 2)?.text).toContain('Bonjour');
    expect(activeCue(cues, 4)).toBeNull();
    expect(activeCue(cues, 5.5)?.text).toContain('Deuxième');
    // Sous-titres retardés de 2 s : la première cue apparaît à 3 s.
    expect(activeCue(cues, 2, 2)).toBeNull();
    expect(activeCue(cues, 3.5, 2)?.text).toContain('Bonjour');
    // Avancés de 1 s.
    expect(activeCue(cues, 0.5, -1)?.text).toContain('Bonjour');
  });

  it('HTML échappé : seules <i>, <b>, <u> survivent', () => {
    expect(cueHtml('a <i>b</i> <script>x</script>\nc')).toBe('a <i>b</i> x<br>c');
    expect(cueHtml('<b>1</b> & 2')).toBe('<b>1</b> &amp; 2');
  });

  it('décalage par pas de 0,1 s, borné, et réglages normalisés', () => {
    expect(stepOffset(0, 0.1)).toBe(0.1);
    expect(stepOffset(0.3, -0.5)).toBe(-0.2);
    expect(stepOffset(59.9, 0.5)).toBe(60);
    expect(offsetLabel(0.5)).toBe('+0,5 s');
    expect(offsetLabel(-1)).toBe('-1,0 s');
    expect(normalizeSubStyle({ size: 999, position: -3, background: 'box', color: 'yellow', mode: 'always' })).toEqual({ size: 200, position: 2, background: 'box', color: 'yellow', mode: 'always' });
    expect(normalizeSubStyle(null).mode).toBe('auto');
  });

  it('sous-titres externes : normalisation, fusion, OpenSubtitles', () => {
    const a = normalizeExternal({ subtitles: [{ id: '1', url: 'https://s/1.srt', lang: 'fre' }, { id: '2', url: 'ftp://bad', lang: 'fre' }, { url: 'https://s/2.srt', lang: 'eng' }] }, 'lastAddon');
    expect(a.map((t) => [t.lang, t.origin])).toEqual([['fr', 'external'], ['en', 'external']]);
    const b = normalizeExternal({ subtitles: [{ id: 'x', url: 'https://s/1.srt', lang: 'fre' }, { id: 'y', url: 'https://s/3.srt', lang: 'fre' }] }, 'OpenSubtitles');
    const merged = mergeExternal([a, b], 'fr');
    expect(merged.map((t) => t.url)).toEqual(['https://s/1.srt', 'https://s/3.srt', 'https://s/2.srt']);
    expect(merged[0].label).toBe('Français 1');
    expect(merged[1].label).toBe('Français 2');
    expect(openSubtitlesUrl({ type: 'series', id: 'tt1:1:2', hash: 'abc', size: 10 })).toBe('https://opensubtitles-v3.strem.io/subtitles/series/tt1%3A1%3A2/videoHash=abc&videoSize=10.json');
    expect(normalizeExternal(null, 'x')).toEqual([]);
  });
});

describe('segments de saut', () => {
  const segs = normalizeSkip({ segments: [
    { kind: 'credits', start: 2400, end: 2500, source: 'introdb' },
    { kind: 'intro', start: 60, end: 150, source: 'introdb' },
    { kind: 'recap', start: 2, end: 3, source: 'x' },
    { kind: 'nope', start: 1, end: 100 },
  ] });

  it('ignore les segments invalides et trie', () => {
    expect(segs.map((s) => s.kind)).toEqual(['intro', 'credits']);
    expect(normalizeSkip(null)).toEqual([]);
  });

  it('segment à proposer, repères de chapitres', () => {
    expect(activeSkip(segs, 59.9)?.kind).toBe('intro');
    expect(activeSkip(segs, 100)?.kind).toBe('intro');
    expect(activeSkip(segs, 149.5)).toBeNull();
    expect(activeSkip(segs, 200)).toBeNull();
    expect(chapterMarks(segs, 3000)[0]).toEqual({ kind: 'intro', from: 0.02, to: 0.05 });
  });

  it('carte épisode suivant dès le générique, compte à rebours selon le réglage', () => {
    expect(nextEpisodeCard(segs, 2000, 2600, true, true).show).toBe(false);
    expect(nextEpisodeCard(segs, 2400, 2600, true, true)).toEqual({ show: true, countdown: 10, ratio: 1 });
    expect(nextEpisodeCard(segs, 2406.5, 2600, true, true)).toEqual({ show: true, countdown: 4, ratio: 0.4 });
    expect(nextEpisodeCard(segs, 2420, 2600, true, true).countdown).toBe(0);
    expect(nextEpisodeCard(segs, 2410, 2600, true, false)).toEqual({ show: true, countdown: null, ratio: 0 });
    expect(nextEpisodeCard(segs, 2410, 2600, false, true).show).toBe(false);
    // Scène post-générique : la carte s'affiche mais le compte à rebours attend la fin de la scène.
    const withPost = [...segs, { kind: 'postcredits' as const, start: 2500, end: 2560 }];
    expect(nextEpisodeCard(withPost, 2450, 2600, true, true)).toEqual({ show: true, countdown: null, ratio: 0 });
    expect(nextEpisodeCard(withPost, 2562, 2600, true, true).countdown).toBe(8);
    expect(movieEndRow(segs, 2399, 2600)).toBe(false);
    expect(movieEndRow(segs, 2401, 2600)).toBe(true);
    expect(creditsStart([], 3000)).toBe(2955);
    expect(creditsStart([], 300)).toBeNull();
  });
});

describe('progression', () => {
  it('cadence d’enregistrement : toutes les 10 s, immédiat sur demande, jamais sans durée', () => {
    expect(shouldSave(10_000, 0, false, 100)).toBe(true);
    expect(shouldSave(9_999, 0, false, 100)).toBe(false);
    expect(shouldSave(1, 0, true, 100)).toBe(true);
    expect(shouldSave(99_999, 0, true, 0)).toBe(false);
  });

  it('vu à 90 %', () => {
    expect(isWatched(899, 1000)).toBe(false);
    expect(isWatched(900, 1000)).toBe(true);
    expect(isWatched(1, 0)).toBe(false);
  });

  it('reprise : proposée entre 2 % et 95 %, avec au moins 30 s', () => {
    expect(resumeDecision({ position: 1394, duration: 6000 })).toEqual({ prompt: true, position: 1394 });
    expect(resumeDecision({ position: 20, duration: 600 }).prompt).toBe(false);
    expect(resumeDecision({ position: 5900, duration: 6000 }).prompt).toBe(false);
    expect(resumeDecision({ position: 10, duration: 6000 }).prompt).toBe(false);
    expect(resumeDecision(null).prompt).toBe(false);
  });

  it('horloge, tampon et épisode suivant', () => {
    expect(formatClock(1394)).toBe('23:14');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(-4)).toBe('0:00');
    expect(bufferedEnd([[0, 10], [20, 40]], 25)).toBe(40);
    expect(bufferedEnd([[0, 10]], 50)).toBe(50);
    const seasons = [{ season: 0, count: 3 }, { season: 1, count: 2 }, { season: 2, count: 3 }];
    expect(nextEpisode(seasons, { season: 1, episode: 1 })).toEqual({ season: 1, episode: 2 });
    expect(nextEpisode(seasons, { season: 1, episode: 2 })).toEqual({ season: 2, episode: 1 });
    expect(nextEpisode(seasons, { season: 2, episode: 3 })).toBeNull();
  });
});

describe('failover', () => {
  const mk = (over: Record<string, unknown>) => ({ url: 'https://x/' + Math.random(), laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 5000, ...over } });
  const views = toSourceViews([
    mk({ score: 90 }), // 0 : en cours
    mk({ score: 80, languages: ['en'] }), // 1 : autre langue
    mk({ score: 70 }), // 2 : même copie
    mk({ score: 60, resolution: '720p' }), // 3 : même langue, autre qualité
  ] as never);

  it('copies équivalentes d’abord, puis même langue, puis le reste ; jamais une source déjà essayée', () => {
    expect(failoverOrder(views, views[0], new Set([0])).map((v) => v.index)).toEqual([2, 3, 1]);
    expect(failoverOrder(views, views[0], new Set([0, 2])).map((v) => v.index)).toEqual([3, 1]);
    expect(failoverOrder(views, views[0], new Set([0, 1, 2, 3]))).toEqual([]);
  });

  it('bloquée plus de 15 s en lecture : bascule ; en pause ou en recherche : jamais', () => {
    const w = new StallWatch(0);
    expect(w.tick(1000, 1, false)).toBe('ok');
    expect(w.tick(2000, 2, false)).toBe('ok');
    expect(w.tick(16_000, 2, false)).toBe('ok'); // 14 s sans progrès
    expect(w.tick(17_100, 2, false)).toBe('stalled');
    const p = new StallWatch(0);
    p.tick(1000, 5, false);
    expect(p.tick(60_000, 5, true)).toBe('ok');
    expect(p.tick(70_000, 5, false)).toBe('ok'); // la mesure repart après la pause
  });

  it('démarrage trop long', () => {
    const w = new StallWatch(0, 15_000, 45_000);
    expect(w.tick(40_000, 0, false)).toBe('ok');
    expect(w.tick(46_000, 0, false)).toBe('startup-timeout');
  });

  it('un retour en arrière (recherche) compte comme une progression', () => {
    const w = new StallWatch(0);
    w.tick(1000, 100, false);
    expect(w.tick(2000, 40, false)).toBe('ok');
    expect(w.tick(10_000, 45, false)).toBe('ok');
  });
});

describe('clavier', () => {
  const ctx = { panelOpen: false, typing: false, onButton: false };

  it('raccourcis du lecteur', () => {
    expect(keyToAction(' ', ctx)).toEqual({ type: 'toggle-play' });
    expect(keyToAction('ArrowLeft', ctx)).toEqual({ type: 'seek', by: -SEEK_STEP });
    expect(keyToAction('ArrowRight', ctx, { shift: true })).toEqual({ type: 'seek', by: 3 * SEEK_STEP });
    expect(keyToAction('ArrowUp', ctx)).toEqual({ type: 'volume', by: 0.05 });
    expect(keyToAction('ArrowDown', ctx)).toEqual({ type: 'volume', by: -0.05 });
    expect(keyToAction('f', ctx)).toEqual({ type: 'fullscreen' });
    expect(keyToAction('M', ctx)).toEqual({ type: 'mute' });
    expect(keyToAction('s', ctx)).toEqual({ type: 'skip' });
    expect(keyToAction('p', ctx)).toEqual({ type: 'pip' });
    expect(keyToAction('c', ctx)).toEqual({ type: 'panel', name: 'subtitles' });
    expect(keyToAction('a', ctx)).toEqual({ type: 'panel', name: 'audio' });
    expect(keyToAction('n', ctx)).toEqual({ type: 'next' });
    expect(keyToAction('Escape', ctx)).toEqual({ type: 'back' });
    expect(keyToAction('x', ctx)).toBeNull();
  });

  it('les combinaisons du navigateur et les champs de saisie ne sont pas détournés', () => {
    expect(keyToAction('f', ctx, { ctrl: true })).toBeNull();
    expect(keyToAction('f', { ...ctx, typing: true })).toBeNull();
    expect(keyToAction('Escape', { ...ctx, typing: true })).toEqual({ type: 'back' });
    expect(keyToAction(' ', { ...ctx, onButton: true })).toBeNull(); // Espace active le bouton ciblé
  });

  it('panneau ouvert : les flèches le parcourent', () => {
    const open = { ...ctx, panelOpen: true };
    expect(keyToAction('ArrowDown', open)).toEqual({ type: 'nav', dir: 'down' });
    expect(keyToAction('ArrowUp', open)).toEqual({ type: 'nav', dir: 'up' });
    expect(keyToAction('Escape', open)).toEqual({ type: 'back' });
    expect(keyToAction('f', open)).toEqual({ type: 'fullscreen' });
  });

  it('volume borné par pas de 5 %', () => {
    expect(stepVolume(0.98, 0.05)).toBe(1);
    expect(stepVolume(0.02, -0.05)).toBe(0);
    expect(stepVolume(0.5, 0.05)).toBe(0.55);
  });
});

describe('coque Windows (mpv)', () => {
  it('détection du transport Qt', () => {
    expect(isShellEnvironment({})).toBe(false);
    expect(isShellEnvironment({ qt: { webChannelTransport: {} } })).toBe(true);
  });

  it('pistes mpv converties', () => {
    const list = [
      { id: 1, type: 'video' },
      { id: 1, type: 'audio', lang: 'fre', codec: 'eac3', 'audio-channels': 6, selected: true },
      { id: 2, type: 'audio', lang: 'eng', codec: 'aac', 'audio-channels': 2 },
      { id: 3, type: 'sub', lang: 'fre', codec: 'subrip', selected: true },
    ];
    const audio = mpvAudioTracks(list);
    expect(audio.map((t) => [t.id, t.lang, t.selected])).toEqual([['1', 'fr', true], ['2', 'en', false]]);
    expect(audio[0].label).toBe('Français · Dolby Digital+ 5.1');
    expect(mpvSubtitleTracks(list)[0]).toMatchObject({ id: '3', lang: 'fr', selected: true });
  });

  it('syntaxe de loadfile selon la version de mpv', () => {
    expect(mpvVersionAtLeast('0.39.0', '0.39')).toBe(true);
    expect(mpvVersionAtLeast('0.38.0', '0.39')).toBe(false);
    expect(mpvVersionAtLeast('mpv 1.0', '0.39')).toBe(true);
    expect(loadfileArgs('u', 0, true)).toEqual(['u']);
    expect(loadfileArgs('u', 30, true)).toEqual(['u', 'replace', '-1', 'start=+30']);
    expect(loadfileArgs('u', 30, false)).toEqual(['u', 'replace', 'start=+30']);
  });
});
