import { describe, expect, it } from 'vitest';
import { chromeFor, nextPhase, shouldBeReady } from '../src/player/phase';

describe('états du lecteur : chargement → prêt', () => {
  it('ouverture : toujours en chargement ; prêt à la première image, puis stable', () => {
    expect(nextPhase('ready', 'open')).toBe('loading');
    expect(nextPhase('loading', 'open')).toBe('loading');
    expect(nextPhase('loading', 'media')).toBe('ready');
    expect(nextPhase('ready', 'media')).toBe('ready');
  });

  it('une nouvelle source (ou un échec) ramène en chargement', () => {
    let p = nextPhase('loading', 'media');
    expect(p).toBe('ready');
    p = nextPhase(p, 'open');
    expect(p).toBe('loading');
  });

  it('prêt seulement quand la durée est connue et que le tampon est rempli', () => {
    expect(shouldBeReady({ duration: 0, buffering: true })).toBe(false);
    expect(shouldBeReady({ duration: 1440, buffering: true })).toBe(false); // métadonnées lues, première image pas encore
    expect(shouldBeReady({ duration: 1440, buffering: false })).toBe(true);
    expect(shouldBeReady({ duration: 1440, buffering: false, paused: true })).toBe(true); // lecture automatique bloquée par le navigateur
    expect(shouldBeReady({ duration: 0, buffering: false })).toBe(false);
  });

  it('chargement : ni barre, ni boutons centraux, ni transport ; seulement la carte', () => {
    expect(chromeFor('loading', { duration: 0, buffering: true })).toEqual({ controls: false, centerButtons: false, spinner: 'card' });
    // Même si le moteur annonce déjà une durée, tant que la phase n'est pas « prête » rien d'autre ne s'affiche.
    expect(chromeFor('loading', { duration: 1440, buffering: false })).toEqual({ controls: false, centerButtons: false, spinner: 'card' });
  });

  it('tampon en cours de lecture : petit anneau, jamais superposé au gros bouton', () => {
    const c = chromeFor('ready', { duration: 1440, buffering: true, paused: false });
    expect(c).toEqual({ controls: true, centerButtons: false, spinner: 'small' });
    expect(c.centerButtons && c.spinner !== 'none').toBe(false);
  });

  it('prêt et sans tampon : contrôles complets, pas d’anneau', () => {
    expect(chromeFor('ready', { duration: 1440, buffering: false, paused: true })).toEqual({ controls: true, centerButtons: true, spinner: 'none' });
  });

  it('jamais d’anneau et de gros bouton en même temps, quel que soit l’état', () => {
    for (const phase of ['loading', 'ready'] as const) {
      for (const buffering of [true, false]) {
        const c = chromeFor(phase, { duration: 100, buffering });
        expect(c.centerButtons && c.spinner !== 'none').toBe(false);
      }
    }
  });
});
