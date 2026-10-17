import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUrlSigner } from '../src/lt/signing.js';
import { fakeLookup, fullToken, SECRET, startApp, tokenFor, type RunningApp } from './lt-harness.js';

const signer = createUrlSigner(SECRET);
const STREAM = 'https://stream.example.fr/live/index.m3u8';

describe('signeur des URL HLS', () => {
  it('déterministe pour une même configuration et une même URL', () => {
    const token = tokenFor({});
    expect(signer.sign(token, STREAM)).toBe(signer.sign(token, STREAM));
    expect(signer.sign(token, STREAM)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('liée à la configuration et à l URL : changer l une ou l autre invalide la signature', () => {
    const token = tokenFor({});
    const sig = signer.sign(token, STREAM);
    expect(signer.verify(token, STREAM, sig)).toBe(true);
    expect(signer.verify(tokenFor({ tmdbToken: 'autre' }), STREAM, sig)).toBe(false);
    expect(signer.verify(token, `${STREAM}?x=1`, sig)).toBe(false);
  });

  it('refuse une signature absente, vide, de mauvaise longueur ou fausse', () => {
    const token = tokenFor({});
    const sig = signer.sign(token, STREAM);
    expect(signer.verify(token, STREAM, null)).toBe(false);
    expect(signer.verify(token, STREAM, '')).toBe(false);
    expect(signer.verify(token, STREAM, sig.slice(0, 10))).toBe(false);
    expect(signer.verify(token, STREAM, sig.replace(/.$/, sig.endsWith('A') ? 'B' : 'A'))).toBe(false);
  });

  it('dérivée du secret : un autre LASTADDON_SECRET ne valide pas la signature', () => {
    const token = tokenFor({});
    const other = createUrlSigner(`${SECRET}-autre`);
    expect(other.verify(token, STREAM, signer.sign(token, STREAM))).toBe(false);
  });
});

describe('rebinding DNS sur le proxy HLS : connexion réelle, DNS simulé', () => {
  let server: Server;
  let port: number;
  let hits = 0;
  let app: RunningApp;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.end('#EXTM3U\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    // Pas de fetch injecté : la requête part réellement, seule la résolution DNS est simulée.
    app = await startApp({ lookupHost: fakeLookup({ 'rebind.example.fr': '127.0.0.1' }) });
  });

  afterAll(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('URL signée dont le nom résout vers une adresse privée : 403 host_not_allowed, aucune requête reçue', async () => {
    const token = fullToken();
    const url = `http://rebind.example.fr:${port}/sport.m3u8`;
    const res = await fetch(`${app.baseUrl}/${token}/lt/tv/hls?u=${encodeURIComponent(url)}&s=${signer.sign(token, url)}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'host_not_allowed' });
    expect(hits).toBe(0);
  });
});
