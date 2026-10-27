import { describe, expect, it } from 'vitest';
import { isValidTimeZone, nextOccurrences, zonedToUtc, type SeriesRule } from '../src/user/evening-recurrence.js';

/** Heure murale `HH:MM` d'un instant dans `tz`, lue directement par Intl (sans passer par le module testé). */
function heureMurale(tz: string, ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

/** Dimanche 3 janvier 2027 à 20:30 CET (19:30 UTC) : ancre commune aux tests. */
const ANCRE = Date.UTC(2027, 0, 3, 19, 30);

/** Chaque dimanche à 20:30 à Paris, depuis l'ancre. */
const DIMANCHE_SOIR: SeriesRule = {
  tz: 'Europe/Paris',
  weekday: 0,
  localTime: '20:30',
  interval: 1,
  untilAt: null,
  anchorStartsAt: ANCRE,
};

describe('dates de référence des tests', () => {
  it('le 28 mars 2027 (changement d heure à Paris), le 31 octobre 2027 et le 3 janvier 2027 sont des dimanches', () => {
    expect(new Date(Date.UTC(2027, 2, 28)).getUTCDay()).toBe(0);
    expect(new Date(Date.UTC(2027, 9, 31)).getUTCDay()).toBe(0);
    expect(new Date(Date.UTC(2027, 0, 3)).getUTCDay()).toBe(0);
  });
});

describe('nextOccurrences : heure murale conservée au passage à l heure d été (Europe/Paris)', () => {
  it('printemps : 20:30 CET puis 20:30 CEST (19:30 UTC puis 18:30 UTC)', () => {
    const out = nextOccurrences(DIMANCHE_SOIR, Date.UTC(2027, 2, 21, 19, 30), 3);
    expect(out).toEqual([Date.UTC(2027, 2, 28, 18, 30), Date.UTC(2027, 3, 4, 18, 30), Date.UTC(2027, 3, 11, 18, 30)]);
    expect(out.map((t) => heureMurale('Europe/Paris', t))).toEqual(['20:30', '20:30', '20:30']);
  });

  it('automne : retour à 20:30 CET après le 31 octobre (19:30 UTC)', () => {
    const out = nextOccurrences(DIMANCHE_SOIR, Date.UTC(2027, 9, 24, 18, 30), 2);
    expect(out).toEqual([Date.UTC(2027, 9, 31, 19, 30), Date.UTC(2027, 10, 7, 19, 30)]);
    expect(out.map((t) => heureMurale('Europe/Paris', t))).toEqual(['20:30', '20:30']);
  });

  it('une série qui traverse les deux changements reste strictement croissante et à 20:30 locale', () => {
    const out = nextOccurrences(DIMANCHE_SOIR, Date.UTC(2027, 2, 1), 12);
    expect(out).toHaveLength(12);
    expect(out.slice(1).every((t, i) => t > out[i]!)).toBe(true);
    expect(out.map((t) => heureMurale('Europe/Paris', t)).every((h) => h === '20:30')).toBe(true);
    expect(out[11]).toBe(Date.UTC(2027, 4, 23, 18, 30));
  });
});

describe('nextOccurrences : intervalle et ancre', () => {
  it('interval 1 : chaque dimanche à partir d un instant en milieu de série', () => {
    const out = nextOccurrences(DIMANCHE_SOIR, Date.UTC(2027, 0, 10, 12, 0), 2);
    expect(out).toEqual([Date.UTC(2027, 0, 10, 19, 30), Date.UTC(2027, 0, 17, 19, 30)]);
  });

  it('interval 2 : une semaine sur deux, alignée sur l ancre (les dimanches 10 et 24 janvier sont sautés)', () => {
    const rule: SeriesRule = { ...DIMANCHE_SOIR, interval: 2 };
    const out = nextOccurrences(rule, Date.UTC(2027, 0, 4), 3);
    expect(out).toEqual([Date.UTC(2027, 0, 17, 19, 30), Date.UTC(2027, 0, 31, 19, 30), Date.UTC(2027, 1, 14, 19, 30)]);
  });

  it('interval 2 à travers le passage à l heure d été', () => {
    const rule: SeriesRule = { ...DIMANCHE_SOIR, interval: 2 };
    const out = nextOccurrences(rule, Date.UTC(2027, 2, 15), 2);
    expect(out).toEqual([Date.UTC(2027, 2, 28, 18, 30), Date.UTC(2027, 3, 11, 18, 30)]);
  });

  it('aucune occurrence avant l ancre, même si le jour de la règle précède l ancre dans sa semaine', () => {
    // Mercredi, alors que l ancre est un dimanche : la première occurrence est le mercredi 6 janvier.
    const rule: SeriesRule = { ...DIMANCHE_SOIR, weekday: 3 };
    const out = nextOccurrences(rule, 0, 2);
    expect(out).toEqual([Date.UTC(2027, 0, 6, 19, 30), Date.UTC(2027, 0, 13, 19, 30)]);
  });
});

describe('nextOccurrences : bornes from et untilAt', () => {
  it('from est exclusif : une occurrence exactement égale à from n est pas renvoyée', () => {
    const occurrence = Date.UTC(2027, 2, 14, 19, 30);
    expect(nextOccurrences(DIMANCHE_SOIR, occurrence, 1)).toEqual([Date.UTC(2027, 2, 21, 19, 30)]);
    expect(nextOccurrences(DIMANCHE_SOIR, occurrence - 1, 1)).toEqual([occurrence]);
  });

  it('untilAt est inclus : l occurrence exactement égale à untilAt est renvoyée, la suivante non', () => {
    const rule: SeriesRule = { ...DIMANCHE_SOIR, untilAt: Date.UTC(2027, 2, 21, 19, 30) };
    expect(nextOccurrences(rule, Date.UTC(2027, 2, 1), 10)).toEqual([
      Date.UTC(2027, 2, 7, 19, 30),
      Date.UTC(2027, 2, 14, 19, 30),
      Date.UTC(2027, 2, 21, 19, 30),
    ]);
  });

  it('untilAt une minute plus tôt : la dernière occurrence est exclue', () => {
    const rule: SeriesRule = { ...DIMANCHE_SOIR, untilAt: Date.UTC(2027, 2, 21, 19, 29) };
    expect(nextOccurrences(rule, Date.UTC(2027, 2, 1), 10)).toEqual([
      Date.UTC(2027, 2, 7, 19, 30),
      Date.UTC(2027, 2, 14, 19, 30),
    ]);
  });

  it('from postérieur à untilAt : aucune occurrence', () => {
    const rule: SeriesRule = { ...DIMANCHE_SOIR, untilAt: Date.UTC(2027, 2, 1) };
    expect(nextOccurrences(rule, Date.UTC(2027, 2, 2), 5)).toEqual([]);
  });
});

describe('nextOccurrences : validation', () => {
  it('n = 0 renvoie un tableau vide', () => {
    expect(nextOccurrences(DIMANCHE_SOIR, 0, 0)).toEqual([]);
  });

  it('fuseau invalide : lève une RangeError', () => {
    expect(() => nextOccurrences({ ...DIMANCHE_SOIR, tz: 'Mars/Olympus' }, 0, 3)).toThrow(RangeError);
  });

  it('heure locale hors format HH:MM : lève une RangeError', () => {
    expect(() => nextOccurrences({ ...DIMANCHE_SOIR, localTime: '24:00' }, 0, 1)).toThrow(RangeError);
  });
});

describe('isValidTimeZone', () => {
  it('accepte les fuseaux IANA connus', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('refuse les noms inconnus, la chaîne vide et les fuseaux mal orthographiés', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('Europe/Pariss')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('zonedToUtc', () => {
  it('heure normale : 20:30 CEST à Paris donne 18:30 UTC', () => {
    expect(zonedToUtc('Europe/Paris', 2027, 7, 15, 20, 30)).toBe(Date.UTC(2027, 6, 15, 18, 30));
  });

  it('heure absente au printemps : 02:30 le 28 mars 2027 à Paris donne 03:30 CEST (décalée de la durée du trou)', () => {
    const instant = zonedToUtc('Europe/Paris', 2027, 3, 28, 2, 30);
    expect(instant).toBe(Date.UTC(2027, 2, 28, 1, 30));
    expect(heureMurale('Europe/Paris', instant)).toBe('03:30');
  });

  it('heure ambiguë à l automne : 02:30 le 31 octobre 2027 à Paris donne la première occurrence (CEST)', () => {
    expect(zonedToUtc('Europe/Paris', 2027, 10, 31, 2, 30)).toBe(Date.UTC(2027, 9, 31, 0, 30));
  });

  it('fuseau sans heure d été : UTC et Asia/Tokyo gardent le même décalage toute l année', () => {
    expect(zonedToUtc('UTC', 2027, 1, 1, 0, 0)).toBe(Date.UTC(2027, 0, 1));
    expect(zonedToUtc('Asia/Tokyo', 2027, 1, 1, 9, 0)).toBe(Date.UTC(2027, 0, 1));
    expect(zonedToUtc('Asia/Tokyo', 2027, 7, 1, 9, 0)).toBe(Date.UTC(2027, 6, 1));
  });

  it('date inexistante : lève une RangeError', () => {
    expect(() => zonedToUtc('Europe/Paris', 2027, 2, 30, 12, 0)).toThrow(RangeError);
  });

  it('fuseau invalide : lève une RangeError', () => {
    expect(() => zonedToUtc('Mars/Olympus', 2027, 1, 1, 0, 0)).toThrow(RangeError);
  });
});
