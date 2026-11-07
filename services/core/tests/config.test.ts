import { describe, expect, it } from 'vitest';
import { decodeConfig, encodeConfig, ConfigDecodeError } from '../src/config/codec.js';
import { parseEnvFile } from '../src/config/secret.js';
import { ConfigValidationError, configJsonSchema, parseConfig } from '../src/config/schema.js';

const SECRET = 'test-secret-value';
const SAMPLE = {
  sources: [{ type: 'torznab', name: 'Indexeur', baseUrl: 'https://indexer.example.com/api', apiKey: 'API-KEY-XYZ' }],
};

describe('parseConfig (schéma)', () => {
  it('ajoute le 1440p aux listes enregistrées avant son apparition (2160p et 1080p sans 1440p)', () => {
    expect(parseConfig({ resolutions: { allowed: ['2160p', '1080p'] } }).resolutions.allowed).toEqual(['2160p', '1440p', '1080p']);
    expect(parseConfig({ resolutions: { allowed: ['2160p', '1080p', '720p', '480p', 'SD'] } }).resolutions.allowed).toEqual([
      '2160p', '1440p', '1080p', '720p', '480p', 'SD',
    ]);
  });

  it('laisse intactes les listes qui ne couvrent pas 2160p et 1080p, ou qui nomment déjà le 1440p', () => {
    expect(parseConfig({ resolutions: { allowed: ['1080p', '720p'] } }).resolutions.allowed).toEqual(['1080p', '720p']);
    expect(parseConfig({ resolutions: { allowed: ['2160p'] } }).resolutions.allowed).toEqual(['2160p']);
    expect(parseConfig({ resolutions: { allowed: ['2160p', '1080p', '1440p'] } }).resolutions.allowed).toEqual(['2160p', '1080p', '1440p']);
  });

  it('applique les défauts sur une configuration vide', () => {
    const config = parseConfig({});
    expect(config.languages).toEqual({ preferred: ['fr', 'multi'], acceptVostfr: true, fallbackToOthers: true });
    expect(config.resolutions.allowed).toEqual(['2160p', '1440p', '1080p', '720p', '480p', 'SD']);
    expect(config.resolutions.max).toBeUndefined();
    expect(config.excludedTags).toEqual(['CAM', 'TS', 'SCR']);
    expect(config.maxResults).toBe(60);
    expect(config.sources).toEqual([]);
    expect(config.onlyCached).toBe(false);
    expect(config.debrid).toBeUndefined();
  });

  it('accepte une source upstream et une source torznab valides', () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: 'https://up.example.com/stream' },
        { type: 'torznab', name: 'Torz', baseUrl: 'http://127.0.0.1:9117', apiKey: 'k', categories: [2000] },
      ],
      debrid: { service: 'alldebrid', apiKey: 'AD-KEY' },
    });
    expect(config.sources).toHaveLength(2);
    expect(config.debrid?.service).toBe('alldebrid');
  });

  it('rejette les valeurs invalides avec le chemin du champ', () => {
    expect(() => parseConfig({ maxResults: 0 })).toThrow(ConfigValidationError);
    try {
      parseConfig({ resolutions: { allowed: ['4K'] } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).issues.some((i) => i.startsWith('resolutions.allowed.0'))).toBe(true);
    }
  });

  it('rejette une URL non http(s), une source sans clé et un type de source inconnu', () => {
    expect(() => parseConfig({ sources: [{ type: 'upstream', name: 'x', url: 'ftp://a.example.com' }] })).toThrow(
      ConfigValidationError,
    );
    expect(() => parseConfig({ sources: [{ type: 'torznab', name: 'x', baseUrl: 'https://a.example.com' }] })).toThrow(
      ConfigValidationError,
    );
    expect(() => parseConfig({ sources: [{ type: 'inconnu', name: 'x' }] })).toThrow(ConfigValidationError);
  });

  it('rejette une plage de taille incohérente', () => {
    expect(() => parseConfig({ size: { minGb: 10, maxGb: 2 } })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ size: { perResolution: { '1080p': { minGb: 5, maxGb: 1 } } } })).toThrow(
      ConfigValidationError,
    );
  });

  it('ne renvoie jamais la valeur saisie dans le message d\'erreur', () => {
    try {
      parseConfig({ sources: [{ type: 'torznab', name: 'x', baseUrl: 'pas une url', apiKey: 'CLE-SECRETE-123' }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as Error).message).not.toContain('CLE-SECRETE-123');
      expect((err as Error).message).not.toContain('pas une url');
    }
  });

  it('expose un JSON schema de la configuration', () => {
    const schema = configJsonSchema();
    expect(schema).toHaveProperty('properties.sources');
    expect(schema).toHaveProperty('properties.maxResults');
  });
});

describe('codec (chiffrement des configurations)', () => {
  it('fait un aller-retour encode/decode', () => {
    const encoded = encodeConfig(SAMPLE, SECRET);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('API-KEY-XYZ');
    const decoded = decodeConfig(encoded, SECRET, { allowPlain: false });
    expect(decoded.sources[0]).toMatchObject({ type: 'torznab', apiKey: 'API-KEY-XYZ' });
    expect(decoded.maxResults).toBe(60);
  });

  it('produit un chiffré différent à chaque encodage (IV aléatoire)', () => {
    expect(encodeConfig(SAMPLE, SECRET)).not.toBe(encodeConfig(SAMPLE, SECRET));
  });

  it('refuse un secret différent', () => {
    const encoded = encodeConfig(SAMPLE, SECRET);
    expect(() => decodeConfig(encoded, 'autre-secret', { allowPlain: false })).toThrow(ConfigDecodeError);
  });

  it('rejette le JSON brut quand allowPlain est faux', () => {
    const plain = Buffer.from(JSON.stringify(SAMPLE)).toString('base64url');
    expect(() => decodeConfig(plain, SECRET, { allowPlain: false })).toThrow(ConfigDecodeError);
  });

  it('accepte le JSON brut quand allowPlain est vrai', () => {
    const plain = Buffer.from(JSON.stringify(SAMPLE)).toString('base64url');
    const decoded = decodeConfig(plain, SECRET, { allowPlain: true });
    expect(decoded.sources[0]).toMatchObject({ apiKey: 'API-KEY-XYZ' });
  });

  it('rejette une configuration altérée (GCM : tag et ciphertext)', () => {
    const encoded = encodeConfig(SAMPLE, SECRET);
    const bytes = Buffer.from(encoded, 'base64url');

    const tamperedCipher = Buffer.from(bytes);
    tamperedCipher[tamperedCipher.length - 1] = (tamperedCipher[tamperedCipher.length - 1] ?? 0) ^ 0x01;
    expect(() => decodeConfig(tamperedCipher.toString('base64url'), SECRET, { allowPlain: true })).toThrow(
      ConfigDecodeError,
    );

    const tamperedTag = Buffer.from(bytes);
    tamperedTag[12] = (tamperedTag[12] ?? 0) ^ 0x01;
    expect(() => decodeConfig(tamperedTag.toString('base64url'), SECRET, { allowPlain: false })).toThrow(
      ConfigDecodeError,
    );
  });

  it('ne fuite pas le contenu reçu dans l\'erreur de décodage', () => {
    const garbage = 'eyJzZWNyZXQiOiJTVVBFUlNFQ1JFVCJ9';
    try {
      decodeConfig(garbage, SECRET, { allowPlain: false });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigDecodeError);
      expect((err as Error).message).not.toContain(garbage);
    }
  });

  it('refuse d\'encoder une configuration invalide', () => {
    expect(() => encodeConfig({ maxResults: -1 }, SECRET)).toThrow(ConfigValidationError);
  });
});

describe('parseEnvFile', () => {
  it('lit KEY=VALUE, ignore commentaires et lignes vides, gère les guillemets', () => {
    const values = parseEnvFile(
      ['# commentaire', '', 'PORT=7311', 'export LASTADDON_SECRET="abc123"', "QUOTED='x y'", 'AVEC=val # note'].join('\n'),
    );
    expect(values).toEqual({ PORT: '7311', LASTADDON_SECRET: 'abc123', QUOTED: 'x y', AVEC: 'val' });
  });
});
