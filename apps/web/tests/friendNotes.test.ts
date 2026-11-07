// Notes d'un ami (ODY-221) : liste (titre, S/E, horodatage, émoji, texte, masquée), états (chargement, vide, 403 hidden,
// erreur puis Réessayer), pagination sans doublon, clic vers launchPlayback à la position, Modifier / Supprimer réservés
// aux notes du profil actif (mise à jour optimiste, retour arrière, confirmation).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserApiError } from '../src/data/userApi';

vi.mock('../src/data/socialV2Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialV2Api')>()),
  getFriendNotes: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock('../src/data/lt', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchServerMeta: vi.fn(),
}));

import * as lt from '../src/data/lt';
import * as v2 from '../src/data/socialV2Api';
import { createFriendNotes } from '../src/ui/friendNotes.js';
import { registerSocialHook } from '../src/ui/socialHooks.js';

const getNotes = vi.mocked(v2.getFriendNotes);
const update = vi.mocked(v2.updateNote);
const del = vi.mocked(v2.deleteNote);
const meta = vi.mocked(lt.fetchServerMeta);

const ME = 'p-me';
const FRIEND = 'p-friend';
const NOW = Date.now();
const author = (pid: string) => ({ pid, handle: { name: 'Ana', tag: '1234', full: 'Ana#1234' }, avatarColor: '#112233' });

let seqId = 0;
function note(over: Record<string, unknown> = {}): any {
  seqId += 1;
  return {
    id: 'n' + seqId, author: author(FRIEND), pos: 212, kind: 'text', body: 'Quel plan !', createdAt: NOW - 2 * 3600_000,
    media: { type: 'series', tmdbId: 100 + seqId, season: 1, episode: 3 }, ...over,
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

let host: HTMLElement;
let toast: ReturnType<typeof vi.fn>;
let launch: ReturnType<typeof vi.fn>;
let onDeleted: ReturnType<typeof vi.fn>;
let api: ReturnType<typeof createFriendNotes>;

async function mount(pid = FRIEND, mine = ME) {
  api = createFriendNotes({ toast, myPid: () => mine, onDeleted });
  api.bind(host);
  api.load(pid);
  await flush();
}
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[];
const click = (el: Element | null) => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const byFn = (fn: string) => q('[data-fn="' + fn + '"]');

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.append(host);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  toast = vi.fn();
  launch = vi.fn();
  onDeleted = vi.fn();
  registerSocialHook('launchPlayback', launch as never);
  meta.mockResolvedValue({ title: 'Severance', poster: null } as never);
});

describe('liste des notes', () => {
  it('affiche titre, S/E, horodatage et texte entre guillemets', async () => {
    getNotes.mockResolvedValue({ notes: [note()] });
    await mount();
    expect(getNotes).toHaveBeenCalledWith(FRIEND, { limit: 30, before: undefined });
    expect(q('.ss-note-title')!.textContent).toBe('Severance · S01E03');
    expect(q('.ss-note-meta')!.textContent).toBe('à 3:32 · il y a 2 h');
    expect(q('.ss-note-body')!.textContent).toBe('« Quel plan ! »');
  });

  it('affiche un émoji en grand, sans guillemets', async () => {
    getNotes.mockResolvedValue({ notes: [note({ kind: 'emoji', body: '😱' })] });
    await mount();
    const b = q('.ss-note-body')!;
    expect(b.classList.contains('is-emoji')).toBe(true);
    expect(b.textContent).toBe('😱');
  });

  it('masque le contenu d’une note Anti-spoiler et la rend non cliquable', async () => {
    getNotes.mockResolvedValue({ notes: [note({ hidden: true, body: '' })] });
    await mount();
    expect(q('.ss-note-body')!.classList.contains('is-hidden')).toBe(true);
    expect(q('.ss-note-body')!.textContent).toContain('Anti-spoiler');
    expect(byFn('open')).toBeNull();
  });

  it('échappe un corps et un titre hostiles', async () => {
    meta.mockResolvedValue({ title: '<img src=x onerror=alert(2)>', poster: null } as never);
    getNotes.mockResolvedValue({ notes: [note({ body: '<script>alert(1)</script><b>x</b>' })] });
    await mount();
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('img[onerror]')).toBeNull();
    expect(q('.ss-note-body')!.textContent).toBe('« <script>alert(1)</script><b>x</b> »');
  });

  it('affiche l’état vide', async () => {
    getNotes.mockResolvedValue({ notes: [] });
    await mount();
    expect(host.textContent).toContain('Aucune note pour l’instant.');
  });

  it('affiche l’état de chargement avant la réponse', () => {
    getNotes.mockReturnValue(new Promise(() => undefined));
    api = createFriendNotes({ toast, myPid: () => ME });
    api.bind(host);
    api.load(FRIEND);
    expect(host.textContent).toContain('Chargement');
  });

  it('indique un historique non partagé sur un 403 hidden', async () => {
    getNotes.mockRejectedValue(new UserApiError(403, 'hidden'));
    await mount();
    expect(host.textContent).toContain('historique n’est pas partagé');
    expect(byFn('retry')).toBeNull();
  });

  it('propose Réessayer après une erreur puis recharge', async () => {
    getNotes.mockRejectedValueOnce(new UserApiError(500, 'server_error'));
    await mount();
    expect(q('[role="alert"]')!.textContent).toContain('Notes indisponibles');
    getNotes.mockResolvedValue({ notes: [note()] });
    click(byFn('retry'));
    await flush();
    expect(getNotes).toHaveBeenCalledTimes(2);
    expect(qa('.ss-note')).toHaveLength(1);
  });
});

describe('pagination', () => {
  it('Voir plus charge la page suivante sans doublon', async () => {
    const first = Array.from({ length: 30 }, (_, i) => note({ id: 'a' + i, createdAt: NOW - (i + 1) * 60_000 }));
    getNotes.mockResolvedValueOnce({ notes: first });
    await mount();
    expect(qa('.ss-note')).toHaveLength(30);
    const last = first[29];
    getNotes.mockResolvedValueOnce({ notes: [first[29], note({ id: 'b1', createdAt: NOW - 99 * 60_000 })] });
    click(byFn('more'));
    await flush();
    expect(getNotes).toHaveBeenLastCalledWith(FRIEND, { limit: 30, before: last.createdAt });
    expect(qa('.ss-note')).toHaveLength(31);
    expect(byFn('more')).toBeNull();
  });
});

describe('résolution des titres', () => {
  it('regroupe les rendus : un seul pour tous les titres résolus ensemble', async () => {
    getNotes.mockResolvedValue({ notes: [1, 2, 3, 4].map(() => note()) });
    let n = 0;
    meta.mockImplementation((async () => ({ title: 'T' + (n += 1), poster: null })) as never);
    api = createFriendNotes({ toast, myPid: () => ME, onDeleted });
    api.bind(host);
    api.load(FRIEND);
    await Promise.resolve();
    await Promise.resolve();
    let renders = 0;
    new MutationObserver((r) => { renders += r.length; }).observe(host, { childList: true });
    await flush();
    expect(meta).toHaveBeenCalledTimes(4);
    expect(qa('.ss-note-title').map((e) => e.textContent!.split(' ·')[0]).sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
    // liste (1) + un rendu groupé pour les 4 titres (1), pas un par titre
    expect(renders).toBeLessThanOrEqual(2);
  });
});

describe('ouverture', () => {
  it('un clic lance la lecture à la position de la note', async () => {
    const n = note({ pos: 754, media: { type: 'series', tmdbId: 77, season: 2, episode: 5 } });
    getNotes.mockResolvedValue({ notes: [n] });
    await mount();
    click(byFn('open'));
    expect(launch).toHaveBeenCalledTimes(1);
    const [req, , opts] = launch.mock.calls[0];
    expect(req).toMatchObject({ type: 'tv', id: '77', season: 2, episode: 5 });
    expect(opts).toEqual({ resume: 'none', startAt: 754 });
  });
});

describe('Modifier / Supprimer', () => {
  it('absents sur les notes des autres, présents sur les miennes', async () => {
    getNotes.mockResolvedValue({ notes: [note({ id: 'x1' }), note({ id: 'x2', author: author(ME) })] });
    await mount(ME);
    expect(qa('[data-fn="edit"]').map((b) => b.dataset.id)).toEqual(['x2']);
    expect(qa('[data-fn="ask-delete"]').map((b) => b.dataset.id)).toEqual(['x2']);
  });

  async function startEdit(value: string) {
    getNotes.mockResolvedValue({ notes: [note({ id: 'm1', author: author(ME), body: 'Avant' })] });
    await mount(ME);
    click(byFn('edit'));
    const input = q('input[name="body"]') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (q('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return input;
  }

  it('Modifier envoie updateNote(id, {kind, body}) et met à jour la ligne', async () => {
    update.mockResolvedValue({ note: { ...note({ id: 'm1' }), kind: 'text', body: 'Après' } } as never);
    await startEdit('Après');
    expect(update).toHaveBeenCalledWith('m1', { kind: 'text', body: 'Après' });
    expect(q('.ss-note-body')!.textContent).toBe('« Après »');
    await flush();
    expect(toast).toHaveBeenCalledWith('Note modifiée');
  });

  it('Modifier vers un émoji unique envoie kind emoji', async () => {
    update.mockResolvedValue({ note: { ...note({ id: 'm1' }), kind: 'emoji', body: '😂' } } as never);
    await startEdit('😂');
    expect(update).toHaveBeenCalledWith('m1', { kind: 'emoji', body: '😂' });
  });

  it('une erreur annule la modification et rouvre l’édition avec le message', async () => {
    update.mockRejectedValue(new UserApiError(400, 'invalid_body'));
    await startEdit('Après');
    await flush();
    const input = q('input[name="body"]') as HTMLInputElement;
    expect(input.value).toBe('Après');
    expect(q('[role="alert"]')!.textContent).toContain('Note invalide');
    click(byFn('edit-cancel'));
    expect(q('.ss-note-body')!.textContent).toBe('« Avant »');
  });

  it('Supprimer demande confirmation puis appelle deleteNote', async () => {
    getNotes.mockResolvedValue({ notes: [note({ id: 'd1', author: author(ME) })] });
    del.mockResolvedValue(undefined as never);
    await mount(ME);
    click(byFn('ask-delete'));
    expect(q('[role="alertdialog"]')).not.toBeNull();
    expect(del).not.toHaveBeenCalled();
    click(byFn('delete-ok'));
    await flush();
    expect(del).toHaveBeenCalledWith('d1');
    expect(qa('.ss-note')).toHaveLength(0);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Note supprimée');
  });

  it('le focus reste dans la confirmation : Tab et Maj+Tab bouclent', async () => {
    getNotes.mockResolvedValue({ notes: [note({ id: 'd1', author: author(ME) })] });
    await mount(ME);
    click(byFn('ask-delete'));
    const cancel = byFn('delete-cancel')!;
    const ok = byFn('delete-ok')!;
    expect(document.activeElement).toBe(cancel);
    const key = (shiftKey: boolean) => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(ev);
      return ev;
    };
    expect(key(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ok);
    expect(key(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    // Tab au milieu (Annuler -> Supprimer) reste natif.
    expect(key(false).defaultPrevented).toBe(false);
    // Focus sorti de la boîte : on le ramène dedans.
    (host.querySelector('.ss-note-open, .ss-note-row') as HTMLElement | null)?.focus();
    (document.body as HTMLElement).focus();
    const outside = document.createElement('button');
    host.append(outside);
    outside.focus();
    expect(key(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
  });

  it('Annuler la confirmation ne supprime rien', async () => {
    getNotes.mockResolvedValue({ notes: [note({ id: 'd1', author: author(ME) })] });
    await mount(ME);
    click(byFn('ask-delete'));
    click(byFn('delete-cancel'));
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(qa('.ss-note')).toHaveLength(1);
  });

  it('une erreur de suppression remet la note et prévient', async () => {
    getNotes.mockResolvedValue({ notes: [note({ id: 'd1', author: author(ME) })] });
    del.mockRejectedValue(new UserApiError(500, 'server_error'));
    await mount(ME);
    click(byFn('ask-delete'));
    click(byFn('delete-ok'));
    await flush();
    expect(qa('.ss-note')).toHaveLength(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Erreur (server_error).');
  });
});
