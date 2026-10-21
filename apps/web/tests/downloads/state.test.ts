// Machine d'états des téléchargements : transitions autorisées, interdites, copie et effacement de l'erreur.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidTransitionError, TRANSITIONS, canTransition, transition } from '../../src/downloads/state';
import type { DownloadItem, DownloadState } from '../../src/downloads/types';

const STATES: DownloadState[] = ['pending', 'running', 'paused', 'done', 'error'];

const ALLOWED: Array<[DownloadState, DownloadState]> = [
  ['pending', 'running'],
  ['pending', 'paused'],
  ['running', 'paused'],
  ['running', 'done'],
  ['running', 'error'],
  ['running', 'pending'],
  ['paused', 'pending'],
  ['error', 'pending'],
];

function item(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'tt1:1:2',
    metaId: 'tt1',
    title: 'Série',
    season: 1,
    episode: 2,
    source: { copies: [{ infoHash: 'a'.repeat(40), fileIdx: 0 }] },
    state: 'pending',
    bytesDone: 0,
    attempts: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TRANSITIONS et canTransition', () => {
  it('la table contient exactement les transitions prévues', () => {
    expect(TRANSITIONS).toEqual({
      pending: ['running', 'paused'],
      running: ['paused', 'done', 'error', 'pending'],
      paused: ['pending'],
      error: ['pending'],
      done: [],
    });
  });

  it('matrice complète des 25 couples : seuls les couples prévus sont autorisés', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const expected = ALLOWED.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('done est terminal : aucune sortie', () => {
    for (const to of STATES) expect(canTransition('done', to)).toBe(false);
  });
});

describe('transition', () => {
  it('une transition autorisée renvoie un nouvel objet dans l\'état cible', () => {
    const before = item();
    const after = transition(before, 'running', {}, 5000);
    expect(after).not.toBe(before);
    expect(after.state).toBe('running');
    expect(after.updatedAt).toBe(5000);
  });

  it('ne modifie jamais l\'objet d\'origine', () => {
    const before = item({ error: { code: 'network' } });
    const snapshot = structuredClone(before);
    transition(before, 'paused', { bytesDone: 10 }, 9000);
    expect(before).toEqual(snapshot);
  });

  it('applique le patch et conserve les autres champs', () => {
    const before = item({ estimatedSize: 42 });
    const after = transition(before, 'running', { bytesDone: 7, filename: 'a.mkv' }, 2000);
    expect(after.bytesDone).toBe(7);
    expect(after.filename).toBe('a.mkv');
    expect(after.estimatedSize).toBe(42);
    expect(after.source).toEqual(before.source);
    expect(after.createdAt).toBe(1000);
  });

  it('sans `now`, updatedAt vaut l\'horloge', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    expect(transition(item(), 'running').updatedAt).toBe(123456);
  });

  it('efface `error` à la transition, sauf si le patch fournit une erreur', () => {
    const failed = item({ state: 'error', error: { code: 'network', message: 'coupure' } });

    const retried = transition(failed, 'pending', {}, 3000);
    expect('error' in retried).toBe(false);

    const again = transition(item({ state: 'running' }), 'error', { error: { code: 'account' } }, 3000);
    expect(again.error).toEqual({ code: 'account' });
  });

  it('le patch ne peut pas remplacer l\'état cible', () => {
    const after = transition(item(), 'paused', { state: 'done' } as Partial<DownloadItem>, 1);
    expect(after.state).toBe('paused');
  });

  it('une transition interdite lève InvalidTransitionError et ne renvoie rien', () => {
    const done = item({ state: 'done' });
    expect(() => transition(done, 'pending')).toThrow(InvalidTransitionError);
    expect(() => transition(done, 'running')).toThrow(InvalidTransitionError);
    expect(() => transition(item(), 'done')).toThrow(InvalidTransitionError);
    expect(() => transition(item({ state: 'paused' }), 'running')).toThrow(InvalidTransitionError);
  });

  it('InvalidTransitionError porte les états et un nom de classe', () => {
    try {
      transition(item({ state: 'done' }), 'running');
      expect.unreachable('la transition aurait dû échouer');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect(err).toBeInstanceOf(Error);
      expect((err as InvalidTransitionError).from).toBe('done');
      expect((err as InvalidTransitionError).to).toBe('running');
      expect((err as Error).name).toBe('InvalidTransitionError');
    }
  });

  it('un cycle complet pending → running → paused → pending → running → done est valide', () => {
    let cur = item();
    cur = transition(cur, 'running', {}, 1);
    cur = transition(cur, 'paused', {}, 2);
    cur = transition(cur, 'pending', {}, 3);
    cur = transition(cur, 'running', {}, 4);
    cur = transition(cur, 'done', {}, 5);
    expect(cur.state).toBe('done');
    expect(cur.updatedAt).toBe(5);
  });
});
