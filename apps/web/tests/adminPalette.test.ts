// Palette de commandes de la console d'administration : score flou, groupes, navigation clavier, confirmation des actions sensibles,
// recherche de comptes débouncée, raccourcis globaux.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPaletteGroups, foldText, fuzzyScore, isPaletteShortcut, moveActive, PALETTE_SEARCH_DEBOUNCE_MS, rankEntries, type PaletteEntry,
} from '../src/data/adminPalette';
import { closePalette, defaultActions, installPaletteShortcuts, openPalette } from '../src/ui/admin-palette.js';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('score flou (fonction pure)', () => {
  it('ignore la casse et les accents', () => {
    expect(fuzzyScore('marine', 'Marine')).toBe(1000);
    expect(fuzzyScore('etat', 'État')).toBe(1000);
    expect(fuzzyScore('reinit', 'Réinitialiser')).not.toBeNull();
    expect(foldText('  Vue d’ensemble  ')).toBe("vue d'ensemble");
  });

  it('classe égalité > préfixe > sous-chaîne > sous-séquence', () => {
    const exact = fuzzyScore('mar', 'mar');
    const prefix = fuzzyScore('mar', 'marine');
    const inner = fuzzyScore('mar', 'Suspendre marine');
    const scattered = fuzzyScore('mrn', 'marine');
    expect(exact).toBeGreaterThan(prefix as number);
    expect(prefix).toBeGreaterThan(inner as number);
    expect(inner).toBeGreaterThan(scattered as number);
  });

  it('accepte une sous-séquence espacée et refuse ce qui n’y figure pas', () => {
    expect(fuzzyScore('rmp', 'Réinitialiser le mot de passe')).not.toBeNull();
    expect(fuzzyScore('xyz', 'marine')).toBeNull();
    expect(fuzzyScore('marinee', 'marine')).toBeNull();
  });

  it('une requête vide correspond à tout ; les apostrophes typographiques sont équivalentes', () => {
    expect(fuzzyScore('', 'n’importe quoi')).toBe(0);
    expect(fuzzyScore("vue d'ensemble", 'Vue d’ensemble')).toBe(1000);
  });

  it('rankEntries filtre, trie par score et garde l’ordre d’origine à égalité', () => {
    const entries: PaletteEntry<string>[] = [
      { key: 'a', label: 'Suspendre marine', hint: '', ref: 'a' },
      { key: 'b', label: 'marine', hint: '', ref: 'b' },
      { key: 'c', label: 'Caches', hint: '', ref: 'c' },
      { key: 'd', label: 'Marine bis', hint: '', ref: 'd' },
    ];
    expect(rankEntries(entries, 'mar').map((e) => e.ref)).toEqual(['b', 'd', 'a']);
    expect(rankEntries(entries, '').map((e) => e.ref)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('buildPaletteGroups garde les groupes Comptes, Sections, Actions dans cet ordre, sans groupe vide', () => {
    const parts = {
      accounts: [{ key: 'o', label: 'marine', hint: 'Ouvrir la fiche', ref: 'compte' }],
      sections: [{ key: 's', label: 'Caches', hint: '', ref: 'caches' }],
      actions: [] as PaletteEntry<string>[],
    };
    const groups = buildPaletteGroups('mar', parts);
    expect(groups.map((g) => g.title)).toEqual(['Comptes']);
    const all = buildPaletteGroups('ca', { ...parts, accounts: [] });
    expect(all.map((g) => g.title)).toEqual(['Sections']);
  });
});

describe('navigation et raccourcis (fonctions pures)', () => {
  it('moveActive boucle dans les deux sens et gère la liste vide', () => {
    expect(moveActive(0, 3, 1)).toBe(1);
    expect(moveActive(2, 3, 1)).toBe(0);
    expect(moveActive(0, 3, -1)).toBe(2);
    expect(moveActive(0, 0, 1)).toBe(-1);
    expect(moveActive(-1, 3, 1)).toBe(0);
  });

  it('Ctrl/Cmd+K ouvre partout ; « / » seulement hors champ et sans modificateur', () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false };
    expect(isPaletteShortcut({ ...base, key: 'k', ctrlKey: true }, true)).toBe(true);
    expect(isPaletteShortcut({ ...base, key: 'K', metaKey: true }, false)).toBe(true);
    expect(isPaletteShortcut({ ...base, key: '/' }, false)).toBe(true);
    expect(isPaletteShortcut({ ...base, key: '/' }, true)).toBe(false);
    expect(isPaletteShortcut({ ...base, key: '/', ctrlKey: true }, false)).toBe(false);
    expect(isPaletteShortcut({ ...base, key: 'a' }, false)).toBe(false);
  });
});

describe('palette (interface)', () => {
  const sections = [
    { id: 'overview', label: 'Vue d’ensemble', group: 'Plateforme' },
    { id: 'caches', label: 'Caches', group: 'Plateforme' },
    { id: 'announcements', label: 'Annonces', group: 'Système' },
  ];

  function makeDeps(over: Record<string, unknown> = {}) {
    const deps = {
      sections,
      go: vi.fn(),
      openAccount: vi.fn(),
      searchAccounts: vi.fn(async () => []),
      actions: [
        {
          id: 'maint', label: 'Activer la maintenance', hint: 'Système', sensitive: true, elevated: true,
          confirm: () => ({ title: 'Activer', message: 'Confirmer.', confirmLabel: 'Activer', danger: true }),
          run: vi.fn(async () => undefined),
          done: 'Maintenance activée.',
        },
        { id: 'announce', label: 'Publier une annonce', hint: 'Système', run: vi.fn(async () => undefined), done: '' },
        { id: 'suspend', label: 'Suspendre', hint: 'Action · mode élevé', sensitive: true, elevated: true, forAccount: true, run: vi.fn(async () => undefined) },
      ],
      confirm: vi.fn(async () => true),
      elevate: vi.fn(async () => undefined),
      hasElevation: vi.fn(() => true),
      notify: vi.fn(),
      ...over,
    };
    return deps;
  }

  const input = () => document.querySelector('.adm-pal-input') as HTMLInputElement;
  const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  const isOpen = () => document.querySelector('.adm-pal-layer') !== null;
  const press = (target: EventTarget, key: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };

  afterEach(() => {
    closePalette();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('affiche sections et actions à vide, puis filtre au fil de la frappe', () => {
    openPalette(makeDeps());
    expect(options().map((o) => o.querySelector('.adm-pal-label')?.textContent)).toEqual([
      'Vue d’ensemble', 'Caches', 'Annonces', 'Activer la maintenance', 'Publier une annonce',
    ]);
    type('cach');
    expect(options().map((o) => o.querySelector('.adm-pal-label')?.textContent)).toEqual(['Caches']);
    const groups = Array.from(document.querySelectorAll('[role="group"] .adm-pal-group-title')).map((n) => n.textContent);
    expect(groups).toEqual(['Sections']);
  });

  it('↑ et ↓ déplacent l’option active, bouclent et mettent à jour aria-activedescendant', () => {
    openPalette(makeDeps());
    const field = input();
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    expect(field.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    press(field, 'ArrowDown');
    expect(field.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    expect(options()[1].classList.contains('is-active')).toBe(true);
    press(field, 'ArrowUp');
    press(field, 'ArrowUp');
    expect(field.getAttribute('aria-activedescendant')).toBe(options()[4].id);
  });

  it('Entrée exécute l’élément actif et ferme la palette', () => {
    const deps = makeDeps();
    openPalette(deps);
    press(input(), 'ArrowDown');
    press(input(), 'Enter');
    expect(deps.go).toHaveBeenCalledWith('caches');
    expect(isOpen()).toBe(false);
  });

  it('Échap ferme la palette et rend le focus à l’élément d’origine', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openPalette(makeDeps());
    expect(document.activeElement).toBe(input());
    press(input(), 'Escape');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('le focus reste piégé dans la palette, y compris sur Tab', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    openPalette(makeDeps());
    outside.focus();
    expect(document.activeElement).toBe(input());
    press(input(), 'Tab');
    expect(document.activeElement).toBe(input());
  });

  it('une action sensible demande confirmation avant de s’exécuter, et s’arrête si elle est refusée', async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => false) });
    openPalette(deps);
    type('maint');
    press(input(), 'Enter');
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledTimes(1));
    await flush();
    expect(deps.actions[0].run).not.toHaveBeenCalled();
    expect(deps.elevate).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('une action sensible confirmée demande l’élévation puis s’exécute après la confirmation', async () => {
    const deps = makeDeps({ hasElevation: vi.fn(() => false) });
    openPalette(deps);
    type('maint');
    press(input(), 'Enter');
    await vi.waitFor(() => expect(deps.actions[0].run).toHaveBeenCalledTimes(1));
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.elevate).toHaveBeenCalledTimes(1);
    expect(deps.confirm.mock.invocationCallOrder[0]).toBeLessThan(deps.elevate.mock.invocationCallOrder[0]);
    expect(deps.elevate.mock.invocationCallOrder[0]).toBeLessThan(deps.actions[0].run.mock.invocationCallOrder[0]);
    expect(deps.notify).toHaveBeenCalledWith('Maintenance activée.');
  });

  it('une action non sensible s’exécute sans confirmation', async () => {
    const deps = makeDeps();
    openPalette(deps);
    type('publier');
    press(input(), 'Enter');
    await vi.waitFor(() => expect(deps.actions[1].run).toHaveBeenCalledTimes(1));
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('la recherche de comptes est débouncée (200 ms) et affiche les résultats du groupe Comptes', async () => {
    vi.useFakeTimers();
    const accounts = [{ id: 'u-1', username: 'marine' }, { id: 'u-2', username: 'marc' }];
    const deps = makeDeps({ searchAccounts: vi.fn(async () => accounts) });
    openPalette(deps);
    type('m');
    await vi.advanceTimersByTimeAsync(50);
    type('ma');
    await vi.advanceTimersByTimeAsync(50);
    type('mar');
    await vi.advanceTimersByTimeAsync(PALETTE_SEARCH_DEBOUNCE_MS - 1);
    expect(deps.searchAccounts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.searchAccounts).toHaveBeenCalledTimes(1);
    expect(deps.searchAccounts).toHaveBeenCalledWith('mar');
    await flush();
    const comptes = Array.from(document.querySelectorAll('[role="group"]')).find(
      (g) => g.querySelector('.adm-pal-group-title')?.textContent === 'Comptes',
    );
    expect(comptes).toBeTruthy();
    const labels = Array.from(comptes!.querySelectorAll('.adm-pal-label')).map((n) => n.textContent);
    expect(labels).toEqual(['marine', 'Suspendre marine', 'marc', 'Suspendre marc']);
  });

  it('Entrée sur un compte ouvre sa fiche', async () => {
    const deps = makeDeps({ searchAccounts: vi.fn(async () => [{ id: 'u-9', username: 'marine' }]) });
    openPalette(deps);
    type('marine');
    await vi.waitFor(() => expect(options().some((o) => o.textContent?.includes('Ouvrir la fiche'))).toBe(true));
    press(input(), 'Enter');
    expect(deps.openAccount).toHaveBeenCalledWith('u-9');
  });

  it('une action à sous-actions (préfixes de cache) remplace son parent par les sous-actions une fois chargées', async () => {
    const purge = vi.fn(async () => undefined);
    const deps = makeDeps({
      actions: [{
        id: 'purge', label: 'Purger un préfixe de cache', hint: 'Plateforme',
        children: vi.fn(async () => [{
          id: 'purge:meta:', label: 'Purger le cache « meta: »', hint: 'Plateforme', sensitive: true, elevated: true,
          confirm: () => ({ title: 'Vider le cache « meta: »', message: 'Vider.', confirmLabel: 'Vider', danger: true }),
          run: purge,
        }]),
        pick: 'Tape le préfixe de cache à purger.',
      }],
    });
    openPalette(deps);
    const labels = () => options().map((o) => o.querySelector('.adm-pal-label')?.textContent);
    expect(labels()).toContain('Purger un préfixe de cache');
    type('purge');
    await vi.waitFor(() => expect(labels()).toEqual(['Purger le cache « meta: »']));
    press(input(), 'Enter');
    await vi.waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Vider le cache « meta: »' }));
  });

  it('ouvrir une seconde fois ramène le focus sur la palette déjà ouverte', () => {
    openPalette(makeDeps());
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    openPalette(makeDeps());
    expect(document.querySelectorAll('.adm-pal-layer').length).toBe(1);
    expect(document.activeElement).toBe(input());
  });

  it('defaultActions : la suspension est sensible, élevée et ciblée sur un compte', () => {
    const suspend = defaultActions({ go: vi.fn() }).find((a) => a.id === 'suspend');
    expect(suspend).toMatchObject({ sensitive: true, elevated: true, forAccount: true, label: 'Suspendre' });
  });
});

describe('raccourcis globaux', () => {
  it('Ctrl+K et « / » hors champ appellent openFn ; le disposer retire l’écouteur', () => {
    const openFn = vi.fn();
    const dispose = installPaletteShortcuts(openFn);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(openFn).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect(openFn).toHaveBeenCalledTimes(2);

    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect(openFn).toHaveBeenCalledTimes(2);

    dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(openFn).toHaveBeenCalledTimes(2);
    document.body.innerHTML = '';
  });
});
