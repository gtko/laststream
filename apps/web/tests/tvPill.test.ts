// Pastille du haut du lecteur TV : « En direct » n'y figure plus (le badge DIRECT est dans la barre de contrôle).
import { describe, expect, it } from 'vitest';
import { initialStatus, pillView, reduceTvStatus } from '../src/ui/tvStatus.js';

const T0 = 1_000_000;
const sample = (state: ReturnType<typeof initialStatus>, now: number, time: number, hasVideo: boolean) =>
  reduceTvStatus(state, { type: 'sample', now, time, hasVideo, paused: false });

describe('pastille du haut (pillView)', () => {
  it('pendant une lecture OK, la pastille est masquée', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    s = sample(s, T0, 1, true);
    s = sample(s, T0 + 1000, 2, true);
    expect(s.phase).toBe('live');
    expect(pillView(s)).toEqual({ tone: '', text: '', reason: '', hidden: true });
  });

  it('attente, son seul et échec restent affichés', () => {
    const connecting = reduceTvStatus(initialStatus(), { type: 'connect' });
    expect(pillView(connecting).text).toBe('Connexion à la chaîne…');
    const audio = { phase: 'audio', time: 5, since: null, reason: '' };
    expect(pillView(audio).text).toBe("Son seul — pas d'image");
    const failed = reduceTvStatus(initialStatus(), { type: 'fail', reason: 'network' });
    expect(pillView(failed)).toMatchObject({ tone: 'error', text: 'Chaîne indisponible', reason: 'Problème réseau' });
  });
});
