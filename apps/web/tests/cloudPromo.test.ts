// Encart « Laststream en ligne » (serveur auto-hébergé) : rythme espacé, fermeture respectée, arrêt définitif, rien hors éligibilité.
import { beforeEach, describe, expect, it } from 'vitest';
import { decide, FIRST_DELAY, GAP, PROMO_KEY, renderCloudPromo, snooze, SNOOZE, stop, VARIANTS } from '../src/ui/cloud-promo.js';

const T0 = new Date(2026, 10, 1, 20, 0).getTime();
const H = 60 * 60 * 1000;

beforeEach(() => {
  document.body.innerHTML = '<div id="promo-slot"></div>';
  localStorage.clear();
});

describe('rythme (fonction pure)', () => {
  it('rien les premiers jours, puis une variante', () => {
    const a = decide(null, T0);
    expect(a.variant).toBeNull();
    expect(a.st.next).toBe(T0 + FIRST_DELAY);
    const b = decide(a.st, T0 + FIRST_DELAY);
    expect(b.variant).toBe(VARIANTS[0]);
  });

  it('même encart toute la journée, puis pause de 10 jours et visuel suivant', () => {
    const shown = decide(decide(null, T0).st, T0 + FIRST_DELAY).st;
    expect(decide(shown, T0 + FIRST_DELAY + 2 * H).variant).toBe(VARIANTS[0]);
    const nextDay = T0 + FIRST_DELAY + 24 * H;
    const off = decide(shown, nextDay);
    expect(off.variant).toBeNull();
    expect(off.st.next).toBe(nextDay + GAP);
    expect(decide(off.st, nextDay + GAP).variant).toBe(VARIANTS[1]);
  });

  it('fermer : 30 jours sans encart ; ne plus afficher : jamais', () => {
    const shown = decide(decide(null, T0).st, T0 + FIRST_DELAY).st;
    const closed = snooze(shown, T0 + FIRST_DELAY);
    expect(decide(closed, T0 + FIRST_DELAY + SNOOZE - H).variant).toBeNull();
    expect(decide(closed, T0 + FIRST_DELAY + SNOOZE).variant).toBe(VARIANTS[1]);
    expect(decide(stop(shown), T0 + 400 * 24 * H).variant).toBeNull();
  });

  it('état corrompu : repart de zéro sans exception', () => {
    expect(decide('n’importe quoi' as never, T0).variant).toBeNull();
    expect(decide({ next: 'x' } as never, T0).st.next).toBe(T0 + FIRST_DELAY);
  });
});

describe('affichage', () => {
  const show = (eligible = true) => renderCloudPromo({ now: () => T0 + FIRST_DELAY, eligible: () => eligible });
  const seed = () => localStorage.setItem(PROMO_KEY, JSON.stringify(decide(null, T0).st));

  it('serveur non éligible (service en ligne, profil enfant…) : rien, et rien n’est mémorisé', () => {
    show(false);
    expect(document.getElementById('promo-slot')!.innerHTML).toBe('');
    expect(localStorage.getItem(PROMO_KEY)).toBeNull();
  });

  it('encart fermable, lien vers l’offre, texte sans HTML injecté', () => {
    seed();
    show();
    const el = document.querySelector('.cpromo')!;
    expect(el.querySelector('.cpromo-title')!.textContent).toBe(VARIANTS[0].title);
    expect(el.querySelector('a[data-cpromo-go]')!.getAttribute('href')).toContain('laststream.app');
    (el.querySelector('[data-cpromo-close]') as HTMLButtonElement).click();
    expect(document.querySelector('.cpromo')).toBeNull();
    show();
    expect(document.querySelector('.cpromo')).toBeNull();
  });

  it('« Ne plus afficher » est mémorisé', () => {
    seed();
    show();
    (document.querySelector('[data-cpromo-never]') as HTMLButtonElement).click();
    expect(JSON.parse(localStorage.getItem(PROMO_KEY)!).off).toBe(true);
  });

  it('stockage indisponible : aucune exception', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(() => renderCloudPromo({ storage: broken, now: () => T0, eligible: () => true })).not.toThrow();
  });
});
