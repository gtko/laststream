// Badges des formats et pastille de débit du sélecteur de sources (src/sources/badges.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bitDepthOf, codecBadges, escapeHtml, fitBadge, fitLevel } from '../src/sources/badges';
import type { BadgeInfo, BadgePart } from '../src/sources/badges';

const ariaLabels = (html: string): string[] => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
/** Badge bdg-<id> présent : la classe est suivie d'un guillemet (badge maison) ou d'un espace (logo, classe bdg-logo). */
const hasBadge = (html: string, id: string): boolean => new RegExp('bdg-' + id + '[" ]').test(html);
/** Position du badge bdg-<id> dans le HTML, -1 si absent. */
const posOf = (html: string, id: string): number => html.search(new RegExp('bdg-' + id + '[" ]'));
/** Fichiers des logos (attribut src des images de badge). */
const logoSrcs = (html: string): string[] => [...html.matchAll(/<img class="bdg-img" src="([^"]+)" alt="[^"]*"[^>]*>/g)].map((m) => m[1]);

const BADGES_DIR = path.resolve(__dirname, '../public/badges');

describe('codecBadges : variantes vidéo', () => {
  it.each([
    ['AVC', 'avc'], ['h264', 'avc'], ['x264', 'avc'], ['H.264', 'avc'],
    ['HEVC', 'hevc'], ['h265', 'hevc'], ['x265', 'hevc'], ['H.265', 'hevc'],
    ['AV1', 'av1'], ['VP9', 'vp9'],
  ])('codec %s → badge %s', (codec, id) => {
    const html = codecBadges({ codec });
    expect(hasBadge(html, id)).toBe(true);
    expect(html).not.toContain('s-codec');
  });

  it.each([
    ['DV', 'dv'], ['Dolby Vision', 'dv'], ['DoVi', 'dv'],
    ['HDR10+', 'hdr10p'], ['HDR10plus', 'hdr10p'],
    ['HDR10', 'hdr10'], ['HLG', 'hlg'], ['HDR', 'hdr'],
  ])('HDR %s → badge %s', (hdr, id) => {
    expect(hasBadge(codecBadges({ hdr: [hdr] }), id)).toBe(true);
  });

  it('le HDR générique cède la place à HDR10 et HDR10+', () => {
    expect(hasBadge(codecBadges({ hdr: ['HDR', 'HDR10'] }), 'hdr')).toBe(false);
    expect(hasBadge(codecBadges({ hdr: ['HDR10+', 'HDR'] }), 'hdr')).toBe(false);
    expect(hasBadge(codecBadges({ hdr: ['DV', 'HDR'] }), 'hdr')).toBe(true);
  });

  it.each([['REMUX', 'remux'], ['BluRay', 'bluray'], ['WEB-DL', 'webdl'], ['WEBRip', 'webrip'], ['WEB', 'web'], ['HDTV', 'hdtv'], ['CAM', 'cam'], ['DVD', 'dvd']])(
    'source %s → badge %s', (source, id) => {
      expect(hasBadge(codecBadges({ source }), id)).toBe(true);
    },
  );

  it('ordre : source, HDR, codec, 10-bit', () => {
    const html = codecBadges({ source: 'REMUX', hdr: ['DV', 'HDR10+'], codec: 'HEVC', bitDepth: 10 });
    expect(posOf(html, 'remux')).toBeGreaterThanOrEqual(0);
    expect(posOf(html, 'remux')).toBeLessThan(posOf(html, 'dv'));
    expect(posOf(html, 'dv')).toBeLessThan(posOf(html, 'hdr10p'));
    expect(posOf(html, 'hdr10p')).toBeLessThan(posOf(html, 'hevc'));
    expect(posOf(html, 'hevc')).toBeLessThan(posOf(html, 'bit10'));
  });

  it('10-bit : détecté dans le texte de la release', () => {
    expect(bitDepthOf('HEVC 10bit')).toBe(10);
    expect(bitDepthOf('x265 10-bit')).toBe(10);
    expect(bitDepthOf('Movie.Hi10P.x264')).toBe(10);
    expect(bitDepthOf('Movie 1080p WEB')).toBeUndefined();
    expect(hasBadge(codecBadges({ bitDepth: 10 }), 'bit10')).toBe(true);
  });
});

describe('codecBadges : variantes audio', () => {
  it.each([
    ['TrueHD Atmos 7.1', ['truehd', 'atmos', 'ch71']],
    ['DTS-HD MA 5.1', ['dtshdma', 'ch51']],
    ['DTS:X', ['dtsx']],
    ['DTS-X', ['dtsx']],
    ['DTS', ['dts']],
    ['DDP 5.1', ['ddp', 'ch51']],
    ['EAC3', ['ddp']],
    ['DD+', ['ddp']],
    ['AC3', ['dd']],
    ['DD 5.1', ['dd', 'ch51']],
    ['AAC 2.0', ['aac', 'ch20']],
    ['Opus', ['opus']],
    ['FLAC', ['flac']],
  ])('audio %s → badges %j', (audio, ids) => {
    const html = codecBadges({ audio }, 'audio');
    for (const id of ids) expect(hasBadge(html, id), id).toBe(true);
    expect(html).not.toContain('s-audio');
  });

  it('TrueHD Atmos : un seul badge TrueHD et un badge Atmos', () => {
    const html = codecBadges({ audio: 'TrueHD Atmos 7.1' }, 'audio');
    expect(html.match(/bdg-truehd[" ]/g)).toHaveLength(1);
    expect(hasBadge(html, 'atmos')).toBe(true);
  });

  it('canaux : les champs bruts lastAddon sont aussi acceptés', () => {
    expect(hasBadge(codecBadges({ audio: ['DDP'], channels: '5.1' }, 'audio'), 'ch51')).toBe(true);
    expect(hasBadge(codecBadges({ audio: ['AAC'], channels: '7.1' }, 'audio'), 'ch71')).toBe(true);
  });
});

describe('logos officiels : fichier publié dans public/badges, sinon badge maison', () => {
  it.each([
    ['dv', { hdr: ['DV'] }, 'video', 'dolby-vision.svg', true],
    ['atmos', { audio: 'Atmos' }, 'audio', 'dolby-atmos.svg', true],
    ['truehd', { audio: 'TrueHD' }, 'audio', 'dolby-truehd.svg', true],
    ['dd', { audio: 'AC3' }, 'audio', 'dolby-digital.svg', true],
    ['ddp', { audio: 'DDP' }, 'audio', 'dolby-digital-plus.svg', true],
    ['dtshdma', { audio: 'DTS-HD MA' }, 'audio', 'dts-hd-ma.svg', false],
    ['dts', { audio: 'DTS' }, 'audio', 'dts.svg', false],
    ['hdr10', { hdr: ['HDR10'] }, 'video', 'hdr10.svg', true],
    ['hdr10p', { hdr: ['HDR10+'] }, 'video', 'hdr10plus.svg', true],
    ['av1', { codec: 'AV1' }, 'video', 'av1.svg', false],
    ['avc', { codec: 'H.264' }, 'video', 'avc.svg', false],
    ['opus', { audio: 'Opus' }, 'audio', 'opus.svg', false],
    ['aac', { audio: 'AAC' }, 'audio', 'aac.svg', false],
  ])('%s : logo publié', (id, info, part, file, mono) => {
    const html = codecBadges(info as BadgeInfo, part as BadgePart);
    expect(logoSrcs(html)).toEqual(['/badges/' + file]);
    expect(hasBadge(html, id)).toBe(true);
    expect(html).toContain('bdg-logo');
    expect(html.includes('bdg-mono')).toBe(mono);
    expect(html).not.toContain('class="bdg-t"');
  });

  it.each([
    [{ codec: 'HEVC' }, 'video', 'hevc'],
    [{ hdr: ['HLG'] }, 'video', 'hlg'],
    [{ hdr: ['HDR'] }, 'video', 'hdr'],
    [{ audio: 'DTS:X' }, 'audio', 'dtsx'],
    [{ codec: 'VP9' }, 'video', 'vp9'],
    [{ source: 'REMUX' }, 'video', 'remux'],
    [{ audio: 'FLAC' }, 'audio', 'flac'],
    [{ bitDepth: 10 }, 'video', 'bit10'],
  ])('%j : pas de logo, badge maison', (info, part, id) => {
    const html = codecBadges(info as BadgeInfo, part as BadgePart);
    expect(html).not.toContain('<img');
    expect(hasBadge(html, id)).toBe(true);
    expect(html).toContain('<span class="bdg-t" aria-hidden="true">');
  });

  it('chaque logo référencé existe, et chaque SVG publié figure dans SOURCES.md', () => {
    const inputs: Array<[BadgeInfo, BadgePart]> = [
      [{ codec: 'AV1' }, 'video'], [{ codec: 'H.264' }, 'video'], [{ hdr: ['DV', 'HDR10', 'HDR10+'] }, 'video'],
      [{ audio: 'TrueHD Atmos' }, 'audio'], [{ audio: 'DTS-HD MA' }, 'audio'], [{ audio: 'DTS' }, 'audio'],
      [{ audio: 'DDP' }, 'audio'], [{ audio: 'AC3' }, 'audio'], [{ audio: 'AAC' }, 'audio'], [{ audio: 'Opus' }, 'audio'],
    ];
    for (const [info, part] of inputs) {
      for (const src of logoSrcs(codecBadges(info, part))) {
        expect(fs.existsSync(path.join(BADGES_DIR, src.replace(/^\/badges\//, '')))).toBe(true);
      }
    }
    const sources = fs.readFileSync(path.join(BADGES_DIR, 'SOURCES.md'), 'utf8');
    const svgs = fs.readdirSync(BADGES_DIR).filter((f) => f.endsWith('.svg'));
    expect(svgs.length).toBeGreaterThan(0);
    for (const f of svgs) expect(sources, f).toContain(f);
  });

  it('aucun SVG publié ne contient de script, de gestionnaire d’événement, de lien, d’image ou de données externes', () => {
    const svgs = fs.readdirSync(BADGES_DIR).filter((f) => f.endsWith('.svg'));
    expect(svgs.length).toBeGreaterThan(0);
    for (const f of svgs) {
      const svg = fs.readFileSync(path.join(BADGES_DIR, f), 'utf8');
      expect(svg, f).not.toMatch(/<script/i);
      expect(svg, f).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg, f).not.toMatch(/<(image|foreignObject|iframe|object|embed)\b/i);
      expect(svg, f).not.toMatch(/(href|url\()\s*[=(]?\s*["']?(https?:|javascript:|data:)/i);
      expect(svg, f).not.toMatch(/<!DOCTYPE|<!ENTITY/);
    }
  });
});

describe('inconnu : texte neutre, sans badge', () => {
  it('codec inconnu → texte neutre (classe historique)', () => {
    expect(codecBadges({ codec: 'VP8' })).toBe('<span class="s-codec">VP8</span>');
  });
  it('source inconnue → texte neutre', () => {
    expect(codecBadges({ source: 'Telecine' })).toBe('<span class="s-type">Telecine</span>');
  });
  it('HDR inconnu → texte neutre', () => {
    expect(codecBadges({ hdr: ['Technicolor'] })).toBe('<span class="s-hdr">Technicolor</span>');
  });
  it('audio inconnu → texte neutre', () => {
    expect(codecBadges({ audio: 'Vorbis' }, 'audio')).toBe('<span class="s-audio">Vorbis</span>');
  });
  it('canaux inconnus → texte neutre', () => {
    expect(codecBadges({ audio: 'AAC 6.1' }, 'audio')).toContain('<span class="s-ch">6.1</span>');
    expect(hasBadge(codecBadges({ audio: 'AAC 6.1' }, 'audio'), 'aac')).toBe(true);
  });
  it('rien à afficher → chaîne vide', () => {
    expect(codecBadges({})).toBe('');
    expect(codecBadges({}, 'audio')).toBe('');
  });
});

describe('échappement', () => {
  it('escapeHtml couvre & < > " \'', () => {
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });
  it('une valeur inconnue ne peut pas injecter de balise', () => {
    const html = codecBadges({ codec: '<img src=x onerror=alert(1)>', source: '"><b>x' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&quot;&gt;&lt;b&gt;x');
  });
});

describe('aria-label et infobulle', () => {
  it('logo : le nom complet reste en aria-label et infobulle, l’image est décorative', () => {
    const html = codecBadges({ codec: 'AV1' });
    expect(html).toContain('role="img"');
    expect(ariaLabels(html)).toEqual(['AV1 · codec vidéo libre et efficace (AOMedia)']);
    expect(html).toContain('title="AV1 · codec vidéo libre et efficace (AOMedia)"');
    expect(html).toContain('<img class="bdg-img" src="/badges/av1.svg" alt="" decoding="async">');
  });
  it('badge maison : le texte court est masqué aux lecteurs', () => {
    const html = codecBadges({ codec: 'VP9' });
    expect(ariaLabels(html)).toEqual(['VP9 · codec vidéo libre']);
    expect(html).toContain('title="VP9 · codec vidéo libre"');
    expect(html).toContain('<span class="bdg-t" aria-hidden="true">VP9</span>');
  });
  it('HDR et audio : noms complets', () => {
    expect(ariaLabels(codecBadges({ hdr: ['Dolby Vision'] }))).toEqual(['Dolby Vision · vidéo HDR dynamique']);
    expect(ariaLabels(codecBadges({ audio: 'DTS:X' }, 'audio'))).toEqual(['DTS:X · audio à objets']);
  });
});

describe('fitLevel', () => {
  it('cas courant : 8 Mb/s sur 178 Mb/s → fluide', () => {
    expect(fitLevel(8, 178)).toBe('fluid');
  });
  it('bornes : ≤ 60 % fluide, 60–90 % juste, > 90 % risque', () => {
    expect(fitLevel(60, 100)).toBe('fluid');
    expect(fitLevel(60.01, 100)).toBe('tight');
    expect(fitLevel(90, 100)).toBe('tight');
    expect(fitLevel(90.01, 100)).toBe('risky');
    expect(fitLevel(100, 100)).toBe('risky');
    expect(fitLevel(150, 100)).toBe('risky');
  });
  it('source à 0 Mb/s : fluide', () => {
    expect(fitLevel(0, 178)).toBe('fluid');
  });
  it('inconnu : débit de connexion absent ou nul, débit de source absent, valeurs invalides', () => {
    expect(fitLevel(8, null)).toBe('unknown');
    expect(fitLevel(8, undefined)).toBe('unknown');
    expect(fitLevel(8, 0)).toBe('unknown');
    expect(fitLevel(null, 178)).toBe('unknown');
    expect(fitLevel(undefined, 178)).toBe('unknown');
    expect(fitLevel(NaN, 178)).toBe('unknown');
    expect(fitLevel(-1, 178)).toBe('unknown');
    expect(fitLevel(8, Infinity)).toBe('unknown');
  });
});

describe('fitBadge', () => {
  it('fluide : texte, classe et aria-label explicites (kb/s en entrée)', () => {
    const html = fitBadge(8000, 178000);
    expect(html).toContain('fit-fluid');
    expect(html).toContain('>Fluide<');
    expect(ariaLabels(html)).toEqual(['8,0 Mb/s sur une connexion de 178,0 Mb/s : fluide']);
  });
  it('juste et risque de coupures', () => {
    const tight = fitBadge(70000, 100000);
    expect(tight).toContain('fit-tight');
    expect(tight).toContain('>Juste<');
    expect(ariaLabels(tight)).toEqual(['70,0 Mb/s sur une connexion de 100,0 Mb/s : juste']);
    const risky = fitBadge(95000, 100000);
    expect(risky).toContain('fit-risky');
    expect(risky).toContain('>Risque de coupures<');
    expect(ariaLabels(risky)).toEqual(['95,0 Mb/s sur une connexion de 100,0 Mb/s : risque de coupures']);
  });
  it('connexion inconnue : pastille neutre « Débit inconnu »', () => {
    const html = fitBadge(8000, null);
    expect(html).toContain('fit-unknown');
    expect(html).toContain('Débit inconnu');
    expect(ariaLabels(html)[0]).toContain('Débit de ta connexion inconnu');
  });
  it('source sans débit : pastille neutre « Débit inconnu »', () => {
    const html = fitBadge(null, 178000);
    expect(html).toContain('fit-unknown');
    expect(ariaLabels(html)).toEqual(['Débit de la source inconnu']);
  });
});
