// Menu contextuel partout (ODY-180) : affiches, bannières et fiches ouvrent le menu de l'app ;
// le menu natif du navigateur ne s'affiche plus sur un visuel, et reste disponible hors des éléments de l'app.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let ctx: typeof import('../src/ui/ctxmenu.js');
let stateMod: typeof import('../src/ui/state.js');
let partyLaunch: typeof import('../src/ui/partylaunch.js');
let auth: any;

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };
const KID = { ...ADULT, isKid: true, kidMaxAge: 10 };
const MODEL = { key: 'tv:1234', type: 'tv', id: 1234, name: 'Sherlock', posterPath: '/p.jpg', releaseFR: '2010-07-25', cinemaSince: null, overview: '' };

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  stateMod = await import('../src/ui/state.js');
  partyLaunch = await import('../src/ui/partylaunch.js');
  ({ auth } = await import('../src/data/auth'));
});

const asAdult = () => { auth.status = 'ready'; auth.profile = ADULT; };
const asKid = () => { auth.status = 'ready'; auth.profile = KID; };
const asLocal = () => { auth.status = 'local'; auth.profile = null; };
const onFiche = (model: unknown) => { (stateMod.state as any).model = model; (stateMod.state as any).kind = 'fiche'; };

beforeEach(asAdult);

afterEach(() => {
  ctx.closeCtx(false);
  document.getElementById('probe')?.remove();
  onFiche(null);
  (stateMod.state as any).kind = '';
});

/** Monte un fragment dans le corps de page et renvoie son premier élément. */
function mount(html: string): HTMLElement {
  document.getElementById('probe')?.remove();
  const host = document.createElement('div');
  host.id = 'probe';
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

/** Premier élément correspondant à `sel` dans le fragment monté (l'élément monté compris). */
const pick = (sel: string) => document.querySelector('#probe ' + sel) as HTMLElement;
const menu = () => document.querySelector('.ctxmenu') as HTMLElement | null;
const labels = () => Array.from(menu()?.querySelectorAll('button') ?? []).map((b) => b.textContent);

/** Clic droit : renvoie l'événement pour lire `defaultPrevented`. */
function rightClick(el: Element): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
  el.dispatchEvent(ev);
  return ev;
}

describe('cibles du menu contextuel (ODY-180)', () => {
  it('diapositive de la mise en avant : titre résolu, ses boutons compris', () => {
    const slide = mount('<div class="hero-slide" data-slide-key="tv:1234"><button type="button" data-heroplay="tv:1234">Lecture</button><button type="button" data-info="tv:1234">Infos</button></div>');
    expect(ctx.ctxTarget(slide)).toMatchObject({ kind: 'title', key: 'tv:1234' });
    expect(ctx.ctxTarget(pick('[data-heroplay]'))).toMatchObject({ kind: 'title', key: 'tv:1234' });
    expect(ctx.ctxTarget(pick('[data-info]'))).toMatchObject({ kind: 'title', key: 'tv:1234' });
  });

  it('« Lecture » d’une rangée à venir (data-play-key) : clé du titre', () => {
    expect(ctx.ctxTarget(mount('<button type="button" data-play data-play-key="tv:55">Lecture</button>'))).toMatchObject({ kind: 'title', key: 'tv:55' });
  });

  it('carte à venir non jouable (data-open) hors catalogue chargé : titre résolu par sa clé', () => {
    expect(ctx.ctxTarget(mount('<button type="button" data-open="tv:56">Épisode</button>'))).toMatchObject({ kind: 'title', key: 'tv:56' });
    expect(ctx.ctxTarget(mount('<button type="button" data-open="true">Interrupteur</button>'))).toBeNull();
  });

  it('émission (data-showopen) : identifiant numérique seulement', () => {
    expect(ctx.ctxTarget(mount('<button type="button" data-showopen="123">Émission</button>'))).toMatchObject({ kind: 'show', key: 'tv:123' });
    expect(ctx.ctxTarget(mount('<button type="button" data-showopen="epg:x">Guide</button>'))).toBeNull();
  });

  it('fiche : affiche de fond et logo du titre ouvert', () => {
    onFiche(MODEL);
    mount('<div class="f-bg"><img src="/bg.jpg" alt=""></div>');
    expect(ctx.ctxTarget(pick('.f-bg img'))).toMatchObject({ kind: 'fiche', model: MODEL });
    mount('<h1 class="f-title"><img class="logo-img f-logo" src="/l.png" alt=""></h1>');
    expect(ctx.ctxTarget(pick('img.f-logo'))).toMatchObject({ kind: 'fiche', model: MODEL });
  });

  it('fiche sans titre ouvert : aucune cible', () => {
    onFiche(null);
    mount('<div class="f-bg"><img src="/bg.jpg" alt=""></div>');
    expect(ctx.ctxTarget(pick('.f-bg img'))).toBeNull();
  });

  it.each<[string, string, string]>([
    ['diapositive de la mise en avant', '<div class="hero-slide" data-slide-key="tv:1234"><h2>Sherlock</h2></div>', 'h2'],
    ['bouton « Lecture » de la mise en avant', '<div class="hero-slide" data-slide-key="tv:1234"><button type="button" data-heroplay="tv:1234">Lecture</button></div>', '[data-heroplay]'],
    ['bouton « Plus d’infos » de la mise en avant', '<div class="hero-slide" data-slide-key="tv:1234"><button type="button" data-info="tv:1234">Infos</button></div>', '[data-info]'],
    ['bouton « Lecture » d’une rangée à venir', '<button type="button" data-play data-play-key="tv:55">Lecture</button>', 'button'],
    ['affiche d’une émission', '<button type="button" data-showopen="123"><img src="/a.jpg" alt=""></button>', 'img'],
    ['affiche de fond de la fiche', '<div class="f-bg"><img src="/bg.jpg" alt=""></div>', 'img'],
    ['logo de la fiche', '<h1 class="f-title"><img class="logo-img f-logo" src="/l.png" alt=""></h1>', 'img'],
  ])('clic droit sur %s : menu de l’app, menu natif prévenu', (_label, html, sel) => {
    onFiche(MODEL);
    mount(html);
    const ev = rightClick(pick(sel));
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(menu()!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
  });

  it('image sans clé : menu natif prévenu, aucun menu', () => {
    const ev = rightClick(mount('<img src="/photo.jpg" alt="">'));
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
  });

  it('texte hors cible : menu natif conservé', () => {
    const ev = rightClick(mount('<p>Un texte</p>'));
    expect(ev.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });
});

describe('entrées « Partager » et « Proposer une watch party »', () => {
  it('titre hors catalogue, compte connecté adulte : les deux entrées', () => {
    rightClick(mount('<button type="button" data-showopen="123">Émission</button>'));
    expect(menu()).not.toBeNull();
    expect(labels()).toEqual(expect.arrayContaining(['Partager', 'Proposer une watch party']));
  });

  it('profil enfant : pas de « Partager », la watch party reste proposée (salon privé)', () => {
    asKid();
    rightClick(mount('<button type="button" data-showopen="123">Émission</button>'));
    expect(menu()).not.toBeNull();
    expect(labels()).not.toContain('Partager');
    expect(labels()).toContain('Proposer une watch party');
  });

  it('hors compte connecté : aucune des deux entrées', () => {
    asLocal();
    rightClick(mount('<button type="button" data-showopen="123">Émission</button>'));
    expect(menu()).not.toBeNull();
    expect(labels()).not.toContain('Partager');
    expect(labels()).not.toContain('Proposer une watch party');
  });

  it('fiche, compte adulte : partager et watch party à côté de « Ne plus proposer »', () => {
    onFiche(MODEL);
    mount('<div class="f-bg"><img src="/bg.jpg" alt=""></div>');
    rightClick(pick('.f-bg img'));
    expect(labels()).toEqual(expect.arrayContaining(['Partager', 'Proposer une watch party', 'Ne plus proposer sur l’accueil']));
  });

  it('fiche, profil enfant : seule la watch party (pas de « Partager », pas de « Ne plus proposer »)', () => {
    asKid();
    onFiche(MODEL);
    mount('<div class="f-bg"><img src="/bg.jpg" alt=""></div>');
    rightClick(pick('.f-bg img'));
    expect(labels()).toEqual(['Proposer une watch party']);
  });

  it('titre pas encore sorti : la watch party répond par un message, sans fenêtre', () => {
    onFiche({ ...MODEL, releaseFR: '2099-01-01' });
    mount('<div class="f-bg"><img src="/bg.jpg" alt=""></div>');
    rightClick(pick('.f-bg img'));
    (menu()!.querySelector('[data-ctx="party"]') as HTMLElement).click();
    expect(document.getElementById('toast')!.textContent).toBe('Watch party indisponible pour ce titre');
    expect(document.querySelector('.pld')).toBeNull();
  });

  it('titre disponible : la fenêtre de lancement porte le titre de la fiche', () => {
    onFiche(MODEL);
    mount('<div class="f-bg"><img src="/bg.jpg" alt=""></div>');
    rightClick(pick('.f-bg img'));
    (menu()!.querySelector('[data-ctx="party"]') as HTMLElement).click();
    expect(document.querySelector('.pld-name')?.textContent).toBe('Sherlock');
  });

  it('openPartyDialog : le titre passé en paramètre est celui de la fenêtre', () => {
    onFiche(MODEL);
    partyLaunch.openPartyDialog(mount('<button type="button">Affiche</button>'), { key: 'movie:9', type: 'movie', id: 9, name: 'Autre titre', posterPath: null });
    expect(document.querySelector('.pld-name')?.textContent).toBe('Autre titre');
  });
});
