import { describe, expect, it } from 'vitest';
import { isIpLiteral, isLocalName, reduceHost, scrubPath } from '../src/scrub.js';

describe('isIpLiteral', () => {
  it.each([['192.168.1.5', true], ['8.8.8.8', true], ['[::1]', true], ['example.com', false], ['1.2.3.example.com', false]])('%s -> %s', (host, ok) => {
    expect(isIpLiteral(host)).toBe(ok);
  });
});

describe('isLocalName', () => {
  it.each([['localhost', true], ['nas.local', true], ['example.com', false]])('%s -> %s', (host, ok) => {
    expect(isLocalName(host)).toBe(ok);
  });
});

describe('reduceHost', () => {
  it('adresse littérale', () => expect(reduceHost(new URL('http://10.0.0.1:8080/x'))).toBe('[ip]'));
  it('IPv6', () => expect(reduceHost(new URL('http://[::1]:3000/'))).toBe('[ip]'));
  it('nom local', () => expect(reduceHost(new URL('http://localhost:3000/'))).toBe('[host]'));
  it('hôte inconnu', () => expect(reduceHost(new URL('https://addon.example.org/manifest.json'))).toBe('[host]'));
  it('hôte autorisé : origine seule', () => expect(reduceHost(new URL('https://api.themoviedb.org/3/movie/1?api_key=x'))).toBe('https://api.themoviedb.org'));
  it('workers.dev du projet', () => expect(reduceHost(new URL('https://lastaddon-core.gtux-prog.workers.dev/p/abc'))).toBe('https://lastaddon-core.gtux-prog.workers.dev'));
  it('stremio: sur un hôte autorisé garde le protocole', () => expect(reduceHost(new URL('stremio://v3-cinemeta.strem.io/manifest.json'))).toBe('stremio://v3-cinemeta.strem.io'));
});

describe('scrubPath', () => {
  it('masque les segments de plus de 40 caractères', () => {
    expect(scrubPath(`/a/${'x'.repeat(41)}/manifest.json`)).toBe('/a/[config]/manifest.json');
  });
  it('garde un segment de 40 caractères', () => {
    const seg = 'y'.repeat(40);
    expect(scrubPath(`/${seg}`)).toBe(`/${seg}`);
  });
});
