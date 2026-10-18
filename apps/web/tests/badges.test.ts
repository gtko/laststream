// Badges des formats et pastille de débit du sélecteur de sources (src/sources/badges.ts).
import { describe, expect, it } from 'vitest';
import { bitDepthOf, codecBadges, escapeHtml, fitBadge, fitLevel } from '../src/sources/badges';

const ariaLabels = (html: string): string[] => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);

describe('codecBadges : variantes vidéo', () => {
  it.each([
    ['AVC', 'avc'], ['h264', 'avc'], ['x264', 'avc'], ['H.264', 'avc'],
    ['HEVC', 'hevc'], ['h265', 'hevc'], ['x265', 'hevc'], ['H.265', 'hevc'],
    ['AV1', 'av1'], ['VP9', 'vp9'],
  ])('codec %s → badge %s', (codec, id) => {
    const html = codecBadges({ codec });
    expect(html).toContain('bdg-' + id + '"');
    expect(html).not.toContain('s-codec');
  });

  it.each([
    ['DV', 'dv'], ['Dolby Vision', 'dv'], ['DoVi', 'dv'],
    ['HDR10+', 'hdr10p'], ['HDR10plus', 'hdr10p'],
    ['HDR10', 'hdr10'], ['HLG', 'hlg'], ['HDR', 'hdr'],
  ])('HDR %s → badge %s', (hdr, id) => {
    expect(codecBadges({ hdr: [hdr] })).toContain('bdg-' + id + '"');
  });

  it('le HDR générique cède la place à HDR10 et HDR10+', () => {
    expect(codecBadges({ hdr: ['HDR', 'HDR10'] })).not.toMatch(/bdg-hdr"/);
    expect(codecBadges({ hdr: ['HDR10+', 'HDR'] })).not.toMatch(/bdg-hdr"/);
    expect(codecBadges({ hdr: ['DV', 'HDR'] })).toMatch(/bdg-hdr"/);
  });

  it.each([['REMUX', 'remux'], ['BluRay', 'bluray'], ['WEB-DL', 'webdl'], ['WEBRip', 'webrip'], ['WEB', 'web'], ['HDTV', 'hdtv'], ['CAM', 'cam'], ['DVD', 'dvd']])(
    'source %s → badge %s', (source, id) => {
      expect(codecBadges({ source })).toContain('bdg-' + id + '"');
    },
  );

  it('ordre : source, HDR, codec, 10-bit', () => {
    const html = codecBadges({ source: 'REMUX', hdr: ['DV', 'HDR10+'], codec: 'HEVC', bitDepth: 10 });
    const at = (cls: string) => html.indexOf('bdg-' + cls + '"');
    expect(at('remux')).toBeGreaterThanOrEqual(0);
    expect(at('remux')).toBeLessThan(at('dv'));
    expect(at('dv')).toBeLessThan(at('hdr10p'));
    expect(at('hdr10p')).toBeLessThan(at('hevc'));
    expect(at('hevc')).toBeLessThan(at('bit10'));
  });

  it('10-bit : détecté dans le texte de la release', () => {
    expect(bitDepthOf('HEVC 10bit')).toBe(10);
    expect(bitDepthOf('x265 10-bit')).toBe(10);
    expect(bitDepthOf('Movie.Hi10P.x264')).toBe(10);
    expect(bitDepthOf('Movie 1080p WEB')).toBeUndefined();
    expect(codecBadges({ bitDepth: 10 })).toContain('bdg-bit10"');
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
    for (const id of ids) expect(html).toContain('bdg-' + id + '"');
    expect(html).not.toContain('s-audio');
  });

  it('TrueHD Atmos : un seul badge TrueHD et un badge Atmos', () => {
    const html = codecBadges({ audio: 'TrueHD Atmos 7.1' }, 'audio');
    expect(html.match(/bdg-truehd"/g)).toHaveLength(1);
    expect(html).toContain('bdg-atmos"');
  });

  it('canaux : les champs bruts lastAddon sont aussi acceptés', () => {
    expect(codecBadges({ audio: ['DDP'], channels: '5.1' }, 'audio')).toContain('bdg-ch51"');
    expect(codecBadges({ audio: ['AAC'], channels: '7.1' }, 'audio')).toContain('bdg-ch71"');
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
    expect(codecBadges({ audio: 'AAC 6.1' }, 'audio')).toContain('bdg-aac"');
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
  it('chaque badge porte son nom complet, et le texte court est masqué aux lecteurs', () => {
    const html = codecBadges({ codec: 'AV1' });
    expect(html).toContain('role="img"');
    expect(ariaLabels(html)).toEqual(['AV1 · codec vidéo libre et efficace (AOMedia)']);
    expect(html).toContain('title="AV1 · codec vidéo libre et efficace (AOMedia)"');
    expect(html).toContain('<span class="bdg-t" aria-hidden="true">AV1</span>');
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
