// Rapport de tampon de l'invité (watch party) : attente au démarrage et après un saut, reprise au seuil du salon,
// sous-alimentation avec hystérésis, fin de fichier, battement sans spam et arrêt du lecteur. Horloge factice (ms).
import { describe, expect, it } from 'vitest';
import {
  BUFFER_REPORT_MS,
  BUFFER_UNDERRUN_SEC,
  createBufferReporter,
  isUnderrun,
  readyThreshold,
  type BufferUpdate,
} from '../src/party/guestbuffer';
import { PARTY_RESUME_AHEAD_SEC } from '../src/party/protocol';

function setup() {
  let now = 0;
  const sent: Array<[boolean, number]> = [];
  const reporter = createBufferReporter({ send: (ready, ahead) => sent.push([ready, ahead]), now: () => now });
  return {
    reporter,
    sent,
    /** Avance l'horloge (ms) sans rien envoyer. */
    advance: (ms: number) => {
      now += ms;
    },
    /** Met à jour le lecteur (valeurs par défaut : en lecture, pas de saut). */
    update: (patch: Partial<BufferUpdate>) => {
      reporter.update({ ahead: 0, playing: true, seeking: false, ...patch });
    },
  };
}

describe('constantes', () => {
  it('sous-alimentation à 2 s et battement à 2 s', () => {
    expect(BUFFER_UNDERRUN_SEC).toBe(2);
    expect(BUFFER_REPORT_MS).toBe(2000);
  });
});

describe('createBufferReporter : démarrage', () => {
  it('annonce tout de suite l’attente (ready=false, 0 s de tampon)', () => {
    const { sent } = setup();
    expect(sent).toEqual([[false, 0]]);
  });

  it('se tait sous le seuil, puis annonce prêt une seule fois au seuil du salon', () => {
    const { update, sent } = setup();
    update({ ahead: 9.5, playing: false });
    expect(sent).toEqual([[false, 0]]);
    update({ ahead: PARTY_RESUME_AHEAD_SEC, playing: false });
    expect(sent).toEqual([[false, 0], [true, PARTY_RESUME_AHEAD_SEC]]);
    update({ ahead: 30, playing: true });
    expect(sent).toHaveLength(2);
  });

  it('utilise le seuil de reprise du salon (resumeAhead) quand il est fourni', () => {
    const { update, sent } = setup();
    update({ ahead: 4, resumeAhead: 4 });
    expect(sent).toEqual([[false, 0], [true, 4]]);
  });

  it('sans seuil du salon : PARTY_RESUME_AHEAD_SEC', () => {
    expect(readyThreshold({})).toBe(PARTY_RESUME_AHEAD_SEC);
    expect(readyThreshold({ resumeAhead: 6 })).toBe(6);
  });

  it('battement tant qu’il attend : un envoi toutes les 2 s, pas avant', () => {
    const { update, advance, sent } = setup();
    for (let i = 0; i < 5; i += 1) {
      advance(1000);
      update({ ahead: 3, playing: false });
    }
    // Annonce initiale à 0 s, puis battements à 2 s et 4 s.
    expect(sent).toEqual([[false, 0], [false, 3], [false, 3]]);
  });

  it('valeur de tampon non finie : traitée comme 0', () => {
    const { update, advance, sent } = setup();
    advance(BUFFER_REPORT_MS);
    update({ ahead: Number.NaN, playing: false });
    expect(sent).toEqual([[false, 0], [false, 0]]);
  });
});

describe('createBufferReporter : saut local et reconnexion', () => {
  it('reset() repart en attente tout de suite, puis reprend au seuil', () => {
    const { reporter, update, sent } = setup();
    update({ ahead: 20 });
    expect(sent.at(-1)).toEqual([true, 20]);

    reporter.reset();
    expect(sent.at(-1)).toEqual([false, 0]);

    update({ ahead: 9, playing: false });
    expect(sent.at(-1)).toEqual([false, 0]);
    update({ ahead: 10, playing: false });
    expect(sent.at(-1)).toEqual([true, 10]);
  });
});

describe('createBufferReporter : saut en cours', () => {
  it('pas d’état prêt pendant le saut, puis reprise une fois le saut résolu', () => {
    const { update, sent } = setup();
    update({ ahead: 20 });
    update({ ahead: 30, seeking: true });
    expect(sent.at(-1)).toEqual([false, 30]);
    const count = sent.length;
    update({ ahead: 30, seeking: true });
    expect(sent).toHaveLength(count);

    update({ ahead: 30, seeking: false });
    expect(sent.at(-1)).toEqual([true, 30]);
  });
});

describe('createBufferReporter : sous-alimentation pendant la lecture', () => {
  it('sous 2 s de tampon pendant la lecture : repasse en attente, avec hystérésis', () => {
    const { update, sent } = setup();
    update({ ahead: 20 });
    update({ ahead: 1.5, playing: true });
    expect(sent.at(-1)).toEqual([false, 1.5]);

    // Entre 2 s et le seuil : toujours en attente, rien n’est renvoyé.
    const count = sent.length;
    update({ ahead: 5, playing: true });
    expect(sent).toHaveLength(count);

    update({ ahead: 10, playing: true });
    expect(sent.at(-1)).toEqual([true, 10]);
  });

  it('en pause, un tampon faible ne compte pas', () => {
    const { update, sent } = setup();
    update({ ahead: 20 });
    update({ ahead: 0.5, playing: false });
    expect(sent).toEqual([[false, 0], [true, 20]]);
  });

  it('isUnderrun : seulement en lecture, sous 2 s, et sans fin de média déjà couverte', () => {
    expect(isUnderrun({ ahead: 1, playing: true })).toBe(true);
    expect(isUnderrun({ ahead: 1, playing: false })).toBe(false);
    expect(isUnderrun({ ahead: 2, playing: true })).toBe(false);
    expect(isUnderrun({ ahead: 1, playing: true, remaining: 1 })).toBe(false);
    expect(isUnderrun({ ahead: 0, playing: true, remaining: 0 })).toBe(false);
  });
});

describe('createBufferReporter : fin de fichier', () => {
  it('reste sous 10 s mais couvre la fin : prêt dès que le tampon atteint la durée restante', () => {
    const { reporter, update, sent } = setup();
    reporter.reset();
    update({ ahead: 3, remaining: 4, playing: false });
    expect(sent.at(-1)).toEqual([false, 0]);
    update({ ahead: 3.9, remaining: 4, playing: false });
    expect(sent.at(-1)).toEqual([true, 3.9]);
  });

  it('fin de média atteinte (durée restante nulle) : prêt sans attendre de tampon', () => {
    const { update, sent } = setup();
    update({ ahead: 0, remaining: 0, playing: true });
    expect(sent).toEqual([[false, 0], [true, 0]]);
  });

  it('une lecture près de la fin ne repasse pas en attente faute de tampon', () => {
    const { update, sent } = setup();
    update({ ahead: 0.8, remaining: 0.8, playing: true });
    expect(sent.at(-1)).toEqual([true, 0.8]);
    const count = sent.length;
    update({ ahead: 0.8, remaining: 0.8, playing: true });
    expect(sent).toHaveLength(count);
  });

  it('readyThreshold réduit à la durée restante quand elle est plus courte que le seuil', () => {
    expect(readyThreshold({ remaining: 4 })).toBe(4);
    expect(readyThreshold({ remaining: 40 })).toBe(PARTY_RESUME_AHEAD_SEC);
  });
});

describe('createBufferReporter : pas de spam', () => {
  it('lecture stable : aucun envoi supplémentaire, même sur de nombreuses mises à jour', () => {
    const { update, advance, sent } = setup();
    update({ ahead: 20 });
    const count = sent.length;
    for (let i = 0; i < 30; i += 1) {
      advance(1000);
      update({ ahead: 20 - i * 0.1 });
    }
    expect(sent).toHaveLength(count);
  });
});

describe('createBufferReporter : arrêt du lecteur', () => {
  it('stop() pendant l’attente libère le salon : ready=true, dernier tampon connu', () => {
    const { reporter, update, sent } = setup();
    update({ ahead: 4 });
    reporter.stop();
    expect(sent.at(-1)).toEqual([true, 4]);
  });

  it('stop() après la reprise : rien à libérer, rien n’est envoyé', () => {
    const { reporter, update, sent } = setup();
    update({ ahead: 20 });
    const count = sent.length;
    reporter.stop();
    expect(sent).toHaveLength(count);
  });

  it('après stop(), update et reset sont sans effet', () => {
    const { reporter, update, sent } = setup();
    reporter.stop();
    const count = sent.length;
    update({ ahead: 20 });
    reporter.reset();
    expect(sent).toHaveLength(count);
  });
});
