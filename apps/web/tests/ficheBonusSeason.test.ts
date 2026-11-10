import { describe, expect, it } from 'vitest';
import { bonusLast } from '../src/data/series';

const s = (season_number: number, episode_count = 3) => ({ season_number, episode_count, air_date: '', name: '' });

describe('bonusLast', () => {
  it('garde la saison 0 (Bonus), placée après les vraies saisons', () => {
    expect(bonusLast([s(0), s(2), s(1)]).map((x) => x.season_number)).toEqual([1, 2, 0]);
  });

  it('écarte une saison 0 sans épisode', () => {
    expect(bonusLast([s(0, 0), s(1)]).map((x) => x.season_number)).toEqual([1]);
  });

  it('série sans saison numérotée : seulement le Bonus', () => {
    expect(bonusLast([s(0)]).map((x) => x.season_number)).toEqual([0]);
  });
});
