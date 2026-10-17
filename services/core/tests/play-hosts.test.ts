import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST_DOWN_MS, HostHealth, hostFromUrl, normalizeHost } from '../src/play/hosts.js';

const clock = (start = 10_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

describe('hostFromUrl', () => {
  it('extrait le nom d hôte d une URL http(s), en minuscules, sans port ni chemin', () => {
    expect(hostFromUrl('https://Cdn.Example.COM:8443/path/file.mkv?token=1')).toBe('cdn.example.com');
    expect(hostFromUrl('http://files.example.org/a')).toBe('files.example.org');
  });

  it('renvoie undefined pour une URL invalide, un autre schéma ou une URL sans hôte', () => {
    expect(hostFromUrl('pas une url')).toBeUndefined();
    expect(hostFromUrl('')).toBeUndefined();
    expect(hostFromUrl('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567')).toBeUndefined();
    expect(hostFromUrl('ftp://files.example.org/x')).toBeUndefined();
    expect(hostFromUrl('file:///etc/passwd')).toBeUndefined();
  });

  it('garde les IPv6 entre crochets tels que URL les fournit', () => {
    expect(hostFromUrl('http://[2001:db8::1]:8080/x')).toBe('[2001:db8::1]');
  });
});

describe('normalizeHost', () => {
  it('supprime les espaces, passe en minuscules et retire le point final ; vide renvoie undefined', () => {
    expect(normalizeHost('  Host.Example.COM. ')).toBe('host.example.com');
    expect(normalizeHost('   ')).toBeUndefined();
    expect(normalizeHost('.')).toBeUndefined();
  });
});

describe('HostHealth', () => {
  it('un hôte inconnu n est pas indisponible', () => {
    const health = new HostHealth({ now: clock().now });
    expect(health.isDown('host.example.com')).toBe(false);
  });

  it('markDown rend l hôte indisponible pendant downMs, puis il redevient utilisable', () => {
    const t = clock();
    const health = new HostHealth({ downMs: 60_000, now: t.now });
    health.markDown('host.example.com');
    t.advance(59_999);
    expect(health.isDown('host.example.com')).toBe(true);
    t.advance(1);
    expect(health.isDown('host.example.com')).toBe(false);
  });

  it('la durée par défaut est une heure', () => {
    expect(DEFAULT_HOST_DOWN_MS).toBe(3_600_000);
    const t = clock();
    const health = new HostHealth({ now: t.now });
    health.markDown('host.example.com');
    t.advance(3_599_999);
    expect(health.isDown('host.example.com')).toBe(true);
    t.advance(1);
    expect(health.isDown('host.example.com')).toBe(false);
  });

  it('compare les hôtes après normalisation (casse, point final, espaces)', () => {
    const health = new HostHealth({ now: clock().now });
    health.markDown('  HOST.example.com.');
    expect(health.isDown('host.example.com')).toBe(true);
    expect(health.isDown('Host.Example.com')).toBe(true);
    expect(health.isDown('other.example.com')).toBe(false);
  });

  it('un hôte vide n est jamais marqué ni indisponible', () => {
    const health = new HostHealth({ now: clock().now });
    health.markDown('  ');
    expect(health.isDown('  ')).toBe(false);
    expect(health.purge()).toBe(0);
  });

  it('une nouvelle panne prolonge la durée à partir de l instant du nouveau signalement', () => {
    const t = clock();
    const health = new HostHealth({ downMs: 1_000, now: t.now });
    health.markDown('host.example.com');
    t.advance(800);
    health.markDown('host.example.com');
    t.advance(800);
    expect(health.isDown('host.example.com')).toBe(true);
    t.advance(200);
    expect(health.isDown('host.example.com')).toBe(false);
  });

  it('purge retire les marques échues et renvoie leur nombre', () => {
    const t = clock();
    const health = new HostHealth({ downMs: 1_000, now: t.now });
    health.markDown('a.example.com');
    t.advance(500);
    health.markDown('b.example.com');
    t.advance(600);
    expect(health.purge()).toBe(1);
    expect(health.isDown('a.example.com')).toBe(false);
    expect(health.isDown('b.example.com')).toBe(true);
    t.advance(500);
    expect(health.purge()).toBe(1);
    expect(health.purge()).toBe(0);
  });

  it('refuse une durée non positive', () => {
    expect(() => new HostHealth({ downMs: 0 })).toThrow(RangeError);
    expect(() => new HostHealth({ downMs: -5 })).toThrow(RangeError);
  });
});
