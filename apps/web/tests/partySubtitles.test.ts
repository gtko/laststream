// Sous-titres texte de l'hôte : VTT normalisé (SRT d'exemple), bornes de taille, aller-retour du message SUBS, rejet des
// entrées malformées (dont tout champ d'adresse).
import { describe, expect, it } from 'vitest';
import { parseSubtitles } from '../src/player/subs';
import {
  MAX_PARTY_BYTES, MAX_PARTY_TRACKS, MAX_VTT_BYTES, boundTracks, buildPartySubtitles, cuesToVtt, encodePartySubtitles, parsePartySubtitles,
  type PartySubtitleTrack,
} from '../src/party/subtitles';
import { SubsAssembler, encodeSubs, decodeFrame, CHUNK_BYTES, MAX_SUBS_WIRE_BYTES } from '../src/relay/protocol';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Bonjour <i>le monde</i>',
  '',
  '2',
  '00:00:04,000 --> 00:00:05,250',
  '<font color="#ff0000">Fish & chips</font>',
  'ligne deux <b>gras',
  '',
  '3',
  '00:00:06,000 --> 00:00:06,000',
  'durée nulle, ignorée',
  '',
  '4',
  '01:02:03,004 --> 01:02:04,000',
  '{\\an8}Haut {\\i1}écran',
  '',
].join('\n');

const enc = new TextEncoder();
const bytesOf = (s: string) => enc.encode(s).byteLength;

describe('cuesToVtt', () => {
  it('SRT d\'exemple : horodatages VTT, balises gardées ou retirées, texte échappé, cues vides ignorées', () => {
    const vtt = cuesToVtt(parseSubtitles(SRT, 'film.srt'));
    expect(vtt).toBe([
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.500',
      'Bonjour <i>le monde</i>',
      '',
      '00:00:04.000 --> 00:00:05.250',
      'Fish &amp; chips',
      'ligne deux <b>gras</b>',
      '',
      '01:02:03.004 --> 01:02:04.000',
      'Haut écran',
      '',
      '',
    ].join('\n'));
  });

  it('échappe & < > du texte et retire les balises inconnues (aucune balise ouvrante ou script ne survit)', () => {
    const vtt = cuesToVtt([{ start: 0, end: 1, text: '<script>alert(1)</script>Tom & Jerry 5 > 3 <u>x</u>' }]);
    expect(vtt).not.toContain('<script');
    expect(vtt).toContain('alert(1)Tom &amp; Jerry 5 &gt; 3 <u>x</u>');
  });

  it('ferme les balises ouvertes en fin de ligne et retire les fermantes sans ouvrante', () => {
    const vtt = cuesToVtt([{ start: 0, end: 1, text: 'a </i> b <i>c\nd' }]);
    expect(vtt).toContain('a  b <i>c</i>\nd');
  });

  it('horodatages négatifs ramenés à zéro, cues à fin <= début ou non finies écartées', () => {
    const vtt = cuesToVtt([
      { start: -2, end: 1.5, text: 'ok' },
      { start: 3, end: 3, text: 'nul' },
      { start: Number.NaN, end: 4, text: 'nan' },
    ]);
    expect(vtt).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nok\n\n');
  });

  it('borne en octets : tronque proprement par cues entières, jamais au milieu d\'une cue', () => {
    const cues = Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 0.5, text: `cue numéro ${i} é` }));
    const full = cuesToVtt(cues);
    const cap = 300;
    const cut = cuesToVtt(cues, cap);
    expect(bytesOf(cut)).toBeLessThanOrEqual(cap);
    expect(cut.endsWith('\n\n')).toBe(true);
    expect(full.startsWith(cut)).toBe(true);
    expect(cut).not.toContain('cue numéro 49');
    expect(cuesToVtt(cues, MAX_VTT_BYTES)).toBe(full);
  });
});

describe('buildPartySubtitles', () => {
  it('rien sans sous-titre texte chargé (mpv, aucun cue)', () => {
    expect(buildPartySubtitles(null)).toEqual([]);
    expect(buildPartySubtitles({ lang: 'fr', cues: [] })).toEqual([]);
    expect(buildPartySubtitles({ lang: 'fr', cues: [{ start: 2, end: 1, text: 'x' }] })).toEqual([]);
  });

  it('une piste : id et libellé générés, langue normalisée, VTT des cues ; aucun champ autre que id, lang, label, vtt', () => {
    const tracks = buildPartySubtitles({ lang: 'fre', cues: parseSubtitles(SRT) });
    expect(tracks).toHaveLength(1);
    expect(Object.keys(tracks[0]).sort()).toEqual(['id', 'label', 'lang', 'vtt']);
    expect(tracks[0]).toMatchObject({ id: 's1', lang: 'fr', label: 'Français' });
    expect(tracks[0].vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n')).toBe(true);
  });

  it('libellé de repli sans langue connue : aucune adresse dans les pistes', () => {
    const [t] = buildPartySubtitles({ lang: '', cues: [{ start: 0, end: 1, text: 'x' }] });
    expect(t.label).toBe('Sous-titres');
    expect(t.lang).toBe('');
    expect(JSON.stringify(t)).not.toMatch(/https?:/);
  });
});

describe('bornes des pistes', () => {
  const track = (id: string, bytes: number): PartySubtitleTrack => ({
    id, lang: 'en', label: 'English', vtt: 'WEBVTT\n\n' + 'x'.repeat(bytes - 8),
  });

  it('au plus 8 pistes', () => {
    const many = Array.from({ length: 12 }, (_, i) => track('t' + i, 100));
    expect(boundTracks(many)).toHaveLength(MAX_PARTY_TRACKS);
  });

  it('une piste de plus de 512 Kio est écartée ; le total ne dépasse pas 2 Mio', () => {
    const big = track('big', MAX_VTT_BYTES + 1);
    expect(boundTracks([big])).toEqual([]);
    const chunk = MAX_VTT_BYTES; // 512 Kio, quatre pistes = 2 Mio pile, la cinquième ne tient pas
    const five = Array.from({ length: 5 }, (_, i) => track('f' + i, chunk));
    const kept = boundTracks(five);
    expect(kept).toHaveLength(4);
    expect(kept.reduce((sum, t) => sum + bytesOf(t.vtt), 0)).toBeLessThanOrEqual(MAX_PARTY_BYTES);
  });
});

describe('message SUBS : aller-retour et rejet', () => {
  const tracks: PartySubtitleTrack[] = [
    { id: 's1', lang: 'fr', label: 'Français', vtt: cuesToVtt(parseSubtitles(SRT)) },
    { id: 's2', lang: '', label: 'Sous-titres', vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n\n' },
  ];

  it('encodage puis décodage rendent exactement les pistes', () => {
    const parsed = parsePartySubtitles(encodePartySubtitles(tracks));
    expect(parsed).toEqual(tracks);
  });

  it('liste vide : aucune piste, valide', () => {
    expect(parsePartySubtitles(encodePartySubtitles([]))).toEqual([]);
  });

  it('découpage en trames de 64 Ko au plus, réassemblage exact, dernier morceau marqué', () => {
    const big: PartySubtitleTrack = { id: 's1', lang: 'en', label: 'English', vtt: 'WEBVTT\n\n' + 'a'.repeat(MAX_VTT_BYTES - 8) };
    const message = encodePartySubtitles([big]);
    const frames = encodeSubs(message).map((f) => decodeFrame(f));
    expect(frames.length).toBeGreaterThan(1);
    frames.forEach((f, i) => {
      expect(f).toMatchObject({ t: 'subs', fin: i === frames.length - 1 });
      expect((f as { payload: Uint8Array }).payload.byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
    });
    const asm = new SubsAssembler();
    let out: Uint8Array | null = null;
    for (const f of frames) out = asm.push(f as { fin: boolean; payload: Uint8Array }) ?? out;
    expect(out).not.toBeNull();
    expect(parsePartySubtitles(out!)).toEqual([big]);
  });

  it('message vide : une trame de fin vide, réassemblée en octets vides, rejetée ensuite', () => {
    const [f] = encodeSubs(new Uint8Array(0)).map((x) => decodeFrame(x));
    const asm = new SubsAssembler();
    const out = asm.push(f as { fin: boolean; payload: Uint8Array });
    expect(out?.byteLength).toBe(0);
    expect(parsePartySubtitles(out!)).toBeNull();
  });

  it('un message qui dépasse la borne de réception est abandonné sans affecter le suivant', () => {
    const asm = new SubsAssembler(10);
    expect(asm.push({ fin: false, payload: new Uint8Array(8) })).toBeNull();
    expect(asm.push({ fin: false, payload: new Uint8Array(8) })).toBeNull(); // dépassement
    expect(asm.push({ fin: true, payload: new Uint8Array(8) })).toBeNull(); // fin du message abandonné
    const next = asm.push({ fin: true, payload: Uint8Array.from([1, 2]) });
    expect(Array.from(next!)).toEqual([1, 2]);
  });

  it('rejette : JSON invalide, non-tableau, octets non UTF-8, vide, trop de pistes', () => {
    const bad = (s: string) => parsePartySubtitles(enc.encode(s));
    expect(bad('{')).toBeNull();
    expect(bad('{"id":"s1"}')).toBeNull();
    expect(parsePartySubtitles(Uint8Array.from([0x5b, 0xff, 0x5d]))).toBeNull();
    expect(parsePartySubtitles(new Uint8Array(0))).toBeNull();
    const nine = Array.from({ length: MAX_PARTY_TRACKS + 1 }, (_, i) => ({ id: 'a' + i, lang: '', label: 'x', vtt: 'WEBVTT' }));
    expect(bad(JSON.stringify(nine))).toBeNull();
  });

  it('rejette un champ inconnu, en particulier une adresse (url, src, href, proto)', () => {
    for (const key of ['url', 'src', 'href', '__proto__', 'extra']) {
      const item = { id: 's1', lang: 'fr', label: 'Français', vtt: 'WEBVTT', [key]: 'https://example.invalid/x.vtt' };
      expect(parsePartySubtitles(enc.encode(JSON.stringify([item])))).toBeNull();
    }
  });

  it('rejette un identifiant, une langue ou un libellé malformé, ou un libellé qui ressemble à une adresse', () => {
    const base = { id: 's1', lang: 'fr', label: 'Français', vtt: 'WEBVTT\n\n' };
    const cases: Array<Partial<typeof base> | Record<string, unknown>> = [
      { id: '' }, { id: 'un identifiant trop long pour la borne qui fait plus de trente-deux caractères' }, { id: 'a/b' },
      { id: 42 as unknown as string }, { lang: 'francais' }, { lang: 'F R' }, { lang: 5 as unknown as string },
      { label: '' }, { label: 'voir https://example.invalid' }, { label: 'a\u0007b' }, { label: 'x'.repeat(81) },
    ];
    for (const c of cases) {
      expect(parsePartySubtitles(enc.encode(JSON.stringify([{ ...base, ...c }])))).toBeNull();
    }
  });

  it('rejette un VTT sans en-tête, avec une balise non permise, avec un caractère de contrôle, ou trop gros', () => {
    const item = (vtt: string) => enc.encode(JSON.stringify([{ id: 's1', lang: '', label: 'x', vtt }]));
    expect(parsePartySubtitles(item('00:00 --> 00:01\nx'))).toBeNull();
    expect(parsePartySubtitles(item('WEBVTT\n\n<img src=x onerror=1>'))).toBeNull();
    expect(parsePartySubtitles(item('WEBVTT\n\nab\u0001cd'))).toBeNull();
    expect(parsePartySubtitles(item('WEBVTT\n\n<i>ok</i> <b>ok</b> <u>ok</u>'))).not.toBeNull();
    expect(parsePartySubtitles(item('WEBVTT\n' + 'x'.repeat(MAX_VTT_BYTES)))).toBeNull();
  });

  it('rejette un total de plus de 2 Mio pour les pistes reçues', () => {
    const piece = 'WEBVTT\n\n' + 'a'.repeat(MAX_VTT_BYTES - 8);
    const items = Array.from({ length: 5 }, (_, i) => ({ id: 'p' + i, lang: '', label: 'x', vtt: piece }));
    expect(parsePartySubtitles(enc.encode(JSON.stringify(items)))).toBeNull();
  });

  it('rejette un message au-delà de la borne d\'octets reçus', () => {
    expect(parsePartySubtitles(new Uint8Array(MAX_SUBS_WIRE_BYTES + 1))).toBeNull();
  });
});
