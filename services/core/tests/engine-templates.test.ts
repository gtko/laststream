import { describe, expect, it } from 'vitest';
import { renderTemplate, type StreamView, type TemplateId } from '../src/engine/templates.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Exemple de référence du brief : débridé en cache, REMUX, deux langues vérifiées. */
const DETAILED: StreamView = {
  resolutionLabel: '4K',
  source: 'BluRay REMUX',
  hdr: ['DV', 'HDR10'],
  bitrateMbps: 44.4,
  languages: [
    { code: 'fr', verified: true },
    { code: 'en', verified: true },
  ],
  sizeBytes: 54.2 * GIB,
  copies: 3,
  videoCodec: 'HEVC 10bit',
  audioLabel: 'TrueHD Atmos 7.1',
  group: 'FraMeSToR',
  filename: 'Movie.2024.2160p.BluRay.REMUX.HEVC.TrueHD.Atmos.7.1-FraMeSToR.mkv',
  cached: true,
  debrid: true,
};

/** Vue minimale : 1080p WEB-DL, aucune langue, un seul exemplaire, flux P2P par défaut. */
const view = (overrides: Partial<StreamView> = {}): StreamView => ({
  resolutionLabel: '1080p',
  source: 'WEB-DL',
  hdr: [],
  languages: [],
  copies: 1,
  ...overrides,
});

const render = (id: TemplateId, v: StreamView) => renderTemplate(id, v);

describe('renderTemplate : Détaillé', () => {
  it('reproduit l exemple de référence (nom AD en cache, REMUX, deux langues vérifiées)', () => {
    const out = render('detaille', DETAILED);
    expect(out.name).toBe('[AD⚡] lastAddon 4K');
    expect(out.description).toBe(
      [
        'BluRay REMUX • DV • HDR10 • 📶 44 Mb/s 🇫🇷 🇬🇧 ✓ • 💾 54,2 Go • 🔎 3 copies',
        '🎧 HEVC 10bit • TrueHD Atmos 7.1 • FraMeSToR',
        '🗂️ Movie.2024.2160p.BluRay.REMUX.HEVC.TrueHD.Atmos.7.1-FraMeSToR.mkv',
      ].join('\n'),
    );
  });

  it('préfixe [AD⏳] pour un débridé non caché', () => {
    expect(render('detaille', { ...DETAILED, cached: false }).name).toBe('[AD⏳] lastAddon 4K');
  });

  it('aucun préfixe AD pour un flux direct, même marqué débridé', () => {
    expect(render('detaille', { ...DETAILED, direct: true }).name).toBe('lastAddon 4K');
  });

  it('flux P2P : pas de préfixe, seeders au singulier puis au pluriel', () => {
    const p2p = view({ languages: [{ code: 'fr', verified: false }], sizeBytes: 850 * MIB, seeders: 12 });
    expect(render('detaille', p2p)).toEqual({
      name: 'lastAddon 1080p',
      description: 'WEB-DL • 🇫🇷? • 💾 850 Mo • 🌱 12 seeders',
    });
    expect(render('detaille', { ...p2p, seeders: 1 }).description).toBe('WEB-DL • 🇫🇷? • 💾 850 Mo • 🌱 1 seeder');
    expect(render('detaille', { ...p2p, seeders: 0 }).description).toBe('WEB-DL • 🇫🇷? • 💾 850 Mo • 🌱 0 seeder');
  });

  it('omet les segments absents (vue minimale, une seule ligne)', () => {
    expect(render('detaille', view({ resolutionLabel: '720p', copies: 0 }))).toEqual({
      name: 'lastAddon 720p',
      description: 'WEB-DL',
    });
  });

  it('copies : pas de segment pour un seul exemplaire, « N copies » à partir de 2', () => {
    const line1 = (v: StreamView) => render('detaille', v).description.split('\n')[0];
    expect(line1({ ...DETAILED, copies: 1 })).toBe('BluRay REMUX • DV • HDR10 • 📶 44 Mb/s 🇫🇷 🇬🇧 ✓ • 💾 54,2 Go');
    expect(line1({ ...DETAILED, copies: 2 })).toMatch(/• 🔎 2 copies$/);
    expect(line1({ ...DETAILED, copies: 0 })).not.toContain('🔎');
  });

  it('langues : vérifiées puis ✓, annoncées suffixées de ?, doublons fusionnés', () => {
    const withLangs = (languages: StreamView['languages']) =>
      render('detaille', view({ languages })).description.split('\n')[0];
    expect(
      withLangs([
        { code: 'fr', verified: false },
        { code: 'en', verified: true },
        { code: 'en', verified: false },
        { code: 'es', verified: false },
      ]),
    ).toBe('WEB-DL • 🇬🇧 ✓ 🇫🇷? 🇪🇸?');
    expect(withLangs([{ code: 'fr', verified: false }])).toBe('WEB-DL • 🇫🇷?');
  });

  it('débit : arrondi à l entier, omis s il arrondit à 0', () => {
    const withBitrate = (bitrateMbps: number) =>
      render('detaille', view({ bitrateMbps, languages: [{ code: 'fr', verified: true }] })).description.split('\n')[0];
    expect(withBitrate(44.6)).toBe('WEB-DL • 📶 45 Mb/s 🇫🇷 ✓');
    expect(withBitrate(0.2)).toBe('WEB-DL • 🇫🇷 ✓');
  });

  it('taille : Go à virgule à partir de 1 Go, Mo en dessous', () => {
    const size = (sizeBytes: number) => render('detaille', view({ sizeBytes })).description;
    expect(size(1.5 * GIB)).toBe('WEB-DL • 💾 1,5 Go');
    expect(size(850 * MIB)).toBe('WEB-DL • 💾 850 Mo');
  });

  it('ajoute « Autre langue » en tête si fallbackLanguage', () => {
    expect(render('detaille', { ...DETAILED, fallbackLanguage: true }).description.split('\n')[0]).toBe(
      'Autre langue • BluRay REMUX • DV • HDR10 • 📶 44 Mb/s 🇫🇷 🇬🇧 ✓ • 💾 54,2 Go • 🔎 3 copies',
    );
  });

  it('addonName personnalisé remplace lastAddon', () => {
    expect(render('detaille', { ...DETAILED, addonName: 'MonAddon' }).name).toBe('[AD⚡] MonAddon 4K');
  });

  it('code de langue inconnu affiché en majuscules', () => {
    expect(render('detaille', view({ languages: [{ code: 'pt', verified: true }] })).description).toBe('WEB-DL • PT ✓');
  });

  it('filename : retours ligne et contrôles retirés, balises HTML supprimées', () => {
    const last = (filename: string) => render('detaille', view({ filename })).description.split('\n').at(-1);
    expect(last('Movie\r\nName.mkv\u0007')).toBe('🗂️ Movie Name.mkv');
    expect(last('<img src=x onerror=alert(1)>Movie.mkv')).toBe('🗂️ Movie.mkv');
  });

  it('filename tronqué à 140 caractères, « … » compris', () => {
    const last = (filename: string) => render('detaille', view({ filename })).description.split('\n').at(-1);
    expect(last('a'.repeat(200))).toBe(`🗂️ ${'a'.repeat(139)}…`);
    expect(last('b'.repeat(140))).toBe(`🗂️ ${'b'.repeat(140)}`);
    expect(last('😀'.repeat(150))).toBe(`🗂️ ${'😀'.repeat(139)}…`);
  });

  it('filename vide après nettoyage : pas de ligne 🗂️', () => {
    expect(render('detaille', view({ filename: '<br>\n' })).description).toBe('WEB-DL');
  });
});

describe('renderTemplate : Netflix', () => {
  it('reproduit le gabarit de référence (langues en toutes lettres, qualité, taille)', () => {
    expect(render('netflix', DETAILED)).toEqual({
      name: 'lastAddon 4K',
      description: 'Français, Anglais\nBluRay REMUX · DV · HDR10 · 54,2 Go',
    });
  });

  it('marque les langues annoncées (annoncé)', () => {
    const out = render(
      'netflix',
      view({
        languages: [
          { code: 'fr', verified: true },
          { code: 'es', verified: false },
        ],
      }),
    );
    expect(out.description).toBe('Français, Espagnol (annoncé)\nWEB-DL');
  });

  it('code de langue inconnu en majuscules', () => {
    expect(render('netflix', view({ languages: [{ code: 'pt', verified: true }] })).description).toBe('PT\nWEB-DL');
  });

  it('Autre langue en tête, et jamais de préfixe AD', () => {
    expect(render('netflix', { ...DETAILED, fallbackLanguage: true })).toEqual({
      name: 'lastAddon 4K',
      description: 'Autre langue · Français, Anglais\nBluRay REMUX · DV · HDR10 · 54,2 Go',
    });
  });

  it('vue minimale : une seule ligne quand il ne reste que la source', () => {
    expect(render('netflix', view({ resolutionLabel: 'SD', source: 'DVD' }))).toEqual({
      name: 'lastAddon SD',
      description: 'DVD',
    });
  });
});

describe('renderTemplate : Compact', () => {
  it('reproduit le nom sur une ligne et la description de référence', () => {
    expect(render('compact', DETAILED)).toEqual({
      name: '4K · REMUX · 🇫🇷🇬🇧✓ · 54 Go',
      description: 'AllDebrid (en cache) · HEVC 10bit · TrueHD Atmos 7.1',
    });
  });

  it('omet langues et codecs absents, taille en Mo sous 1 Go', () => {
    expect(render('compact', view({ sizeBytes: 850 * MIB }))).toEqual({
      name: '1080p · WEB-DL · 850 Mo',
      description: 'P2P',
    });
  });

  it('langues annoncées suffixées de ? dans le nom', () => {
    expect(render('compact', view({ languages: [{ code: 'fr', verified: false }] })).name).toBe('1080p · WEB-DL · 🇫🇷?');
  });

  it('statut : P2P avec seeders, AllDebrid non caché, Direct', () => {
    expect(render('compact', view({ seeders: 12 })).description).toBe('P2P (12 seeders)');
    expect(render('compact', view({ debrid: true, cached: false })).description).toBe('AllDebrid (pas en cache)');
    expect(render('compact', view({ direct: true })).description).toBe('Direct');
  });
});

describe('renderTemplate : Direct', () => {
  it('reproduit le style technique de référence, sans émoji ni préfixe AD', () => {
    const out = render('direct', { ...DETAILED, direct: true });
    expect(out).toEqual({ name: 'lastAddon', description: '4K · BluRay REMUX · 54,2 Go · FraMeSToR' });
    expect(out.name + out.description).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(out.name).not.toContain('[AD');
  });

  it('vue minimale : résolution et source seules', () => {
    expect(render('direct', view({ resolutionLabel: '720p', direct: true }))).toEqual({
      name: 'lastAddon',
      description: '720p · WEB-DL',
    });
  });
});

describe('renderTemplate : identifiant inconnu', () => {
  it('refuse un gabarit hors liste', () => {
    expect(() => render('inconnu' as TemplateId, DETAILED)).toThrow('Gabarit inconnu');
  });
});
