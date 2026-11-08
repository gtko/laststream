import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allowedOrigins,
  assertStartupEnv,
  configuredPublicUrl,
  configuredProbeHosts,
  DEFAULT_ALLOWED_ORIGINS,
  parsePublicUrl,
} from '../src/config/runtime-env.js';
import { MIN_SECRET_LENGTH } from '../src/config/secret.js';
import { envFilePath, getSecret } from '../src/platform/node/secret-file.js';
import { publicBaseUrl, type RequestLike } from '../src/routes/stream.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lastaddon-env-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Requête minimale pour publicBaseUrl. */
function fakeRequest(headers: Record<string, string>, protocol = 'http'): RequestLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url: `${protocol}://${lower.host ?? 'localhost'}/x`, header: (name: string) => lower[name.toLowerCase()] };
}

describe('LASTADDON_PUBLIC_URL : validation', () => {
  it('accepte http et https, sans slash final', () => {
    expect(parsePublicUrl('https://addon.example.com/')).toBe('https://addon.example.com');
    expect(parsePublicUrl('http://localhost:7000/base/')).toBe('http://localhost:7000/base');
  });

  it('refuse les autres schémas et les valeurs non URL, sans écho de la valeur', () => {
    expect(() => parsePublicUrl('ftp://addon.example.com')).toThrow('http et https');
    expect(() => parsePublicUrl('javascript:alert(1)')).toThrow('http et https');
    expect(() => parsePublicUrl('addon sans schéma')).toThrow('URL absolue attendue');
    try {
      parsePublicUrl('ftp://secret-host.example.com');
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-host');
    }
  });

  it('configuredPublicUrl : absent ou vide donne undefined, invalide lève', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    expect(configuredPublicUrl()).toBeUndefined();
    vi.stubEnv('LASTADDON_PUBLIC_URL', 'mailto:x@example.com');
    expect(() => configuredPublicUrl()).toThrow('LASTADDON_PUBLIC_URL invalide');
  });

  it('assertStartupEnv : valeur invalide refusée au démarrage', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', 'gopher://example.com');
    expect(() => assertStartupEnv()).toThrow('LASTADDON_PUBLIC_URL invalide');
  });

  it('assertStartupEnv : LASTADDON_PUBLIC=1 exige LASTADDON_PUBLIC_URL', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    vi.stubEnv('LASTADDON_PUBLIC', '1');
    expect(() => assertStartupEnv()).toThrow('LASTADDON_PUBLIC=1 exige LASTADDON_PUBLIC_URL');
    vi.stubEnv('LASTADDON_PUBLIC_URL', 'https://addon.example.com');
    expect(() => assertStartupEnv()).not.toThrow();
  });
});

describe('publicBaseUrl : en-têtes de la requête', () => {
  it('sans trust proxy : Host de la requête, X-Forwarded-* ignorés', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    vi.stubEnv('LASTADDON_TRUST_PROXY', '');
    const req = fakeRequest({ host: 'local.test:7000', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' });
    expect(publicBaseUrl(req)).toBe('http://local.test:7000');
  });

  it('avec LASTADDON_TRUST_PROXY=1 : X-Forwarded-Proto et Host respectés', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    vi.stubEnv('LASTADDON_TRUST_PROXY', '1');
    const req = fakeRequest({ host: 'local.test', 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' });
    expect(publicBaseUrl(req)).toBe('https://public.example');
  });

  it('LASTADDON_PUBLIC_URL prime sur les en-têtes, même avec trust proxy', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', 'https://configured.example/');
    vi.stubEnv('LASTADDON_TRUST_PROXY', '1');
    expect(publicBaseUrl(fakeRequest({ host: 'x', 'x-forwarded-host': 'evil.example' }))).toBe(
      'https://configured.example',
    );
  });

  it('mode public sans LASTADDON_PUBLIC_URL : jamais de repli sur Host', () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    vi.stubEnv('LASTADDON_PUBLIC', '1');
    expect(() => publicBaseUrl(fakeRequest({ host: 'attacker.example' }))).toThrow('LASTADDON_PUBLIC=1 exige');
  });
});

describe('getSecret : longueur minimale et emplacement du .env', () => {
  it(`refuse LASTADDON_SECRET de moins de ${MIN_SECRET_LENGTH} caractères, sans écho`, () => {
    vi.stubEnv('LASTADDON_SECRET', 'trop-court-secret');
    expect(() => getSecret(join(workDir, 'unused.env'))).toThrow(/32 caractères minimum/);
    try {
      getSecret(join(workDir, 'unused.env'));
    } catch (err) {
      expect((err as Error).message).not.toContain('trop-court-secret');
    }
  });

  it('accepte une valeur de 32 caractères', () => {
    const value = 'a'.repeat(MIN_SECRET_LENGTH);
    vi.stubEnv('LASTADDON_SECRET', value);
    expect(getSecret(join(workDir, 'unused.env'))).toBe(value);
  });

  it('refuse une valeur trop courte lue dans le .env', () => {
    const path = join(workDir, 'short.env');
    writeFileSync(path, 'LASTADDON_SECRET=abc123\n', 'utf8');
    vi.stubEnv('LASTADDON_SECRET', '');
    expect(() => getSecret(path)).toThrow(/32 caractères minimum/);
  });

  it('génère une clé de 32 octets en base64url, enregistrée dans le .env, puis réutilisée', () => {
    const path = join(workDir, 'generated.env');
    vi.stubEnv('LASTADDON_SECRET', '');
    const generated = getSecret(path);
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(generated, 'base64url')).toHaveLength(32);
    expect(readFileSync(path, 'utf8')).toBe(`LASTADDON_SECRET=${generated}\n`);
    expect(getSecret(path)).toBe(generated);
  });

  it('envFilePath pointe sur la racine du projet, indépendamment du répertoire courant', () => {
    expect(envFilePath()).toBe(join(PROJECT_ROOT, '.env'));
  });

  it('LASTADDON_ENV_FILE remplace le chemin du .env (absolu, ou relatif à la racine du projet)', () => {
    const absolute = join(workDir, 'app.env');
    vi.stubEnv('LASTADDON_ENV_FILE', absolute);
    expect(envFilePath()).toBe(absolute);
    vi.stubEnv('LASTADDON_ENV_FILE', 'config/prod.env');
    expect(envFilePath()).toBe(join(PROJECT_ROOT, 'config', 'prod.env'));
    vi.stubEnv('LASTADDON_ENV_FILE', '');
    expect(envFilePath()).toBe(join(PROJECT_ROOT, '.env'));
  });
});

describe('allowedOrigins', () => {
  it('valeurs par défaut quand la variable est absente ou vide', () => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', '');
    expect(allowedOrigins()).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(DEFAULT_ALLOWED_ORIGINS).toEqual(['http://localhost:8089', 'http://localhost:8080']);
  });

  it('liste séparée par des virgules, espaces tolérés', () => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', ' https://ui.example.test , http://localhost:9000,');
    expect(allowedOrigins()).toEqual(['https://ui.example.test', 'http://localhost:9000']);
  });
});

describe('configuredProbeHosts (PROBE_HOSTS)', () => {
  it('absente ou vide : ensemble vide, aucune sonde réseau', () => {
    vi.stubEnv('PROBE_HOSTS', '');
    expect(configuredProbeHosts()).toEqual(new Set());
    vi.stubEnv('PROBE_HOSTS', ' , ');
    expect(configuredProbeHosts()).toEqual(new Set());
  });

  it('liste séparée par des virgules, espaces tolérés, noms en minuscules', () => {
    vi.stubEnv('PROBE_HOSTS', 'a.example, B.example');
    expect(configuredProbeHosts()).toEqual(new Set(['a.example', 'b.example']));
  });
});
