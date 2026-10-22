// Rangée d'accueil « Tes chaînes favorites » : programme en cours de chaque favori, à défaut le suivant proche.
import { describe, expect, it } from 'vitest';
import { favAirings, FAV_ROW_MAX } from '../src/data/tvFavRow';
import type { EpgProgram, GuideChannel } from '../src/data/shows';

const ch = (id: string, num: number | null = null): GuideChannel => ({ epgId: id, playId: id, name: id, logo: '', num });
const prog = (channelId: string, title: string, start: number, stop: number, extra: Partial<EpgProgram> = {}): EpgProgram => ({ channelId, title, start, stop, ...extra });
const NOW = 1_000_000;
const H = 3600;

describe('favAirings', () => {
  it('programme en cours de chaque favori, dans l’ordre reçu', () => {
    const out = favAirings([
      { channel: ch('brut'), progs: [prog('brut', 'Doc', NOW - 600, NOW + 600, { category: 'Documentaire', icon: 'https://i/x.jpg' })] },
      { channel: ch('tf1', 1), progs: [prog('tf1', 'Film', NOW - H, NOW + H)] },
    ], NOW);
    expect(out.map((a) => [a.channel.epgId, a.title])).toEqual([['brut', 'Doc'], ['tf1', 'Film']]);
    expect(out[0]).toMatchObject({ category: 'Documentaire', icon: 'https://i/x.jpg', desc: '' });
  });

  it('pas de programme en cours : le suivant s’il commence dans les 3 h, sinon la chaîne est écartée', () => {
    const out = favAirings([
      { channel: ch('a'), progs: [prog('a', 'Plus tard', NOW + 2 * H, NOW + 3 * H), prog('a', 'Trop tard', NOW + 5 * H, NOW + 6 * H)] },
      { channel: ch('b'), progs: [prog('b', 'Très tard', NOW + 4 * H, NOW + 5 * H)] },
      { channel: ch('c'), progs: [] },
    ], NOW);
    expect(out.map((a) => a.title)).toEqual(['Plus tard']);
  });

  it('en cours prime sur le suivant, même si les programmes arrivent en désordre', () => {
    const out = favAirings([{ channel: ch('a'), progs: [prog('a', 'Suivant', NOW + 600, NOW + H), prog('a', 'Actuel', NOW - 600, NOW + 600)] }], NOW);
    expect(out.map((a) => a.title)).toEqual(['Actuel']);
  });

  it('au plus 16 cartes par défaut, ou le maximum demandé', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ channel: ch('c' + i), progs: [prog('c' + i, 'P', NOW - 60, NOW + 60)] }));
    expect(favAirings(many, NOW)).toHaveLength(FAV_ROW_MAX);
    expect(favAirings(many, NOW, 3)).toHaveLength(3);
  });

  it('aucun favori : rangée vide (l’accueil garde la sélection du soir)', () => {
    expect(favAirings([], NOW)).toEqual([]);
  });
});
