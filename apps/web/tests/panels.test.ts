import { afterEach, describe, expect, it } from 'vitest';
import { filterEpisodes, firstUnseen, isAired, normalizeCanonical } from '../src/player/episodes';
import { mergeExternal, normalizeExternal, releaseSimilarity } from '../src/player/extsubs';
import { fileKey, getSubSync, setSubSync } from '../src/player/memory';
import { parseProbe, type AudioTrack, type SubtitleTrack } from '../src/player/tracks';
import { audioDetail, channelLayout, groupAudioTracks, sectionSubtitleTracks, subtitleLabel, variantOf } from '../src/player/trackgroups';
import { activeCue, parseCues } from '../src/player/subs';
import { fileTimeToPlayback, findSync, RATE_CHOICES, speechGrid, subtitleTime, suggestRate, syncTrusted, videoTimeOfCue, type LevelSample } from '../src/player/subsync';
import { clearSourceCache, loadSources, requestKey } from '../src/sources/load';

const audio = (id: string, lang: string, extra: Partial<AudioTrack> = {}): AudioTrack => ({ id, lang, label: lang, codec: 'aac', channels: 2, selected: false, ...extra });

describe('pistes audio : regroupement et libellés', () => {
  it('langue préférée d’abord, variantes VFF/VFQ/VO, détail codec et canaux', () => {
    const tracks = [
      audio('a0', 'ja', { codec: 'aac', channels: 2 }),
      audio('a1', 'fr', { codec: 'eac3', channels: 6 }),
      audio('a2', 'fr', { codec: 'ac3', channels: 6 }),
      audio('a3', 'en', { codec: 'truehd', channels: 8 }),
    ];
    const titles = { a0: 'Japanese VO', a1: 'Français VFF', a2: 'VFQ', a3: 'English TrueHD Atmos' };
    const groups = groupAudioTracks(tracks, ['fr'], titles);
    expect(groups.map((g) => g.lang)).toEqual(['fr', 'ja', 'en']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Français (VFF)', 'Français (VFQ)']);
    expect(groups[0].items.map((i) => i.detail)).toEqual(['E-AC3 5.1', 'AC3 5.1']);
    expect(groups[1].items[0].label).toBe('Japonais (VO)');
    expect(groups[2].items[0].detail).toBe('TrueHD Atmos 7.1');
  });

  it('pastilles : Par défaut, Commentaire, Audiodescription', () => {
    const tracks = [audio('a0', 'fr'), audio('a1', 'fr'), audio('a2', 'fr')];
    const groups = groupAudioTracks(tracks, ['fr'], { a0: 'Français', a1: 'Français commentaire du réalisateur', a2: 'Français audiodescription' });
    expect(groups[0].items.map((i) => i.badges)).toEqual([['Par défaut'], ['Commentaire'], ['Audiodescription']]);
  });

  it('langue inconnue en dernier ; helpers', () => {
    const groups = groupAudioTracks([audio('a0', ''), audio('a1', 'en')], ['fr', 'en']);
    expect(groups.map((g) => g.name)).toEqual(['Anglais', 'Langue inconnue']);
    expect(variantOf('Francais VFQ 5.1')).toBe('VFQ');
    expect(variantOf('Piste 2')).toBe('');
    expect(channelLayout(6)).toBe('5.1');
    expect(audioDetail({ codec: 'aac', channels: 2 })).toBe('AAC 2.0');
  });

  it('probe : titres et langues déduits des balises', () => {
    const t = parseProbe({ streams: [{ id: 0, track: 'audio', codec: 'aac', language: 'fre', title: 'Français VFF', channels: 2 }] });
    expect(t.audio[0].title).toBe('Français VFF');
    expect(t.audio[0].lang).toBe('fr');
  });
});

describe('sous-titres : sections et libellés', () => {
  const base = { codec: 'subrip', renderable: true, selected: false, forced: false };
  const tracks: SubtitleTrack[] = [
    { ...base, id: 's0', lang: 'en', label: 'Anglais', origin: 'embedded' },
    { ...base, id: 's1', lang: 'fr', label: 'Français', origin: 'embedded', forced: true },
    { ...base, id: 's2', lang: 'fr', label: 'Français', origin: 'embedded' },
    { ...base, id: 's3', lang: 'fr', label: 'Français', origin: 'external', codec: '', source: 'OpenSubtitles', hashMatch: true, downloads: 12400 },
    { ...base, id: 's4', lang: 'fr', label: 'Français', origin: 'embedded', codec: 'hdmv_pgs_subtitle', renderable: false },
  ];

  it('intégrés puis externes, langue préférée d’abord, libellés forcés / SDH', () => {
    const sections = sectionSubtitleTracks(tracks, ['fr'], { s2: 'Français SDH' });
    expect(sections.map((s) => s.id)).toEqual(['embedded', 'external']);
    expect(sections[0].groups.map((g) => g.lang)).toEqual(['fr', 'en']);
    expect(sections[0].groups[0].items.map((i) => i.label)).toEqual(['Français — forcés', 'Français — SDH/malentendants', 'Français']);
    expect(sections[0].groups[0].items[2].unsupported).toContain('PGS');
    const ext = sections[1].groups[0].items[0];
    expect(ext.chips).toEqual(expect.arrayContaining(['OpenSubtitles', 'Synchronisé avec ce fichier', '12,4 k téléch.']));
    expect(subtitleLabel(tracks[0])).toBe('Anglais');
  });
});

describe('sous-titres externes : empreinte et release', () => {
  it('ressemblance entre noms de release', () => {
    const f = 'Show.S01E03.1080p.WEB-DL.x264-GRP.mkv';
    expect(releaseSimilarity(f, 'Show.S01E03.1080p.WEB-DL.x264-GRP.srt')).toBe(1);
    expect(releaseSimilarity(f, 'Show.S01E03.720p.HDTV.xvid-LOL.srt')).toBeLessThan(0.5);
    expect(releaseSimilarity(f, '')).toBe(0);
  });

  it('empreinte d’abord, puis release la plus proche', () => {
    const resp = { subtitles: [
      { id: '1', url: 'https://s/a.srt', lang: 'fre', release: 'Show.S01E03.720p.HDTV.xvid-LOL' },
      { id: '2', url: 'https://s/b.srt', lang: 'fre', release: 'Show.S01E03.1080p.WEB-DL.x264-GRP' },
      { id: '3', url: 'https://s/c.srt', lang: 'fre', moviehash_match: true, release: 'Autre' },
      { id: '4', url: 'https://s/d.srt', lang: 'eng' },
    ] };
    const merged = mergeExternal([normalizeExternal(resp, 'OpenSubtitles')], 'fr', 4, 'Show.S01E03.1080p.WEB-DL.x264-GRP.mkv');
    expect(merged.map((t) => t.url)).toEqual(['https://s/c.srt', 'https://s/b.srt', 'https://s/a.srt', 'https://s/d.srt']);
    expect(merged[0].hashMatch).toBe(true);
  });
});

describe('calage des sous-titres : temps et vitesse', () => {
  it('heures vidéo ↔ sous-titres avec décalage et rapport de vitesse', () => {
    expect(subtitleTime(12, 2, 1)).toBe(10);
    expect(videoTimeOfCue(10, 2, 1)).toBe(12);
    expect(subtitleTime(25, 0, 25 / (24000 / 1001))).toBeCloseTo(23.976, 2);
    expect(videoTimeOfCue(23.976, 0, 25 / (24000 / 1001))).toBeCloseTo(25, 2);
    // Aller-retour.
    expect(videoTimeOfCue(subtitleTime(300, -1.5, 1.0427), -1.5, 1.0427)).toBeCloseTo(300, 6);
  });

  it('fichier dont le premier paquet est à 10 s : les heures du fichier sont ramenées à la lecture', () => {
    expect(fileTimeToPlayback(11, 10)).toBe(1);
    const cues = parseCues('1\n00:00:11,000 --> 00:00:13,000\nBonjour\n');
    expect(activeCue(cues, 1.5, -10)?.text).toBe('Bonjour'); // décalage de -10 s = origine du fichier
    expect(activeCue(cues, 1.5)).toBeNull();
  });

  it('cue active avec vitesse corrigée', () => {
    const cues = parseCues('1\n00:10:00,000 --> 00:10:02,000\nA\n');
    const r = RATE_CHOICES[1].ratio; // 25 → 23,976
    expect(activeCue(cues, 600 * r + 1, 0, r)?.text).toBe('A');
    expect(activeCue(cues, 601, 0, r)).toBeNull();
  });

  it('suggestion de vitesse d’après la fin des sous-titres', () => {
    expect(suggestRate(5000, 5000).id).toBe('none');
    expect(suggestRate(5050, 5000).id).toBe('none'); // 1 % d’écart : tolérance
    expect(suggestRate(5200, 5000).id).toBe('pal-up'); // sous-titres 4 % trop longs : à comprimer
    expect(suggestRate(9000, 5000).id).toBe('none'); // aucune correction plausible
    expect(suggestRate(0, 5000).id).toBe('none');
  });

  it('mémoire par fichier et par piste', () => {
    localStorage.clear();
    const k = fileKey('Show.S01E03.mkv', 1_500_000_000);
    expect(getSubSync(k, 'u1')).toBeNull();
    setSubSync(k, 'u1', { offset: 2.5, rate: 1 });
    setSubSync(k, 'u2', { offset: -1, rate: 1.0427 });
    expect(getSubSync(k, 'u1')).toEqual({ offset: 2.5, rate: 1 });
    expect(getSubSync(k, 'u2')).toEqual({ offset: -1, rate: 1.0427 });
    expect(getSubSync(fileKey('Show.S01E03.mkv', 1_400_000_000), 'u1')).toBeNull(); // autre release : autre taille
    setSubSync(k, 'u1', { offset: 0, rate: 1 }); // réinitialisation : l'entrée disparaît
    expect(getSubSync(k, 'u1')).toBeNull();
  });
});

describe('synchronisation automatique par la parole', () => {
  // Dialogues synthétiques : 40 cues de 2 à 4 s, séparées de 3 à 7 s.
  const makeCues = () => {
    const cues: Array<{ start: number; end: number }> = [];
    let t = 5;
    for (let i = 0; i < 40; i++) {
      const len = 2 + ((i * 7) % 3);
      cues.push({ start: t, end: t + len });
      t += len + 3 + ((i * 5) % 5);
    }
    return cues;
  };
  const speech = (cues: Array<{ start: number; end: number }>, offset: number, rate: number, until: number): LevelSample[] => {
    const out: LevelSample[] = [];
    for (let t = 0; t < until; t += 0.1) {
      const st = (t - offset) / rate;
      const talking = cues.some((c) => st >= c.start && st < c.end);
      out.push({ t, v: (talking ? 0.2 : 0.01) + ((Math.round(t * 1000) * 7) % 5) / 500 });
    }
    return out;
  };

  it('retrouve un décalage connu', () => {
    const cues = makeCues();
    for (const off of [2.5, -3.2, 0]) {
      const r = findSync(speech(cues, off, 1, 150), cues, { maxShift: 10 });
      expect(r).not.toBeNull();
      expect(Math.abs(r!.offset - off)).toBeLessThanOrEqual(0.2);
      expect(syncTrusted(r)).toBe(true);
    }
  });

  it('retrouve une dérive PAL', () => {
    const cues = makeCues();
    const pal = RATE_CHOICES[1].ratio;
    const r = findSync(speech(cues, 1, pal, 150), cues, { maxShift: 5, rates: [1, pal, RATE_CHOICES[2].ratio] });
    expect(r!.rate).toBeCloseTo(pal, 4);
    expect(Math.abs(r!.offset - 1)).toBeLessThanOrEqual(0.3);
  });

  it('bruit sans parole structurée : résultat non fiable ; trop peu de mesures : rien', () => {
    const cues = makeCues();
    const noise: LevelSample[] = [];
    for (let t = 0; t < 150; t += 0.1) noise.push({ t, v: 0.05 + (((Math.round(t * 10) * 2654435761) >>> 0) % 100) / 5000 });
    expect(syncTrusted(findSync(noise, cues, { maxShift: 10 }))).toBe(false);
    expect(findSync(noise.slice(0, 50), cues)).toBeNull();
    expect(findSync([], cues)).toBeNull();
  });

  it('grille de parole : seuil adaptatif', () => {
    const g = speechGrid([{ t: 0, v: 0.01 }, { t: 0.1, v: 0.3 }, { t: 0.2, v: 0.01 }, { t: 0.3, v: 0.3 }], 0.1);
    expect(Array.from(g.active)).toEqual([0, 1, 0, 1]);
  });
});

describe('épisodes du lecteur', () => {
  const canonical = { source: 'tvdb', seasons: [], episodes: [
    { season: 0, episode: 1, name: 'Spécial' },
    { season: 1, episode: 2, name: 'Le départ', overview: 'Un voyage commence.', airDate: '2020-02-01', runtime: 24, still: 'https://i/2.jpg' },
    { season: 1, episode: 1, name: 'Pilote', airDate: '2020-01-01' },
    { season: 2, episode: 1, name: 'Retour', airDate: '2999-01-01' },
  ] };

  it('réponse canonique : saisons, épisodes triés, diffusés / à venir', () => {
    const c = normalizeCanonical(canonical, '2024-06-01')!;
    expect(c.seasons).toEqual([{ season: 1, count: 2 }, { season: 2, count: 1 }]);
    expect(c.episodes.get(1)!.map((e) => e.episode)).toEqual([1, 2]);
    expect(c.episodes.get(2)![0].aired).toBe(false);
    expect(c.episodes.get(1)![1]).toMatchObject({ name: 'Le départ', runtime: 24, still: 'https://i/2.jpg', aired: true });
    expect(normalizeCanonical({ episodes: [] })).toBeNull();
    expect(normalizeCanonical(null)).toBeNull();
    expect(isAired('', '2024-01-01')).toBe(true);
  });

  it('recherche par numéro ou par titre, sans accents', () => {
    const list = normalizeCanonical(canonical, '2024-06-01')!.episodes.get(1)!;
    expect(filterEpisodes(list, 'depart').map((e) => e.episode)).toEqual([2]);
    expect(filterEpisodes(list, 'é1').map((e) => e.episode)).toEqual([1]);
    expect(filterEpisodes(list, 'e1').map((e) => e.episode)).toEqual([1]);
    expect(filterEpisodes(list, '2').map((e) => e.episode)).toEqual([2]);
    expect(filterEpisodes(list, 'voyage').map((e) => e.episode)).toEqual([2]);
    expect(filterEpisodes(list, '').length).toBe(2);
  });

  it('prochain épisode non vu, en sautant les épisodes à venir', () => {
    const c = normalizeCanonical(canonical, '2024-06-01')!;
    expect(firstUnseen(c.seasons, c.episodes, 1, () => false)).toEqual({ season: 1, episode: 1 });
    expect(firstUnseen(c.seasons, c.episodes, 1, (s, e) => s === 1 && e === 1)).toEqual({ season: 1, episode: 2 });
    expect(firstUnseen(c.seasons, c.episodes, 1, (s) => s === 1)).toBeNull(); // la saison 2 n'est pas encore diffusée
  });
});

describe('recherche de sources : cache et préchargement', () => {
  afterEach(() => clearSourceCache());

  it('clé de demande par titre et épisode', () => {
    expect(requestKey({ type: 'tv', id: '1', season: 2, episode: 3 })).toBe('tv:1:2:3');
    expect(requestKey({ type: 'movie', id: '5' })).toBe('movie:5::');
  });

  it('une recherche en cours ou récente est partagée (le survol sert à l’ouverture)', () => {
    const req = { type: 'movie' as const, id: '1', name: 'x', key: 'movie:1', imdb: 'tt1' };
    const a = loadSources(req, 1000);
    const b = loadSources(req, 50_000);
    expect(b).toBe(a);
    a.catch(() => undefined);
    const c = loadSources(req, 200_000);
    c.catch(() => undefined);
    expect(c).not.toBe(a); // périmée après 90 s
  });
});
