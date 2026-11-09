// Accueil social (LAST-193) : amis qui veulent voir un titre, soirée proposée, formats de la ligne du héros.
import { afterEach, describe, expect, it } from 'vitest';
import { initialSocialState, type SocialState } from '../src/data/socialStore';
import { circleOf, eveningDay, eveningFor, eveningTime, friendName, hasEveningJoin, joinEvening, setEveningJoin, setEveningSource, wantNames, wantVerb, wantersOf, WANT_WINDOW_MS } from '../src/data/homeSocial';

const NOW = 1_800_000_000_000;
const friend = (pid: string, name: string, extra: Record<string, unknown> = {}) => ({
  pid, handle: { name, tag: 'A7K2', full: name + '#A7K2' }, avatarColor: '#3b82f6', household: false, status: 'online', favorite: false, muted: false, ...extra,
});
const act = (pid: string, kind: string, tmdbId: number, at = NOW - 1000) => ({
  id: pid + kind + tmdbId, pid, handle: { name: pid, tag: 'A7K2', full: pid }, avatarColor: '#fff', kind, media: { type: 'movie', tmdbId, title: 'Dune' }, at,
});
const stateOf = (patch: Record<string, unknown>): SocialState => ({ ...initialSocialState(), ...patch }) as SocialState;

afterEach(() => {
  setEveningSource(() => []);
  setEveningJoin(null);
});

describe('wantersOf', () => {
  const friends = [friend('p1', 'Tom'), friend('p2', 'Léa'), friend('p3', 'Sam', { muted: true })];

  it('le foyer compte comme un ami : son envie apparaît aussi', () => {
    const household = [friend('h1', 'Maman', { household: true })];
    const s = stateOf({ friends, household, activity: [act('h1', 'listed', 438631), act('p1', 'listed', 438631)] });
    expect(wantersOf(s, 'movie', 438631, NOW).map(friendName)).toEqual(['Maman', 'Tom']);
  });

  it('rien sans activité ni liste : la ligne reste absente', () => {
    expect(wantersOf(stateOf({ friends }), 'movie', 438631, NOW)).toEqual([]);
  });

  it('ajouts à une liste et favoris récents, par ordre alphabétique, sans doublon', () => {
    const s = stateOf({ friends, activity: [act('p1', 'listed', 438631), act('p2', 'favorited', 438631), act('p2', 'listed', 438631)] });
    expect(wantersOf(s, 'movie', 438631, NOW).map(friendName)).toEqual(['Léa', 'Tom']);
  });

  it('ignore les autres titres, les autres types d’événement, les événements trop anciens, les inconnus et les relations en sourdine', () => {
    const s = stateOf({
      friends,
      activity: [
        act('p1', 'listed', 999), act('p1', 'started', 438631), act('p2', 'listed', 438631, NOW - WANT_WINDOW_MS - 1),
        act('p3', 'listed', 438631), act('inconnu', 'listed', 438631),
      ],
    });
    expect(wantersOf(s, 'movie', 438631, NOW)).toEqual([]);
    expect(wantersOf(s, 'series', 438631, NOW)).toEqual([]);
  });

  it('un ami qui a mis le titre dans une liste partagée compte', () => {
    const s = stateOf({ friends, listDetails: { l1: { id: 'l1', name: 'Soirées', members: [], items: [{ type: 'movie', tmdbId: 438631, title: 'Dune', addedBy: 'p1', addedAt: 1 }] } } });
    expect(wantersOf(s, 'movie', 438631, NOW).map(friendName)).toEqual(['Tom']);
  });

  it('les amis inscrits à la soirée comptent aussi', () => {
    setEveningSource(() => [{ id: 'e1', type: 'movie', tmdbId: 438631, startsAt: NOW + 3_600_000, going: ['p1'] }]);
    expect(wantersOf(stateOf({ friends }), 'movie', 438631, NOW).map(friendName)).toEqual(['Tom']);
  });

  it('le surnom privé remplace le nom', () => {
    const s = stateOf({ friends: [friend('p1', 'Tom', { nickname: 'Tommy' })], activity: [act('p1', 'listed', 5)] });
    expect(wantersOf(s, 'movie', 5, NOW).map(friendName)).toEqual(['Tommy']);
  });
});

describe('soirée proposée', () => {
  it('source vide aujourd’hui : aucune soirée', () => {
    expect(eveningFor('movie', 1, NOW)).toBeNull();
  });

  it('la prochaine soirée à venir du titre, jamais une soirée passée', () => {
    setEveningSource(() => [
      { id: 'old', type: 'movie', tmdbId: 1, startsAt: NOW - 1 },
      { id: 'late', type: 'movie', tmdbId: 1, startsAt: NOW + 7_200_000 },
      { id: 'soon', type: 'movie', tmdbId: 1, startsAt: NOW + 3_600_000 },
      { id: 'other', type: 'series', tmdbId: 1, startsAt: NOW + 10 },
    ]);
    expect(eveningFor('movie', 1, NOW)?.id).toBe('soon');
  });

  it('« Je viens » passe par l’action branchée, et échoue proprement sinon', async () => {
    expect(await joinEvening('e1')).toBe(false);
    setEveningJoin(async (id) => id === 'e1');
    expect(await joinEvening('e1')).toBe(true);
  });

  it('hasEveningJoin : vrai seulement quand une action « Je viens » est branchée', () => {
    setEveningJoin(null);
    expect(hasEveningJoin()).toBe(false);
    setEveningJoin(() => true);
    expect(hasEveningJoin()).toBe(true);
    setEveningJoin(null);
    expect(hasEveningJoin()).toBe(false);
  });
});

describe('formats', () => {
  it('noms : jusqu’à trois, puis « et N autres »', () => {
    expect(wantNames(['A', 'B', 'C'])).toEqual({ shown: ['A', 'B', 'C'], more: 0 });
    expect(wantNames(['A', 'B', 'C', 'D', 'E'])).toEqual({ shown: ['A', 'B', 'C'], more: 2 });
  });
  it('accord du verbe', () => {
    expect(wantVerb(1)).toBe('veut le voir');
    expect(wantVerb(3)).toBe('veulent le voir');
  });
  it('heure de la soirée', () => {
    expect(eveningTime(new Date(2026, 9, 27, 21, 0).getTime())).toBe('21 h');
    expect(eveningTime(new Date(2026, 9, 27, 21, 30).getTime())).toBe('21 h 30');
    expect(eveningTime(new Date(2026, 9, 27, 9, 5).getTime())).toBe('9 h 05');
  });

  it('étiquette du jour d’une soirée : Ce soir, Demain, jour de la semaine', () => {
    const now = new Date(2026, 9, 27, 18, 0).getTime();
    expect(eveningDay(new Date(2026, 9, 27, 21, 0).getTime(), now)).toBe('Ce soir');
    expect(eveningDay(new Date(2026, 9, 28, 20, 0).getTime(), now)).toBe('Demain');
    expect(eveningDay(new Date(2026, 9, 30, 20, 0).getTime(), now)).toBe('vendredi');
    expect(eveningDay(new Date(2026, 10, 10, 20, 0).getTime(), now)).toBe('10/11');
  });
});

describe('circleOf', () => {
  it('foyer puis amis, sans doublon', () => {
    const s = stateOf({ friends: [friend('p1', 'Tom'), friend('h1', 'Maman')], household: [friend('h1', 'Maman', { household: true })] });
    expect(circleOf(s).map((f) => f.pid)).toEqual(['h1', 'p1']);
    expect(circleOf(s)[0].household).toBe(true);
  });
});
