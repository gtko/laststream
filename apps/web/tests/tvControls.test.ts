// Commandes du lecteur TV (logique pure) : masquage automatique, raccourcis, badge DIRECT, options de pistes et de
// qualité (hls.js, balise vidéo, mpv, plugin natif simulés), codecs et contenu du panneau « Infos ».
import { describe, expect, it } from 'vitest';
import {
  IdleUi, NONE, UI_IDLE_MS, audioCodecLabel, hlsAudioOptions, hlsLevelOptions, hlsSubtitleOptions, hlsTech, htmlAudioOptions,
  htmlTextOptions, infoModel, liveBadge, techFromTracks, trackOptions, tvKeyAction, videoCodecLabel,
} from '../src/ui/tvControls.js';
import { mpvAudioTracks, mpvSubtitleTracks } from '../src/player/shell';

type Opt = { id: string; label: string; selected: boolean };

describe('masquage automatique de l’interface', () => {
  it('reste visible 3 s après la dernière activité, puis se masque', () => {
    expect(UI_IDLE_MS).toBe(3000);
    const ui = new IdleUi();
    expect(ui.visible(0)).toBe(false); // avant toute activité
    ui.wake(1000);
    expect(ui.visible(1000)).toBe(true);
    expect(ui.visible(1000 + UI_IDLE_MS - 1)).toBe(true);
    expect(ui.visible(1000 + UI_IDLE_MS)).toBe(false);
  });

  it('une nouvelle activité repousse le délai à partir de cet instant', () => {
    const ui = new IdleUi().wake(1000);
    ui.wake(3000);
    expect(ui.visible(5999)).toBe(true);
    expect(ui.visible(6000)).toBe(false);
  });

  it('verrouillée (panneau ouvert, pause, échec) : toujours visible, sans échéance à programmer', () => {
    const ui = new IdleUi().wake(0).lock(true);
    expect(ui.visible(1_000_000)).toBe(true);
    expect(ui.deadline()).toBeNull();
    ui.lock(false);
    expect(ui.visible(1_000_000)).toBe(false);
    expect(ui.deadline()).toBe(UI_IDLE_MS);
  });
});

describe('raccourcis du lecteur', () => {
  it('M muet, F plein écran, I infos, Espace pause, flèches haut et bas chaîne précédente et suivante', () => {
    expect(tvKeyAction('m')).toBe('mute');
    expect(tvKeyAction('M')).toBe('mute');
    expect(tvKeyAction('f')).toBe('fullscreen');
    expect(tvKeyAction('F')).toBe('fullscreen');
    expect(tvKeyAction('i')).toBe('info');
    expect(tvKeyAction('I')).toBe('info');
    expect(tvKeyAction(' ')).toBe('toggle');
    expect(tvKeyAction('ArrowUp')).toBe('prev');
    expect(tvKeyAction('PageUp')).toBe('prev');
    expect(tvKeyAction('ArrowDown')).toBe('next');
    expect(tvKeyAction('ChannelDown')).toBe('next');
  });

  it('Échap et Retour arrière demandent la fermeture, décidée ensuite par le lecteur (panneau, infos, plein écran)', () => {
    expect(tvKeyAction('Escape')).toBe('escape');
    expect(tvKeyAction('Backspace')).toBe('escape');
  });

  it('flèches gauche et droite, Tab et autres touches restent à la navigation', () => {
    expect(tvKeyAction('ArrowLeft')).toBeNull();
    expect(tvKeyAction('ArrowRight')).toBeNull();
    expect(tvKeyAction('Tab')).toBeNull();
    expect(tvKeyAction('x')).toBeNull();
  });
});

describe('badge DIRECT', () => {
  it('ne s’affiche que lorsque la lecture est OK', () => {
    expect(liveBadge({ phase: 'live' })).toBe(true);
    expect(liveBadge({ phase: 'connecting' })).toBe(false);
    expect(liveBadge({ phase: 'audio' })).toBe(false);
    expect(liveBadge({ phase: 'failed' })).toBe(false);
    expect(liveBadge({ phase: 'idle' })).toBe(false);
    expect(liveBadge(undefined)).toBe(false);
  });

  it('pas pendant une pause : ce n’est plus du direct', () => {
    expect(liveBadge({ phase: 'live' }, true)).toBe(false);
    expect(liveBadge({ phase: 'live' }, false)).toBe(true);
  });
});

describe('pistes et qualités hls.js (simulé)', () => {
  const hls = {
    audioTracks: [{ id: 0, name: 'Français VFF', lang: 'fr' }, { id: 1, name: 'English', lang: 'en' }],
    audioTrack: 1,
    subtitleTracks: [{ name: '', lang: 'fr' }],
    subtitleTrack: 0,
    subtitleDisplay: true,
    levels: [
      { height: 720, bitrate: 3000000 }, { height: 1080, bitrate: 5000000 },
      { height: 720, bitrate: 2500000 }, { height: 360, bitrate: 800000 },
    ],
    currentLevel: 1,
    autoLevelEnabled: false,
  };

  it('pistes audio : index courant sélectionné, libellé à partir du titre du fichier', () => {
    const opts = hlsAudioOptions(hls);
    expect(opts.map((o: Opt) => o.id)).toEqual(['0', '1']);
    expect(opts.map((o: Opt) => o.selected)).toEqual([false, true]);
    expect(opts[0].label).toContain('Français VFF');
  });

  it('sous-titres : « Désactivés » en tête ; aucune piste → aucune option ; affichage coupé → rien de sélectionné', () => {
    expect(hlsSubtitleOptions(hls).map((o) => [o.id, o.selected])).toEqual([[NONE, false], ['0', true]]);
    expect(hlsSubtitleOptions({ subtitleTracks: [] })).toEqual([]);
    expect(hlsSubtitleOptions({ ...hls, subtitleDisplay: false }).map((o) => o.selected)).toEqual([true, false]);
  });

  it('qualités : Auto puis une entrée par hauteur, la plus forte d’abord ; le niveau courant est sélectionné', () => {
    const opts = hlsLevelOptions(hls);
    expect(opts.map((o) => o.id)).toEqual([NONE, '1', '0', '3']);
    expect(opts.map((o) => o.label)).toEqual(['Auto', '1080p', '720p', '360p']);
    expect(opts.map((o) => o.selected)).toEqual([false, true, false, false]);
  });

  it('qualités : en Auto, seule l’entrée Auto est sélectionnée ; un seul niveau → rien à proposer', () => {
    expect(hlsLevelOptions({ ...hls, autoLevelEnabled: true }).map((o) => o.selected)).toEqual([true, false, false, false]);
    expect(hlsLevelOptions({ levels: [{ height: 720 }], autoLevelEnabled: true })).toEqual([]);
  });

  it('infos techniques : niveau courant, codecs repris du manifeste si l’objet ne les donne pas', () => {
    const tech = hlsTech({
      currentLevel: 0,
      levels: [{ width: 1280, height: 720, bitrate: 2500000, codecs: 'avc1.4d401f,mp4a.40.2' }],
    });
    expect(tech).toEqual({ width: 1280, height: 720, bitrate: 2500000, videoCodec: 'avc1.4d401f', audioCodec: 'mp4a.40.2' });
    expect(hlsTech({ levels: [], currentLevel: -1 })).toEqual({});
  });
});

describe('pistes de la balise vidéo (simulé)', () => {
  it('pistes audio : piste active marquée par `enabled`', () => {
    const opts = htmlAudioOptions([{ language: 'fr', label: '', enabled: false }, { language: 'en', label: 'English', enabled: true }]);
    expect(opts.map((o) => [o.id, o.selected])).toEqual([['0', false], ['1', true]]);
  });

  it('sous-titres : seules les pistes de sous-titres ou de légendes, « Désactivés » si aucune n’est affichée', () => {
    const opts = htmlTextOptions([
      { kind: 'subtitles', language: 'fr', label: '', mode: 'disabled' },
      { kind: 'metadata', language: '', label: 'id3', mode: 'showing' },
      { kind: 'captions', language: 'en', label: 'English', mode: 'showing' },
    ]);
    expect(opts.map((o) => o.id)).toEqual([NONE, '0', '1']);
    expect(opts.map((o) => o.selected)).toEqual([false, false, true]);
    expect(htmlTextOptions(undefined)).toEqual([]);
  });
});

describe('pistes mpv et plugin natif (listes simulées)', () => {
  const list = [
    { id: 1, type: 'video', codec: 'h264', 'demux-w': 1920, 'demux-h': 1080, selected: true },
    { id: 1, type: 'audio', lang: 'fra', codec: 'aac', 'audio-channels': 2, selected: true },
    { id: 2, type: 'audio', lang: 'eng', title: 'English', codec: 'ac3', 'audio-channels': 6, selected: false },
    { id: 1, type: 'sub', lang: 'fra', codec: 'subrip', selected: false },
  ];

  it('audio mpv : une option par piste, la piste choisie par mpv est sélectionnée', () => {
    const opts = trackOptions(mpvAudioTracks(list));
    expect(opts.map((o: Opt) => [o.id, o.selected])).toEqual([['1', true], ['2', false]]);
  });

  it('sous-titres mpv : « Désactivés » sélectionné quand aucune piste ne l’est', () => {
    const opts = trackOptions(mpvSubtitleTracks(list), 'Désactivés');
    expect(opts.map((o: Opt) => [o.id, o.selected])).toEqual([[NONE, true], ['1', false]]);
  });

  it('infos techniques mpv : résolution et codecs de la piste vidéo et de l’audio choisi', () => {
    expect(techFromTracks(list)).toEqual({ width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac' });
    expect(techFromTracks(undefined)).toEqual({ width: undefined, height: undefined, videoCodec: '', audioCodec: '' });
  });
});

describe('libellés de codecs', () => {
  it('vidéo : H.264, HEVC, AV1, VP9, MPEG-2 ; inconnu : nom en majuscules', () => {
    expect(videoCodecLabel('avc1.64001f')).toBe('H.264');
    expect(videoCodecLabel('h264')).toBe('H.264');
    expect(videoCodecLabel('hvc1.1.6.L93')).toBe('HEVC');
    expect(videoCodecLabel('av01.0.08M.08')).toBe('AV1');
    expect(videoCodecLabel('vp9')).toBe('VP9');
    expect(videoCodecLabel('mpeg2video')).toBe('MPEG-2');
    expect(videoCodecLabel('')).toBe('');
    expect(videoCodecLabel('xyz')).toBe('XYZ');
  });

  it('audio : AAC, MP3, AC-3, E-AC-3, Opus', () => {
    expect(audioCodecLabel('mp4a.40.2')).toBe('AAC');
    expect(audioCodecLabel('mp4a.6b')).toBe('MP3');
    expect(audioCodecLabel('ac-3')).toBe('AC-3');
    expect(audioCodecLabel('ec-3')).toBe('E-AC-3');
    expect(audioCodecLabel('opus')).toBe('Opus');
    expect(audioCodecLabel('')).toBe('');
  });
});

describe('contenu du panneau « Infos »', () => {
  const NOW = 1_700_000_000;
  const chan = { id: 'tf1', name: 'TF1', logo: 'https://logo.example/tf1.png', source: 'freetv', num: 1 };
  const programs = [
    { title: 'Passé', start: NOW - 3600, stop: NOW - 600 },
    { title: 'Journal', start: NOW - 600, stop: NOW + 600, desc: 'Les infos du jour' },
    { title: 'Série', start: NOW + 600, stop: NOW + 1800 },
    { title: 'Film', start: NOW + 1800, stop: NOW + 7200, desc: 'Un film' },
    { title: 'Météo', start: NOW + 7200, stop: NOW + 7800 },
    { title: 'Débat', start: NOW + 7800, stop: NOW + 9000 },
    { title: 'Tard', start: NOW + 9000, stop: NOW + 9600 },
  ];

  it('programme en cours : titre, progression, minutes restantes et résumé du guide', () => {
    const m = infoModel(chan, programs, NOW, {});
    expect(m.name).toBe('TF1');
    expect(m.number).toBe('1');
    expect(m.logo).toBe('https://logo.example/tf1.png');
    expect(m.now).toEqual({ title: 'Journal', start: NOW - 600, stop: NOW + 600, desc: 'Les infos du jour', pct: 50, left: 10 });
  });

  it('programmes suivants : quatre au plus, sans le programme passé ni le programme en cours', () => {
    const m = infoModel(chan, programs, NOW, {});
    expect(m.next.map((p: { title: string }) => p.title)).toEqual(['Série', 'Film', 'Météo', 'Débat']);
  });

  it('sans programme en cours : rien à afficher ici, les suivants commencent après l’instant présent', () => {
    const sparse = [{ title: 'Plus tard', start: NOW + 60, stop: NOW + 3600 }];
    const m = infoModel(chan, sparse, NOW, {});
    expect(m.now).toBeNull();
    expect(m.next.map((p: { title: string }) => p.title)).toEqual(['Plus tard']);
    expect(infoModel(chan, [], NOW, {}).next).toEqual([]);
  });

  it('infos techniques : seulement celles qui sont connues, la source toujours', () => {
    const known = infoModel(chan, [], NOW, { width: 1280, height: 720, videoCodec: 'avc1.4d401f', audioCodec: 'mp4a.40.2', bitrate: 2500000 });
    expect(known.tech).toEqual([
      ['Résolution', '1280 × 720'], ['Vidéo', 'H.264'], ['Audio', 'AAC'], ['Débit', '2500 kb/s'], ['Source', 'freetv'],
    ]);
    expect(infoModel(chan, [], NOW, {}).tech).toEqual([['Source', 'freetv']]);
  });

  it('chaîne de playlist : la source s’affiche « Ma playlist »', () => {
    const m = infoModel({ id: 'u1', name: 'Perso', source: 'user' }, [], NOW, {});
    expect(m.tech).toEqual([['Source', 'Ma playlist']]);
  });
});
