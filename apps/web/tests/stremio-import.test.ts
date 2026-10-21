// Carte « Importer ma bibliothèque Stremio » : repliable, résumé mémorisé, étapes, résultat, erreurs, secrets.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserApiError } from '../src/data/userApi';

const importMock = vi.fn();
vi.mock('../src/data/auth', async (orig) => ({ ...(await orig<Record<string, unknown>>()), importFromStremio: (...a: unknown[]) => importMock(...a) }));

const KEY = 'ls_stremio_import';
let detail: HTMLElement;
let renderCard: () => string;

const q = <T extends Element = HTMLElement>(s: string) => detail.querySelector(s) as T;
const form = () => q<HTMLFormElement>('#set-stremio');
const input = (n: string) => form().elements.namedItem(n) as HTMLInputElement;
const releases: Array<() => void> = [];
const hang = () => new Promise<never>((_, rej) => { releases.push(() => rej(new UserApiError(0, 'network'))); });
const settle = () => new Promise((r) => setTimeout(r, 0));
function mount() {
  detail.innerHTML = renderCard();
}
function fill(email = 'moi@exemple.ch', pwd = 'secret-pw') {
  input('email').value = email;
  input('password').value = pwd;
}
async function send() {
  form().requestSubmit();
  await settle();
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div><div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  detail = document.getElementById('detail') as HTMLElement;
  const mod = await import('../src/ui/stremio-import.js');
  renderCard = mod.stremioImportCard;
});

beforeEach(() => {
  localStorage.clear();
  importMock.mockReset();
  mount();
});
afterEach(async () => {
  vi.useRealTimers();
  releases.splice(0).forEach((r) => r());
  await settle();
});

describe('carte repliable', () => {
  it('est repliée par défaut avec le résumé « Pas encore importée »', () => {
    const t = q('#si-toggle');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-controls')).toBe('si-body');
    expect(q('#si-body').hasAttribute('inert')).toBe(true);
    expect(q('#si-sum').textContent).toBe('Pas encore importée');
  });

  it('se déplie, se replie et mémorise son état', () => {
    q('#si-toggle').click();
    expect(q('#si-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(q('#si-body').hasAttribute('inert')).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) || '{}').open).toBe(true);
    mount();
    expect(q('#si-toggle').getAttribute('aria-expanded')).toBe('true');
    q('#si-toggle').click();
    expect(q('#si-toggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('affiche le résumé mémorisé (date et total)', () => {
    localStorage.setItem(KEY, JSON.stringify({ at: new Date(2026, 9, 21, 12).getTime(), count: 42 }));
    mount();
    expect(q('#si-sum').textContent).toBe('Déjà importé le 21 octobre 2026 · 42 titres');
  });

  it('présente la confidentialité et des champs bien typés', () => {
    expect(detail.querySelectorAll('.si-priv li')).toHaveLength(3);
    expect(input('email').type).toBe('email');
    expect(input('email').getAttribute('inputmode')).toBe('email');
    expect(input('email').autocomplete).toBe('off');
    expect(input('password').autocomplete).toBe('new-password');
    expect(detail.textContent).not.toContain('Films');
  });
});

describe('œil du mot de passe', () => {
  it('affiche puis remasque, et remasque à l’envoi', async () => {
    importMock.mockReturnValue(hang());
    const eye = q('[data-si-eye]');
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    eye.click();
    expect(input('password').type).toBe('text');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(eye.getAttribute('aria-label')).toBe('Masquer le mot de passe');
    fill();
    await send();
    expect(input('password').type).toBe('password');
    expect(eye.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('envoi', () => {
  it('désactive le bouton, verrouille les champs et affiche les étapes', async () => {
    importMock.mockReturnValue(hang());
    fill();
    await send();
    const b = q<HTMLButtonElement>('#si-submit');
    expect(b.disabled).toBe(true);
    expect(b.textContent).toBe('Import en cours…');
    expect(input('email').readOnly).toBe(true);
    expect(q('#si-steps').getAttribute('aria-live')).toBe('polite');
    expect(q('#si-steps-w').hidden).toBe(false);
    expect(q('[role=progressbar]').hasAttribute('aria-valuenow')).toBe(false);
    const st = Array.from(q('#si-steps').children).map((l) => (l as HTMLElement).dataset.state);
    expect(st).toEqual(['active', 'pending', 'pending']);
    expect(importMock).toHaveBeenCalledWith('moi@exemple.ch', 'secret-pw', expect.anything());
  });

  it('ne coche la dernière étape qu’à la réponse du serveur', async () => {
    vi.useFakeTimers();
    let done: (v: unknown) => void = () => undefined;
    importMock.mockReturnValue(new Promise((r) => { done = r; releases.push(() => r({})); }));
    fill();
    form().requestSubmit();
    await vi.advanceTimersByTimeAsync(10_000);
    const st = () => Array.from(q('#si-steps').children).map((l) => (l as HTMLElement).dataset.state);
    expect(st()).toEqual(['done', 'done', 'active']);
    done({ imported: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(st()).toEqual(['done', 'done', 'done']);
  });
});

describe('résultat', () => {
  it('affiche le total renvoyé, mémorise date et total, vide les champs', async () => {
    importMock.mockResolvedValue({ imported: 12 });
    fill();
    await send();
    expect(q('#si-result').hidden).toBe(false);
    expect(form().hidden).toBe(true);
    expect(q('#si-result-t').textContent).toBe('12 titres ajoutés à ce profil.');
    expect(q('#si-result a').getAttribute('href')).toBe('#/library');
    expect(q('#si-sum').textContent).toMatch(/^Déjà importé le .* · 12 titres$/);
    expect(input('password').value).toBe('');
    q('[data-si-again]').click();
    expect(form().hidden).toBe(false);
    expect(input('email').value).toBe('');
    expect(q<HTMLButtonElement>('#si-submit').disabled).toBe(false);
  });

  it('sans total renvoyé, n’invente aucun chiffre', async () => {
    importMock.mockResolvedValue({ ok: true });
    fill();
    await send();
    expect(q('#si-result-t').textContent).toBe('Import terminé.');
    expect(JSON.parse(localStorage.getItem(KEY) || '{}').count).toBeUndefined();
  });
});

describe('erreurs', () => {
  it('identifiants refusés : bandeau alert, champs invalides, rien d’ajouté', async () => {
    importMock.mockRejectedValue(new UserApiError(401, 'stremio_login_failed'));
    fill();
    await send();
    const a = q('#si-alert');
    expect(a.getAttribute('role')).toBe('alert');
    expect(a.hidden).toBe(false);
    expect(a.textContent).toContain('refusés par Stremio');
    expect(a.textContent).toContain('rien n’a été ajouté');
    expect(input('email').getAttribute('aria-invalid')).toBe('true');
    expect(input('password').getAttribute('aria-invalid')).toBe('true');
    expect(q('#si-retry').hidden).toBe(true);
    expect(q<HTMLButtonElement>('#si-submit').disabled).toBe(false);
  });

  it('serveur injoignable : message distinct et bouton Réessayer', async () => {
    importMock.mockRejectedValueOnce(new UserApiError(0, 'network'));
    fill();
    await send();
    expect(q('#si-alert').textContent).toContain('injoignable');
    expect(input('email').hasAttribute('aria-invalid')).toBe(false);
    expect(q('#si-retry').hidden).toBe(false);
    importMock.mockResolvedValueOnce({ imported: 1 });
    q('#si-retry').click();
    await settle();
    expect(importMock).toHaveBeenCalledTimes(2);
    expect(q('#si-result-t').textContent).toBe('1 titre ajouté à ce profil.');
  });
});

describe('secrets', () => {
  it('n’écrit ni e-mail ni mot de passe dans le stockage ni dans la console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    importMock.mockResolvedValueOnce({ imported: 2 });
    fill('moi@exemple.ch', 'secret-pw');
    await send();
    importMock.mockRejectedValueOnce(new UserApiError(0, 'network'));
    q('[data-si-again]').click();
    fill('moi@exemple.ch', 'secret-pw');
    await send();
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('secret-pw');
    expect(stored).not.toContain('moi@exemple.ch');
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain('secret-pw');
      s.mockRestore();
    }
  });
});

describe('re-rendu et navigation pendant l’import', () => {
  it('un re-rendu de la carte garde l’état « en cours » sans second appel', async () => {
    let done: (v: unknown) => void = () => undefined;
    importMock.mockReturnValue(new Promise((r) => { done = r; releases.push(() => r({})); }));
    fill();
    await send();
    mount();
    expect(q<HTMLButtonElement>('#si-submit').disabled).toBe(true);
    expect(input('email').readOnly).toBe(true);
    expect(form().getAttribute('aria-busy')).toBe('true');
    fill();
    form().requestSubmit();
    await settle();
    expect(importMock).toHaveBeenCalledTimes(1);
    done({ imported: 4 });
    await settle();
    expect(q<HTMLButtonElement>('#si-submit').disabled).toBe(false);
    expect(q('#si-sum').textContent).toMatch(/· 4 titres$/);
  });

  it('quitter la page pendant l’import : toast de succès, aucune exception', async () => {
    let done: (v: unknown) => void = () => undefined;
    importMock.mockReturnValue(new Promise((r) => { done = r; releases.push(() => r({})); }));
    fill();
    await send();
    detail.innerHTML = '';
    done({ imported: 2 });
    await settle();
    expect(document.getElementById('toast')?.textContent).toBe('Bibliothèque Stremio importée');
    expect(JSON.parse(localStorage.getItem(KEY) || '{}').count).toBe(2);
  });

  it('quitter la page puis échec : toast d’erreur, aucune exception', async () => {
    let fail: (e: unknown) => void = () => undefined;
    importMock.mockReturnValue(new Promise((_, r) => { fail = r; releases.push(() => r(new UserApiError(0, 'network'))); }));
    fill();
    await send();
    detail.innerHTML = '';
    fail(new UserApiError(0, 'network'));
    await settle();
    expect(document.getElementById('toast')?.textContent).toContain('lastAddon est injoignable');
  });
});

describe('accessibilité des étapes et validation', () => {
  it('annonce l’état de chaque étape en texte', async () => {
    vi.useFakeTimers();
    importMock.mockReturnValue(hang());
    fill();
    form().requestSubmit();
    await vi.advanceTimersByTimeAsync(2000);
    const t = Array.from(q('#si-steps').children).map((l) => l.textContent);
    expect(t[0]).toContain('terminé');
    expect(t[1]).toContain('en cours');
    expect(t[2]).toBe('Ajout au profil');
  });

  it('ne marque invalides que les champs vides, focus sur le premier', async () => {
    input('email').value = 'moi@exemple.ch';
    await send();
    expect(input('email').hasAttribute('aria-invalid')).toBe(false);
    expect(input('password').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input('password'));
    expect(importMock).not.toHaveBeenCalled();
  });

  it('serveur injoignable : seul Réessayer reste proposé', async () => {
    importMock.mockRejectedValueOnce(new UserApiError(0, 'network'));
    fill();
    await send();
    expect(q<HTMLButtonElement>('#si-submit').hidden).toBe(true);
    expect(q('#si-retry').hidden).toBe(false);
  });

  it('replier la carte rend le focus à l’en-tête', () => {
    q('#si-toggle').click();
    input('email').focus();
    q('#si-toggle').click();
    expect(document.activeElement).toBe(q('#si-toggle'));
  });
});
