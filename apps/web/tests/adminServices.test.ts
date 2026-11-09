// Console d'administration, Plateforme > Clés des services : rendu de l'état masqué (origine, quatre derniers caractères,
// jamais de valeur), modification envoyée (champs saisis, modèle changé seulement), effacement et import sous élévation.
import { describe, expect, it, vi } from 'vitest';
import { keyPlaceholder, servicesHTML, servicesPatch, testable, testNoteHTML, testService } from '../src/ui/admin/services.js';
import { UserApiError } from '../src/data/userApi';
import type { ServiceKeys } from '../src/data/adminApi';

vi.mock('../src/ui/dom.js', () => ({ toast: vi.fn() }));

const ready = <T>(value: T) => ({ status: 'ready', error: '', value });

const KEYS: ServiceKeys = {
  tmdbToken: { set: true, last4: '…cdef', source: 'db' },
  mdblistApiKey: { set: true, last4: '…6789', source: 'env' },
  tvdbApiKey: { set: false, source: 'none' },
  openrouterModel: { set: true, value: 'anthropic/claude-test', source: 'db' },
};

function formOf(keys: ServiceKeys, values: Record<string, string>): HTMLFormElement {
  document.body.innerHTML = servicesHTML({ serviceKeys: ready({ services: keys }) });
  const form = document.querySelector<HTMLFormElement>('#adm-svc')!;
  for (const [name, v] of Object.entries(values)) (form.elements.namedItem('svc.' + name) as HTMLInputElement).value = v;
  return form;
}

describe('clés des services : affichage', () => {
  it('texte du champ vide selon l’origine de la clé', () => {
    expect(keyPlaceholder({ set: true, last4: '…cdef', source: 'db' })).toBe('Enregistrée (…cdef)');
    expect(keyPlaceholder({ set: true, last4: '…6789', source: 'env' })).toContain('Variable du serveur (…6789)');
    expect(keyPlaceholder({ set: false, source: 'none' })).toBe('Non définie');
    expect(keyPlaceholder(undefined)).toBe('Non définie');
  });

  it('champs masqués (mot de passe), origine affichée, « Effacer » seulement pour une clé de l’administration', () => {
    formOf(KEYS, {});
    const tmdb = document.querySelector<HTMLInputElement>('[name="svc.tmdbToken"]')!;
    expect(tmdb.type).toBe('password');
    expect(tmdb.value).toBe('');
    expect(tmdb.placeholder).toBe('Enregistrée (…cdef)');
    expect([...document.querySelectorAll<HTMLElement>('[data-adm-svc-clear]')].map((b) => b.dataset.admSvcClear)).toEqual(['tmdbToken']);
    expect(document.body.textContent).toContain('Variable du serveur');
    expect(document.querySelector('[data-adm-svc-import]')).not.toBeNull();
    // Les onze champs du serveur sont proposés (le modèle par son sélecteur).
    expect(document.querySelectorAll('[name^="svc."]')).toHaveLength(11);
    expect(document.querySelector<HTMLInputElement>('[name="svc.openrouterModel"]')!.value).toBe('anthropic/claude-test');
  });
});

describe('clés des services : modification envoyée', () => {
  it('seuls les champs saisis partent, espaces retirés', () => {
    expect(servicesPatch(formOf(KEYS, { tvdbApiKey: '  abc  ', tvdbPin: '1234' }), KEYS)).toEqual({ tvdbApiKey: 'abc', tvdbPin: '1234' });
  });

  it('rien de saisi et modèle inchangé : rien à enregistrer', () => {
    expect(servicesPatch(formOf(KEYS, {}), KEYS)).toEqual({});
    // Sans modèle en place, le modèle par défaut affiché n'est pas envoyé.
    expect(servicesPatch(formOf({}, {}), {})).toEqual({});
  });

  it('modèle changé : envoyé', () => {
    expect(servicesPatch(formOf(KEYS, { openrouterModel: 'openai/gpt-4o' }), KEYS)).toEqual({ openrouterModel: 'openai/gpt-4o' });
  });
});

describe('clés des services : test de chaque API', () => {
  it('un bouton « Tester » par fournisseur, désactivé sans clé en place', () => {
    formOf(KEYS, {});
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-adm-svc-test]')];
    expect(buttons.map((b) => b.dataset.admSvcTest)).toEqual(['tmdb', 'mdblist', 'fanart', 'tvdb', 'openrouter']);
    const state = Object.fromEntries(buttons.map((b) => [b.dataset.admSvcTest, b.disabled]));
    expect(state).toEqual({ tmdb: false, mdblist: false, fanart: true, tvdb: true, openrouter: true });
  });

  it('TMDB testable avec le jeton v4 ou la clé v3', () => {
    expect(testable('tmdb', { tmdbApiKey: { set: true, source: 'env' } })).toBe(true);
    expect(testable('tmdb', {})).toBe(false);
  });

  it('résultat affiché sur la ligne : réussite, échec avec la raison, erreur de l’appel', async () => {
    const S: any = { serviceKeys: ready({ services: KEYS }) };
    const ctx = { S, isCurrent: () => true, paint: vi.fn() };
    await testService(ctx, 'tmdb', async () => ({ id: 'tmdb', ok: true, status: 200, latencyMs: 142 }));
    expect(testNoteHTML(S.svcTests.tmdb)).toContain('Clé valide · 142 ms');
    await testService(ctx, 'mdblist', async () => ({ id: 'mdblist', ok: false, status: 401, latencyMs: 90, error: 'rejected' }));
    expect(testNoteHTML(S.svcTests.mdblist)).toContain('HTTP 401 · clé refusée');
    await testService(ctx, 'tvdb', async () => { throw new UserApiError(429, 'rate_limited'); });
    expect(testNoteHTML(S.svcTests.tvdb)).toContain('Trop de requêtes');
    document.body.innerHTML = servicesHTML(S);
    expect(document.body.textContent).toContain('Clé valide · 142 ms');
  });
});
