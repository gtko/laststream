// Présentation des téléchargements (ODY-204) : fonctions pures, textes français, aucune URL dans les messages.
import { describe, expect, it } from 'vitest';
import type { DownloadErrorCode, DownloadItem, SpaceInfo } from '../src/downloads/types';
import { buttonState, errorMessage, formatBytes, gauge, itemPercent, itemSubtitle } from '../src/downloads/viewModel';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const OK = { ok: true as const };

const item = (over: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'movie:1',
  metaId: 'movie:1',
  title: 'Film',
  source: { copies: [] },
  state: 'pending',
  bytesDone: 0,
  attempts: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('formatBytes', () => {
  it('écrit les tailles en français, base 1024', () => {
    expect(formatBytes(1.4 * GB)).toBe('1,4 Go');
    expect(formatBytes(820 * MB)).toBe('820 Mo');
    expect(formatBytes(2 * GB)).toBe('2 Go');
    expect(formatBytes(0)).toBe('0 o');
  });

  it('ne montre jamais « 1024 Mo » : l’arrondi passe à l’unité suivante', () => {
    expect(formatBytes(1023.6 * MB)).toBe('1 Go');
  });
});

describe('espace', () => {
  it('niveaux ok, warn (90 %) et full (100 %)', () => {
    const at = (used: number): SpaceInfo => ({ used, limit: 10 * GB, ratio: used / (10 * GB), warn: used / (10 * GB) >= 0.9, full: used >= 10 * GB });
    expect(gauge(at(5 * GB))).toEqual({ percent: 50, label: '5 Go sur 10 Go', level: 'ok' });
    expect(gauge(at(9.5 * GB)).level).toBe('warn');
    expect(gauge(at(10 * GB))).toMatchObject({ percent: 100, level: 'full' });
  });

  it('sans limite : pas de pourcentage, libellé « utilisés »', () => {
    expect(gauge({ used: 1.5 * GB, limit: null, ratio: null, warn: false, full: false })).toEqual({ percent: 0, label: '1,5 Go utilisés', level: 'ok' });
  });
});

describe('messages d’erreur', () => {
  it('chaque code a un message français, sans URL ni clé', () => {
    const codes: DownloadErrorCode[] = ['link_expired', 'resolve_failed', 'account', 'content', 'network', 'range_mismatch', 'quota_exceeded', 'store_full', 'store_failed', 'cancelled'];
    for (const code of codes) {
      const message = errorMessage(code);
      expect(message.length).toBeGreaterThan(5);
      expect(message).not.toMatch(/https?:|apikey/i);
    }
  });
});

describe('bouton de la fiche', () => {
  it('plateforme indisponible : raison affichée', () => {
    expect(buttonState(undefined, { ok: false, reason: 'Bientôt disponible sur Windows' })).toEqual({
      state: 'unavailable', label: 'Indisponible', percent: null, reason: 'Bientôt disponible sur Windows',
    });
  });

  it('sans téléchargement : proposer', () => {
    expect(buttonState(undefined, OK)).toMatchObject({ state: 'available', label: 'Télécharger' });
  });

  it('en cours : pourcentage dans le libellé', () => {
    expect(buttonState(item({ state: 'running', bytesDone: 50, bytesTotal: 100 }), OK)).toMatchObject({ state: 'running', label: 'Téléchargement 50 %', percent: 50 });
  });

  it('terminé : 100 %', () => {
    expect(buttonState(item({ state: 'done' }), OK)).toMatchObject({ state: 'done', percent: 100 });
  });

  it('échec : le message de l’erreur, sans URL', () => {
    expect(buttonState(item({ state: 'error', error: { code: 'quota_exceeded' } }), OK)).toMatchObject({ state: 'error', reason: errorMessage('quota_exceeded') });
  });
});

describe('avancement et sous-titre', () => {
  it('pourcentage inconnu sans taille totale, tronqué sinon', () => {
    expect(itemPercent(item({ state: 'running', bytesDone: 10 }))).toBeNull();
    expect(itemPercent(item({ state: 'running', bytesDone: 1, bytesTotal: 3 }))).toBe(33);
  });

  it('sous-titre d’épisode avec les tailles', () => {
    expect(itemSubtitle(item({ season: 1, episode: 3, bytesDone: 1.2 * GB, bytesTotal: 2.4 * GB }))).toBe('S1 É3 · 1,2 Go sur 2,4 Go');
  });

  it('avant le premier octet : taille estimée', () => {
    expect(itemSubtitle(item({ estimatedSize: 2 * GB }))).toBe('environ 2 Go');
  });
});
