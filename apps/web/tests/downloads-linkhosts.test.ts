// Hôtes des liens d'addon autorisés au transport web (ODY-204) : https public uniquement.
import { describe, expect, it } from 'vitest';
import { isAddonLinkUrl } from '../src/downloads/linkHosts';

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
