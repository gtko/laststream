// Soirées planifiées (LAST-199, lot B) : validation du formulaire, création et modification, erreurs du serveur, confirmations
// (annulation, série, départ), feuille de dialogue, feuille « Regarder avec… ». Le client REST est simulé.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { UserApiError } from '../src/data/userApi';

const api = vi.hoisted(() => ({
  listEvenings: vi.fn(), getEvening: vi.fn(), createEvening: vi.fn(), updateEvening: vi.fn(), cancelEvening: vi.fn(), inviteToEvening: vi.fn(),
  removeEveningGuest: vi.fn(), leaveEvening: vi.fn(), stopEveningSeries: vi.fn(),
}));
vi.mock('../src/data/socialV3Api', async (orig) => ({ ...(await orig<typeof import('../src/data/socialV3Api')>()), ...api }));
const parties = vi.hoisted(() => ({ listParties: vi.fn() }));
vi.mock('../src/data/socialApi', async (orig) => ({ ...(await orig<typeof import('../src/data/socialApi')>()), ...parties }));
const hooks = vi.hoisted(() => ({ inviteToParty: vi.fn() }));
vi.mock('../src/ui/socialHooks.js', async (orig) => ({ ...(await orig<any>()), ...hooks }));

let form: typeof import('../src/data/eveningForm');
let store: typeof import('../src/data/eveningsStore');
let social: typeof import('../src/data/socialStore');
let ui: any;
let actions: any;
let ww: any;
let card: any;
let pane: any;

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true, createdAt: '2026-01-01T00:00:00Z' };
const KID = { ...ADULT, id: 'k1', name: 'Léo', isKid: true, kidMaxAge: 10 };
const setAccount = (p: any) => { auth.status = p ? 'ready' : 'local'; auth.profile = p; };
const tick = () => new Promise((r) => setTimeout(r, 20));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const person = (pid: string, name: string, o: Record<string, unknown> = {}) => ({
  pid, handle: { name, tag: 'A1B2', full: name + '#A1B2' }, avatarColor: '#a00', status: 'online', household: false, favorite: false, muted: false, ...o,
});
const ev = (o: Record<string, unknown> = {}): any => ({
  id: 'e1', title: 'Dune 2', startsAt: Date.now() + 2 * DAY, tz: 'Europe/Paris', host: person('p1', 'Greg'), isHost: true,
  guests: [{ profile: person('p2', 'Tom'), response: 'yes' }], status: 'scheduled', overridden: false, ...o,
});
const series = (o: Record<string, unknown> = {}) => ev({ seriesId: 's1', recurrence: { freq: 'weekly', interval: 1 }, ...o });

const dialog = () => document.querySelector<HTMLElement>('.sh[role="dialog"]');
const q = <T extends Element = HTMLElement>(sel: string) => dialog()!.querySelector<T>(sel)!;
const setVal = (sel: string, v: string) => {
  const el = q<HTMLInputElement>(sel);
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = () => q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const future = (days = 3) => {
  const d = new Date(Date.now() + days * DAY);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const toasts = () => document.getElementById('toast')?.textContent ?? '';

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  form = await import('../src/data/eveningForm');
  store = await import('../src/data/eveningsStore');
  social = await import('../src/data/socialStore');
  ui = await import('../src/ui/eveningForm.js');
  actions = await import('../src/ui/eveningActions.js');
  ww = await import('../src/ui/watchWith.js');
  card = await import('../src/ui/eveningCard.js');
  pane = await import('../src/ui/eveningsPane.js');
});

beforeEach(() => {
  setAccount(ADULT);
  store.resetEvenings();
  Object.values(api).forEach((f) => f.mockReset());
  api.listEvenings.mockResolvedValue({ items: [], nextCursor: null });
  api.createEvening.mockResolvedValue(ev());
  [api.updateEvening, api.cancelEvening, api.inviteToEvening, api.removeEveningGuest, api.leaveEvening, api.stopEveningSeries].forEach((f) => f.mockResolvedValue(undefined));
  parties.listParties.mockReset().mockResolvedValue({ rooms: [], nextCursor: null });
  hooks.inviteToParty.mockReset();
  const st = social.getState();
  st.friends = [person('p2', 'Tom'), person('p3', 'Léa'), person('p4', 'Malo', { status: 'offline' })] as any;
  st.household = [person('p9', 'Maison', { household: true })] as any;
});
afterEach(() => {
  document.querySelectorAll('.sh-veil').forEach((n) => n.remove());
  setAccount(null);
  location.hash = '';
});

describe('validation du formulaire', () => {
  const base = { title: 'Dune 2', date: future(), time: '21:00', guests: [] as string[], repeat: 'once' as const, until: '' };
  const now = Date.now();
  const fields = (i: any, o?: any) => form.validateEvening(i, now, o).map((p) => p.field);

  it('formulaire valide : aucun problème', () => expect(fields(base)).toEqual([]));
  it('titre vide, d’espaces, ou de plus de 80 caractères (points de code)', () => {
    expect(fields({ ...base, title: '   ' })).toEqual(['title']);
    expect(fields({ ...base, title: 'a'.repeat(80) })).toEqual([]);
    expect(fields({ ...base, title: 'a'.repeat(81) })).toEqual(['title']);
    expect(fields({ ...base, title: '🎬'.repeat(80) })).toEqual([]);
  });
  it('horaire : absent, passé, dans moins d’une minute, au-delà de 90 jours, 30 février', () => {
    expect(fields({ ...base, date: '' })).toEqual(['when']);
    expect(fields({ ...base, date: '2026-02-30' })).toEqual(['when']);
    expect(fields({ ...base, date: future(-1) })).toEqual(['when']);
    expect(fields({ ...base, date: future(91) })).toEqual(['when']);
    expect(fields({ ...base, date: future(89) })).toEqual([]);
    expect(fields({ ...base, date: future(-1) }, { when: false })).toEqual([]);
  });
  it('plus de 19 invités distincts', () => {
    const many = Array.from({ length: 20 }, (_, i) => 'p' + i);
    expect(fields({ ...base, guests: many })).toEqual(['guests']);
    expect(fields({ ...base, guests: many.slice(0, 19) })).toEqual([]);
    expect(fields({ ...base, guests: [...many.slice(0, 19), 'p0'] })).toEqual([]);
  });
  it('fin de série avant la première soirée ou invalide', () => {
    expect(fields({ ...base, repeat: 'weekly', until: future(1) })).toEqual(['until']);
    expect(fields({ ...base, repeat: 'weekly', until: future(20) })).toEqual([]);
    expect(fields({ ...base, repeat: 'once', until: future(1) })).toEqual([]);
  });
  it('corps de création : titre nettoyé, fuseau, invités dédoublonnés, récurrence', () => {
    const once = form.buildCreateBody({ ...base, title: '  Dune 2  ', guests: ['p2', 'p2', 'p3'] }, 'Europe/Paris');
    expect(once).toEqual({ title: 'Dune 2', startsAt: form.parseLocal(base.date, '21:00'), tz: 'Europe/Paris', guests: ['p2', 'p3'] });
    const bi = form.buildCreateBody({ ...base, repeat: 'biweekly', until: future(30) }, 'UTC');
    expect(bi.recurrence).toEqual({ freq: 'weekly', interval: 2, until: form.parseLocal(future(30), '23:59') + 59_999 });
    expect(form.buildCreateBody({ ...base, repeat: 'weekly' }, 'UTC').recurrence).toEqual({ freq: 'weekly', interval: 1 });
  });
  it('un texte humain par code du serveur, générique sinon', () => {
    expect(form.eveningErrorText(new UserApiError(403, 'not_friend'))).toMatch(/pas \(ou plus\) dans tes amis/);
    expect(form.eveningErrorText(new UserApiError(429, 'too_many_evenings'))).toMatch(/10 soirées/);
    expect(form.eveningErrorText(new UserApiError(400, 'invalid_body'))).toMatch(/refusé/);
    expect(form.eveningErrorText(new UserApiError(500, 'http_500'))).toBe('Cette action est impossible pour le moment.');
    expect(form.eveningErrorText(new Error('x'))).toBe('Cette action est impossible pour le moment.');
  });
});

describe('feuille de création', () => {
  it('dialogue accessible, titre prérempli, focus sur le titre, Échap ferme et rend le focus', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    ui.openEveningForm({ title: ' Severance ', opener });
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Planifier une soirée');
    expect(q<HTMLInputElement>('#evf-title').value).toBe('Severance');
    expect(document.activeElement).toBe(q('#evf-title'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it('Tab reste dans la feuille', () => {
    ui.openEveningForm();
    const items = Array.from(dialog()!.querySelectorAll<HTMLElement>('button, input, select')).filter((x) => !x.closest('[hidden]') && !(x as any).disabled);
    items[items.length - 1].focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });
  it('refusée hors compte et sur un profil enfant', () => {
    setAccount(KID);
    expect(ui.openEveningForm()).toBeNull();
    expect(dialog()).toBeNull();
    setAccount(null);
    expect(ui.openEveningForm()).toBeNull();
  });
  it('invités : amis acceptés seulement (ni foyer), recherche, plafond de 19', () => {
    const st = social.getState();
    st.friends = Array.from({ length: 21 }, (_, i) => person('f' + i, 'Ami' + String(i).padStart(2, '0'))) as any;
    ui.openEveningForm();
    const boxes = () => Array.from(dialog()!.querySelectorAll<HTMLInputElement>('input[name="guest"]'));
    expect(boxes()).toHaveLength(21);
    expect(dialog()!.textContent).not.toContain('Maison');
    setVal('[data-evf-search]', 'ami05');
    expect(Array.from(dialog()!.querySelectorAll('[data-evf-name]')).filter((li) => !(li as HTMLElement).hidden)).toHaveLength(1);
    setVal('[data-evf-search]', 'zzz');
    expect(q('[data-evf-nomatch]').hidden).toBe(false);
    setVal('[data-evf-search]', '');
    boxes().slice(0, 19).forEach((b) => { b.checked = true; b.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(q('[data-evf-count]').textContent).toBe('19 / 19');
    expect(boxes().filter((b) => !b.checked).every((b) => b.disabled)).toBe(true);
  });
  it('sans ami : message qui renvoie vers la page Amis, la création reste possible', () => {
    social.getState().friends = [] as any;
    ui.openEveningForm();
    expect(dialog()!.textContent).toMatch(/Aucun ami à inviter/);
    expect(dialog()!.querySelector('input[name="guest"]')).toBeNull();
  });
  it('formulaire invalide : aucun appel, erreurs liées aux champs, focus sur le premier', () => {
    ui.openEveningForm();
    setVal('#evf-title', '  ');
    setVal('#evf-date', '');
    submit();
    expect(api.createEvening).not.toHaveBeenCalled();
    expect(q('#evf-title').getAttribute('aria-invalid')).toBe('true');
    expect(q('#evf-err-title').hidden).toBe(false);
    expect(q('#evf-err-when').textContent).toMatch(/date et une heure/);
    expect(document.activeElement).toBe(q('#evf-title'));
    setVal('#evf-title', 'Dune');
    expect(q('#evf-title').hasAttribute('aria-invalid')).toBe(false);
  });
  it('création : corps envoyé (fuseau local, invités, récurrence), un seul appel malgré le double envoi, feuille fermée après succès', async () => {
    let done!: (e: any) => void;
    api.createEvening.mockImplementation(() => new Promise((r) => { done = r; }));
    ui.openEveningForm();
    setVal('#evf-title', 'Dune 2');
    setVal('#evf-date', future());
    setVal('#evf-time', '20:30');
    setVal('#evf-repeat', 'biweekly');
    q<HTMLInputElement>('[data-evf-until] input').value = future(30);
    const tom = q<HTMLInputElement>('input[name="guest"][value="p2"]');
    tom.checked = true;
    tom.dispatchEvent(new Event('input', { bubbles: true }));
    submit();
    submit();
    expect(api.createEvening).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('[data-evf-submit]').disabled).toBe(true);
    const body = api.createEvening.mock.calls[0][0];
    expect(body).toMatchObject({ title: 'Dune 2', startsAt: form.parseLocal(future(), '20:30'), tz: form.localTimeZone(), guests: ['p2'] });
    expect(body.recurrence).toEqual({ freq: 'weekly', interval: 2, until: form.parseLocal(future(30), '23:59') + 59_999 });
    done(ev());
    await tick();
    expect(dialog()).toBeNull();
    expect(toasts()).toMatch(/Soirée planifiée/);
  });
  it('erreur du serveur : message traduit dans la feuille, bouton rendu, nouvel essai possible', async () => {
    api.createEvening.mockRejectedValueOnce(new UserApiError(403, 'not_friend')).mockRejectedValueOnce(new UserApiError(429, 'too_many_evenings'));
    ui.openEveningForm({ title: 'Dune' });
    submit();
    await tick();
    expect(dialog()).not.toBeNull();
    expect(q('[data-evf-server]').textContent).toMatch(/pas \(ou plus\) dans tes amis/);
    expect(q<HTMLButtonElement>('[data-evf-submit]').disabled).toBe(false);
    submit();
    await tick();
    expect(q('[data-evf-server]').textContent).toMatch(/10 soirées/);
    expect(api.createEvening).toHaveBeenCalledTimes(2);
  });
  it('génération périmée : changement de profil pendant l’appel, la feuille se ferme sans toast ni écriture', async () => {
    let done!: (e: any) => void;
    api.createEvening.mockImplementation(() => new Promise((r) => { done = r; }));
    ui.openEveningForm({ title: 'Dune' });
    submit();
    setAccount({ ...ADULT, id: 'p7' });
    store.resetEvenings();
    document.getElementById('toast')?.replaceChildren();
    done(ev());
    await tick();
    expect(dialog()).toBeNull();
    expect(toasts()).not.toMatch(/planifiée/);
    expect(api.listEvenings).not.toHaveBeenCalled();
  });
  it('fermée pendant l’appel : la réponse tardive n’écrit rien', async () => {
    let fail!: (e: any) => void;
    api.createEvening.mockImplementation(() => new Promise((_, r) => { fail = r; }));
    const sheet = ui.openEveningForm({ title: 'Dune' });
    submit();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).not.toBeNull();
    sheet.close();
    fail(new UserApiError(403, 'not_friend'));
    await tick();
    expect(dialog()).toBeNull();
  });
});

describe('modification', () => {
  it('soirée récurrente : choix de la portée, PATCH, invités retirés puis ajoutés, relecture de la série', async () => {
    api.getEvening.mockResolvedValue(series());
    ui.openEveningForm({ evening: series() });
    expect(dialog()!.textContent).toMatch(/Toute la série/);
    expect(q<HTMLInputElement>('#evf-title').value).toBe('Dune 2');
    setVal('#evf-title', 'Dune 2 (VO)');
    q<HTMLInputElement>('input[name="scope"][value="series"]').checked = true;
    const tom = q<HTMLInputElement>('input[name="guest"][value="p2"]');
    tom.checked = false;
    const lea = q<HTMLInputElement>('input[name="guest"][value="p3"]');
    lea.checked = true;
    submit();
    await tick();
    expect(api.updateEvening).toHaveBeenCalledWith('e1', { title: 'Dune 2 (VO)', scope: 'series' });
    expect(api.removeEveningGuest).toHaveBeenCalledWith('e1', 'p2');
    expect(api.inviteToEvening).toHaveBeenCalledWith('e1', ['p3']);
    expect(dialog()).toBeNull();
  });
  it('soirée ponctuelle : pas de choix de portée ; horaire inchangé non renvoyé ; rien à changer : aucun appel', async () => {
    ui.openEveningForm({ evening: ev() });
    expect(dialog()!.querySelector('input[name="scope"]')).toBeNull();
    submit();
    await tick();
    expect(api.updateEvening).not.toHaveBeenCalled();
    expect(api.inviteToEvening).not.toHaveBeenCalled();
    expect(api.removeEveningGuest).not.toHaveBeenCalled();
  });
  it('nouvel horaire : startsAt envoyé avec la portée « occurrence »', async () => {
    api.getEvening.mockResolvedValue(ev());
    ui.openEveningForm({ evening: ev() });
    setVal('#evf-date', future(5));
    setVal('#evf-time', '19:15');
    submit();
    await tick();
    expect(api.updateEvening).toHaveBeenCalledWith('e1', { startsAt: form.parseLocal(future(5), '19:15'), scope: 'occurrence' });
  });
  it('erreur not_host / evening_closed expliquée, feuille ouverte', async () => {
    api.updateEvening.mockRejectedValue(new UserApiError(409, 'evening_closed'));
    api.getEvening.mockResolvedValue(ev());
    ui.openEveningForm({ evening: ev() });
    setVal('#evf-title', 'Autre');
    submit();
    await tick();
    expect(q('[data-evf-server]').textContent).toMatch(/annulée ou a déjà commencé/);
  });
});

describe('annulation, arrêt de série, départ', () => {
  const confirm = async () => { q('[data-evc-ok]').click(); await tick(); };
  it('annuler : confirmation, puis DELETE de l’occurrence', async () => {
    api.getEvening.mockResolvedValue(ev({ status: 'cancelled' }));
    actions.openEveningAction('cancel', ev(), null);
    expect(dialog()!.textContent).toMatch(/Annuler cette soirée \?/);
    expect(api.cancelEvening).not.toHaveBeenCalled();
    await confirm();
    expect(api.cancelEvening).toHaveBeenCalledWith('e1', 'occurrence');
    expect(dialog()).toBeNull();
    expect(toasts()).toMatch(/Soirée annulée/);
  });
  it('garder la soirée : aucun appel', () => {
    actions.openEveningAction('cancel', ev(), null);
    q('[data-sheet-close]').click();
    expect(dialog()).toBeNull();
    expect(api.cancelEvening).not.toHaveBeenCalled();
  });
  it('arrêter la série : POST /stop, toutes les listes relues', async () => {
    actions.openEveningAction('stop', series(), null);
    await confirm();
    expect(api.stopEveningSeries).toHaveBeenCalledWith('e1');
    expect(api.cancelEvening).not.toHaveBeenCalled();
  });
  it('quitter une série : portée au choix (occurrence par défaut, ou série)', async () => {
    const guest = series({ isHost: false, myResponse: 'yes' });
    actions.openEveningAction('leave', guest, null);
    await confirm();
    expect(api.leaveEvening).toHaveBeenLastCalledWith('e1', 'occurrence');
    actions.openEveningAction('leave', guest, null);
    q<HTMLInputElement>('input[name="scope"][value="series"]').checked = true;
    await confirm();
    expect(api.leaveEvening).toHaveBeenLastCalledWith('e1', 'series');
  });
  it('quitter une soirée ponctuelle : pas de choix de portée', () => {
    actions.openEveningAction('leave', ev({ isHost: false, myResponse: 'yes' }), null);
    expect(dialog()!.querySelector('input[name="scope"]')).toBeNull();
  });
  it('erreur du serveur : message dans la feuille, bouton rendu ; double clic : un seul appel', async () => {
    api.cancelEvening.mockRejectedValueOnce(new UserApiError(403, 'not_host'));
    actions.openEveningAction('cancel', ev(), null);
    q('[data-evc-ok]').click();
    q('[data-evc-ok]').click();
    await tick();
    expect(api.cancelEvening).toHaveBeenCalledTimes(1);
    expect(q('[data-evc-err]').textContent).toMatch(/Seul l’hôte/);
    expect(q<HTMLButtonElement>('[data-evc-ok]').disabled).toBe(false);
  });
  it('profil changé pendant l’appel : feuille fermée sans toast', async () => {
    let done!: () => void;
    api.cancelEvening.mockImplementation(() => new Promise<void>((r) => { done = r; }));
    actions.openEveningAction('cancel', ev(), null);
    q('[data-evc-ok]').click();
    setAccount({ ...ADULT, id: 'p7' });
    store.resetEvenings();
    document.getElementById('toast')?.replaceChildren();
    done();
    await tick();
    expect(dialog()).toBeNull();
    expect(toasts()).not.toMatch(/annulée/);
  });
});

describe('carte et onglets', () => {
  const NOW = Date.now();
  const html = (e: any) => card.eveningCardHTML(e, { now: NOW });
  const acts = (e: any) => Array.from(new DOMParser().parseFromString(html(e), 'text/html').querySelectorAll('[data-evening-act]')).map((b) => b.getAttribute('data-evening-act'));

  it('hôte : modifier et annuler ; hôte d’une série : aussi arrêter la série', () => {
    expect(acts(ev())).toEqual(expect.arrayContaining(['e1:edit', 'e1:cancel']));
    expect(acts(ev())).not.toContain('e1:stop');
    expect(acts(series())).toEqual(expect.arrayContaining(['e1:edit', 'e1:cancel', 'e1:stop']));
  });
  it('invité : quitter (soirée acceptée ou série), pas de gestion d’hôte', () => {
    expect(acts(ev({ isHost: false, myResponse: 'pending' }))).not.toContain('e1:leave');
    expect(acts(ev({ isHost: false, myResponse: 'yes' }))).toContain('e1:leave');
    expect(acts(series({ isHost: false, myResponse: 'pending' }))).toContain('e1:leave');
    expect(acts(ev({ isHost: false, myResponse: 'yes' }))).not.toContain('e1:edit');
  });
  it('soirée annulée ou commencée : aucune gestion', () => {
    expect(acts(ev({ status: 'cancelled' })).filter((a) => /:(edit|cancel|stop|leave)$/.test(a!))).toEqual([]);
    expect(acts(ev({ startsAt: NOW - HOUR })).filter((a) => /:(edit|cancel|stop|leave)$/.test(a!))).toEqual([]);
  });
  it('titre hostile échappé dans la carte', () => {
    expect(html(ev({ title: '<img src=x onerror=alert(1)>' }))).not.toContain('<img src=x');
  });
  it('clic sur « Modifier » et « Annuler » depuis l’onglet : la feuille s’ouvre', async () => {
    api.listEvenings.mockImplementation(async (scope: string) => ({ items: scope === 'upcoming' ? [ev({ startsAt: NOW + 5 * DAY })] : [], nextCursor: null }));
    const { showEnsemble } = await import('../src/ui/ensemble.js');
    showEnsemble('a-venir');
    await tick();
    const click = (act: string) => document.querySelector<HTMLElement>('[data-evening-act="e1:' + act + '"]')!.click();
    click('edit');
    expect(dialog()!.textContent).toMatch(/Modifier la soirée/);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    click('cancel');
    expect(dialog()!.textContent).toMatch(/Annuler cette soirée/);
    expect(pane.EVENING_TABS).toContain('a-venir');
  });
  it('bouton « Planifier une soirée » de la page Ensemble : ouvre la feuille de création', async () => {
    const { showEnsemble } = await import('../src/ui/ensemble.js');
    showEnsemble('a-venir');
    document.querySelector<HTMLElement>('[data-ens-plan]')!.click();
    expect(dialog()!.textContent).toMatch(/Planifier une soirée/);
  });
});

describe('feuille « Regarder avec… »', () => {
  const room = (o: Record<string, unknown> = {}) => ({ id: 'r1', title: 'Severance', host: 'Léa', participants: 1, maxParticipants: 6, mediaType: 'series', ...o });

  it('amis en salon : Rejoindre ; amis en ligne : Inviter ; hors ligne, foyer et sourdine absents', async () => {
    parties.listParties.mockResolvedValue({ rooms: [room()], nextCursor: null });
    social.getState().friends = [person('p2', 'Tom'), person('p3', 'Léa'), person('p4', 'Malo', { status: 'offline' }), person('p5', 'Zoé', { muted: true })] as any;
    ww.openWatchWith(null, { name: 'Severance' });
    await tick();
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.querySelector('h2')!.textContent).toBe('Regarder avec…');
    expect(d.querySelector<HTMLAnchorElement>('a[href="#/party/r1"]')!.textContent).toBe('Rejoindre');
    expect(d.querySelector('[data-ww-invite="p2"]')).not.toBeNull();
    expect(d.textContent).not.toContain('Malo');
    expect(d.textContent).not.toContain('Zoé');
    expect(d.textContent).not.toContain('Maison');
  });
  it('Inviter ferme la feuille et lance le flux d’invitation de salon existant', () => {
    ww.openWatchWith(null, { name: 'Severance' });
    q('[data-ww-invite="p2"]').click();
    expect(dialog()).toBeNull();
    expect(hooks.inviteToParty).toHaveBeenCalledWith('p2');
  });
  it('sans ami : message clair, « Planifier une soirée » reste proposé', () => {
    social.getState().friends = [] as any;
    ww.openWatchWith(null, { name: 'Severance' });
    expect(dialog()!.textContent).toMatch(/pas encore d’amis/);
    expect(dialog()!.querySelector('[data-ww-plan]')).not.toBeNull();
  });
  it('amis tous hors ligne : message dédié', () => {
    social.getState().friends = [person('p4', 'Malo', { status: 'offline' })] as any;
    ww.openWatchWith(null, { name: 'Severance' });
    expect(dialog()!.textContent).toMatch(/Aucun ami n’est en ligne/);
  });
  it('« Planifier une soirée » : ouvre la création avec le titre du film prérempli', () => {
    ww.openWatchWith(null, { name: 'Dune : Deuxième partie' });
    q('[data-ww-plan]').click();
    expect(dialog()!.textContent).toMatch(/Planifier une soirée/);
    expect(q<HTMLInputElement>('#evf-title').value).toBe('Dune : Deuxième partie');
    expect(document.querySelectorAll('.sh[role="dialog"]')).toHaveLength(1);
  });
  it('profil enfant ou hors compte : pas de feuille, l’appelant garde la boîte d’origine', () => {
    setAccount(KID);
    expect(ww.openWatchWith(null, { name: 'x' })).toBeNull();
    setAccount(null);
    expect(ww.openWatchWith(null, { name: 'x' })).toBeNull();
    expect(dialog()).toBeNull();
  });
  it('génération périmée : salons reçus après un changement de profil ou la fermeture, ignorés', async () => {
    let done!: (r: any) => void;
    parties.listParties.mockImplementation(() => new Promise((r) => { done = r; }));
    social.getState().friends = [person('p3', 'Léa')] as any;
    const sheet = ww.openWatchWith(null, { name: 'Severance' });
    expect(q('[data-ww-invite="p3"]')).not.toBeNull();
    setAccount({ ...ADULT, id: 'p7' });
    done({ rooms: [room()], nextCursor: null });
    await tick();
    expect(dialog()!.querySelector('a[href="#/party/r1"]')).toBeNull();
    sheet.close();
    expect(dialog()).toBeNull();
  });
});
