// Lien de l'hôte : délai d'inactivité, coupure après 20 erreurs consécutives, plafond de débit montant partagé, codes d'erreur.
import { describe, expect, it } from 'vitest';
import { RangeClient } from './guest';
import { DEFAULT_UPLOAD_MBPS, RangeServer, UploadBudget, mbpsToBytesPerSec, type RangeSource } from './host';
import { memoryChannelPair } from './memory';
import { RelayError, encodeInfoReq, encodeReq } from './protocol';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const src: RangeSource = {
  size: async () => 1000,
  read: async (s, e) => new Uint8Array(e - s),
};

describe('lien hôte : délai d’inactivité', () => {
  it('sans message de l’invité pendant le délai : onIdle une fois', async () => {
    const [hostCh] = memoryChannelPair(0);
    let idle = 0;
    const server = new RangeServer(src, hostCh, { idleTimeoutMs: 30, onIdle: () => (idle += 1) });
    await wait(80);
    expect(idle).toBe(1);
    server.close();
  });

  it('chaque message de l’invité repousse le délai', async () => {
    const [hostCh, guestCh] = memoryChannelPair(0);
    let idle = 0;
    const server = new RangeServer(src, hostCh, { idleTimeoutMs: 40, onIdle: () => (idle += 1) });
    for (let i = 0; i < 5; i += 1) {
      guestCh.send(encodeInfoReq(i + 1));
      await wait(15);
    }
    expect(idle).toBe(0);
    server.close();
  });
});

describe('lien hôte : erreurs consécutives', () => {
  it('vingt erreurs de suite coupent le lien ; une requête valide remet le compteur à zéro', async () => {
    const [hostCh, guestCh] = memoryChannelPair(0);
    let abuse = 0;
    const server = new RangeServer(src, hostCh, { maxConsecutiveErrors: 20, onAbuse: () => (abuse += 1) });
    for (let i = 0; i < 19; i += 1) guestCh.send(encodeReq(i + 1, 10, 5)); // plage inversée : erreur
    await wait(10);
    expect(abuse).toBe(0);
    guestCh.send(encodeReq(100, 0, 10)); // requête valide servie : remise à zéro
    await wait(20);
    for (let i = 0; i < 19; i += 1) guestCh.send(encodeReq(200 + i, 10, 5));
    await wait(10);
    expect(abuse).toBe(0);
    guestCh.send(encodeReq(300, 10, 5));
    await wait(10);
    expect(abuse).toBe(1);
    server.close();
  });
});

describe('lien hôte : code d’erreur de la taille', () => {
  it.each(['unshareable', 'busy'] as const)('taille refusée en %s : l’invité reçoit ce code, pas source', async (code) => {
    const [hostCh, guestCh] = memoryChannelPair(0);
    const refused: RangeSource = {
      size: async () => {
        throw new RelayError(code);
      },
      read: async () => new Uint8Array(0),
    };
    const server = new RangeServer(refused, hostCh);
    const client = new RangeClient(guestCh, { retries: 0 });
    await expect(client.size()).rejects.toMatchObject({ code });
    client.close();
    server.close();
  });

  it('erreur quelconque de la source : code source, comme avant', async () => {
    const [hostCh, guestCh] = memoryChannelPair(0);
    const broken: RangeSource = {
      size: async () => {
        throw new Error('réseau');
      },
      read: async () => new Uint8Array(0),
    };
    const server = new RangeServer(broken, hostCh);
    const client = new RangeClient(guestCh, { retries: 0 });
    await expect(client.size()).rejects.toMatchObject({ code: 'source' });
    client.close();
    server.close();
  });
});

describe('plafond de débit montant', () => {
  it('60 Mb/s par défaut, exprimés en octets par seconde', () => {
    expect(DEFAULT_UPLOAD_MBPS).toBe(60);
    expect(mbpsToBytesPerSec(60)).toBe(7_500_000);
  });

  it('seau à jetons partagé : au-delà du rafale, le délai rattrape le débit', () => {
    let t = 0;
    const budget = new UploadBudget(1000, () => t, 1000);
    expect(budget.reserve(1000)).toBe(0);
    expect(budget.reserve(1000)).toBe(1000);
    t = 500;
    expect(budget.reserve(500)).toBe(1000);
  });
});
