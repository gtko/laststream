// @vitest-environment jsdom
/* Retour du téléphone (LAST-499) : couches posées dans l'historique, entrées périmées sautées, bouton retour Android. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/router.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/ui/state.js', () => ({ state: { inDetail: false } }));

const { handlePopState, hasLayers, pushLayer, resetBackStack } = await import('../src/ui/backStack.js');
const { androidBackAction } = await import('../src/ui/androidBack.js');

/** Retours consommés (true) ou laissés au routeur (false), dans l'ordre des `popstate`. */
let pops: boolean[] = [];
const onPop = () => { pops.push(handlePopState()); };

/** Laisse passer les `popstate` en file (retour demandé, puis saut éventuel d'une entrée périmée). */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}
async function back() {
  history.back();
  await settle();
}
async function nav(hash: string) {
  location.hash = hash;
  await settle();
}

beforeEach(async () => {
  window.addEventListener('popstate', onPop);
  await nav('#/a');
  await nav('#/b');
  resetBackStack();
  pops = [];
});
afterEach(() => {
  window.removeEventListener('popstate', onPop);
});

describe('pile des couches', () => {
  it('le retour ferme la couche ouverte sans changer de page', async () => {
    const close = vi.fn();
    pushLayer(close);
    expect(hasLayers()).toBe(true);
    await back();
    expect(close).toHaveBeenCalledTimes(1);
    expect(hasLayers()).toBe(false);
    expect(location.hash).toBe('#/b');
    expect(pops).toEqual([true]);
  });

  it('deux couches : le retour ne ferme que celle du dessus', async () => {
    const below = vi.fn();
    const above = vi.fn();
    pushLayer(below);
    pushLayer(above);
    await back();
    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    await back();
    expect(below).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('#/b');
  });

  it('couche fermée par la croix : le retour suivant change de page du premier coup', async () => {
    const close = vi.fn();
    const release = pushLayer(close);
    release();
    expect(hasLayers()).toBe(false);
    await back();
    expect(close).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/a');
  });

  it('lien suivi depuis un menu : le retour revient à la page du menu, puis à la précédente', async () => {
    const release = pushLayer(vi.fn());
    release(); // le menu se ferme, puis le lien navigue
    await nav('#/c');
    await back();
    expect(location.hash).toBe('#/b');
    expect(pops[0]).toBe(false); // la page du menu est rejouée par le routeur
    await back();
    expect(location.hash).toBe('#/a');
  });

  it('sans couche, le retour reste au routeur', async () => {
    await back();
    expect(location.hash).toBe('#/a');
    expect(pops).toEqual([false]);
  });
});

describe('bouton retour Android', () => {
  it('couche ouverte : retour de l\'historique', () => {
    expect(androidBackAction({ layers: true, inDetail: false, canGoBack: true })).toBe('back');
  });
  it('page intérieure : page précédente de l\'app', () => {
    expect(androidBackAction({ layers: false, inDetail: true, canGoBack: false })).toBe('page');
    expect(androidBackAction({ layers: false, inDetail: true, canGoBack: true })).toBe('page');
  });
  it('accueil sans couche : comportement système', () => {
    expect(androidBackAction({ layers: false, inDetail: false, canGoBack: true })).toBe('exit');
  });
});
