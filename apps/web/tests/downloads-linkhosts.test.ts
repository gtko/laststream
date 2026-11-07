// Hôtes des liens d'addon autorisés au transport web (ODY-204) : https public uniquement.
import { describe, expect, it } from 'vitest';
import { isAddonLinkUrl, isNativeLinkUrl } from '../src/downloads/linkHosts';

const ok = (raw: string) => isAddonLinkUrl(new URL(raw));

describe('isAddonLinkUrl', () => {
  it('accepte un lien https vers un nom de domaine public', () => {
    expect(ok('https://cdn.exemple.com/f.mkv')).toBe(true);
  });

  it('refuse http (même vers un domaine public)', () => {
    expect(ok('http://cdn.exemple.com/f.mkv')).toBe(false);
  });

  it('refuse les adresses IPv4 littérales, y compris locales', () => {
    expect(ok('https://127.0.0.1/')).toBe(false);
    expect(ok('https://192.168.1.2/')).toBe(false);
    expect(ok('https://8.8.8.8/f.mkv')).toBe(false);
  });

  it('refuse les adresses IPv6 littérales', () => {
    expect(ok('https://[::1]/')).toBe(false);
    expect(ok('https://[2001:db8::1]/f.mkv')).toBe(false);
  });

  it('refuse localhost, y compris avec un point final', () => {
    expect(ok('https://localhost/')).toBe(false);
    expect(ok('https://localhost./')).toBe(false);
  });

  it('refuse les noms locaux (.local, .internal, .localhost)', () => {
    expect(ok('https://nas.local/')).toBe(false);
    expect(ok('https://svc.internal/f.mkv')).toBe(false);
    expect(ok('https://app.localhost/')).toBe(false);
  });

  it('refuse les hôtes sans point (nom de machine du réseau)', () => {
    expect(ok('https://nas/f.mkv')).toBe(false);
  });
});

describe('isNativeLinkUrl (transfert natif, ODY-232)', () => {
  const native = (raw: string) => isNativeLinkUrl(new URL(raw));

  it('accepte https vers un domaine public, port par défaut ou 443 explicite', () => {
    expect(native('https://cdn.exemple.com/f.mkv')).toBe(true);
    expect(native('https://cdn.exemple.com:443/f.mkv')).toBe(true);
  });

  it('refuse http, même vers un domaine public', () => {
    expect(native('http://cdn.exemple.com/f.mkv')).toBe(false);
    expect(native('http://cdn.exemple.com:80/f.mkv')).toBe(false);
  });

  it('refuse IP privées, loopback, lien local, IPv6 et noms locaux', () => {
    for (const raw of [
      'https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.1.2/f.mkv', 'https://172.16.0.1/',
      'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/', 'https://[::1]/', 'https://[fe80::1]/', 'https://[fd00::1]/',
      'https://localhost/', 'https://nas.local/', 'https://svc.internal/', 'https://nas/f.mkv',
    ]) {
      expect(native(raw), raw).toBe(false);
    }
  });

  it('refuse les écritures détournées d’une adresse locale (décimal, hexadécimal, octal)', () => {
    for (const raw of ['https://2130706433/', 'https://0x7f000001/', 'https://0x7f.0.0.1/', 'https://0177.0.0.1/', 'https://127.1/']) {
      expect(native(raw), raw).toBe(false);
    }
  });

  it('refuse un port inattendu', () => {
    for (const raw of ['https://cdn.exemple.com:8443/f.mkv', 'https://cdn.exemple.com:22/', 'https://cdn.exemple.com:80/']) {
      expect(native(raw), raw).toBe(false);
    }
  });

  it('refuse les identifiants dans l’URL et les autres schémas', () => {
    expect(native('https://user:pass@cdn.exemple.com/f.mkv')).toBe(false);
    expect(native('https://user@cdn.exemple.com/f.mkv')).toBe(false);
    expect(native('ftp://cdn.exemple.com/f.mkv')).toBe(false);
    expect(native('file:///etc/passwd')).toBe(false);
  });
});
