// Console d'administration, espace Système « Annonces » : état (active, planifiée, expirée, désactivée), validation du formulaire
// (titre 80, message 500, fin après début), conversion datetime-local, rendu de la liste et du formulaire, échappement.
import { describe, expect, it } from 'vitest';

// `dom.js` (toast, détail, modale) lit la page à l'import : on pose le squelette minimal avant de charger le module.
document.body.innerHTML = '<div id="app"></div><div id="detail" hidden></div><div id="modal" hidden><div class="modal"><div id="modal-body"></div></div><button id="modal-close"></button></div><div id="toast"></div>';
const {
  announcementInput, announcementState, announcementsHTML, announcementWindow, fromLocalInput, toLocalInput,
} = await import('../src/ui/admin/system.js');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ann = (over: Record<string, unknown> = {}) => ({
  id: 'a1', title: 'Maintenance', message: 'Ce soir à 22 h.', level: 'warning', startsAt: null, endsAt: null,
  active: true, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', ...over,
});
const ready = (announcements: unknown[]) => ({ status: 'ready', error: '', value: { announcements } });
const S = (over: Record<string, unknown> = {}) => ({ announcements: ready([]), annEdit: null, ...over }) as any;

describe('état d’une annonce', () => {
  it('désactivée sans regarder les dates ; planifiée ; expirée ; active dans sa fenêtre', () => {
    expect(announcementState(ann({ active: false }), NOW)).toBe('off');
    expect(announcementState(ann({ startsAt: '2026-10-21T00:00:00.000Z' }), NOW)).toBe('planned');
    expect(announcementState(ann({ endsAt: '2026-10-19T00:00:00.000Z' }), NOW)).toBe('expired');
    expect(announcementState(ann({ startsAt: '2026-10-19T00:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' }), NOW)).toBe('active');
    expect(announcementState(ann(), NOW)).toBe('active');
  });

  it('fenêtre en clair', () => {
    expect(announcementWindow(ann())).toBe('Sans limite');
    expect(announcementWindow(ann({ startsAt: '2026-10-21T00:00:00.000Z' }))).toMatch(/^Dès /);
    expect(announcementWindow(ann({ endsAt: '2026-10-21T00:00:00.000Z' }))).toMatch(/^Jusqu’au /);
    expect(announcementWindow(ann({ startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' }))).toContain(' → ');
  });
});

describe('formulaire : validation et corps envoyé', () => {
  const raw = (over: Record<string, string> = {}) => ({ title: 'Bonjour', message: 'Texte', level: 'info', startsAt: '', endsAt: '', ...over });

  it('titre requis, 80 caractères au plus (après rognage)', () => {
    expect(announcementInput(raw({ title: '   ' })).error).toMatch(/titre/);
    expect(announcementInput(raw({ title: 'x'.repeat(81) })).error).toMatch(/80 caractères/);
    expect(announcementInput(raw({ title: 'x'.repeat(80) })).error).toBeNull();
  });

  it('message requis, 500 caractères au plus', () => {
    expect(announcementInput(raw({ message: '' })).error).toMatch(/message/);
    expect(announcementInput(raw({ message: 'y'.repeat(501) })).error).toMatch(/500 caractères/);
    expect(announcementInput(raw({ message: 'y'.repeat(500) })).error).toBeNull();
  });

  it('niveau info ou warning seulement', () => {
    expect(announcementInput(raw({ level: 'danger' })).error).toMatch(/niveau/);
    expect(announcementInput(raw({ level: 'warning' })).body?.level).toBe('warning');
  });

  it('fin strictement après le début, quand les deux sont donnés', () => {
    const bad = announcementInput(raw({ startsAt: '2026-10-20T12:00', endsAt: '2026-10-20T12:00' }));
    expect(bad.error).toBe('La fin doit être postérieure au début.');
    expect(bad.body).toBeNull();
    expect(announcementInput(raw({ startsAt: '2026-10-20T12:00', endsAt: '' })).error).toBeNull();
  });

  it('corps : titre et message rognés, dates en ISO UTC, absentes = null', () => {
    const r = announcementInput(raw({ title: '  Bonjour  ', startsAt: '2026-10-20T10:00', endsAt: '' }));
    expect(r.error).toBeNull();
    expect(r.body).toEqual({
      title: 'Bonjour', message: 'Texte', level: 'info',
      startsAt: new Date('2026-10-20T10:00').toISOString(), endsAt: null,
    });
  });

  it('datetime-local : aller-retour en heure locale', () => {
    const iso = new Date(2026, 9, 20, 10, 5).toISOString();
    expect(toLocalInput(iso)).toBe('2026-10-20T10:05');
    expect(fromLocalInput('2026-10-20T10:05')).toBe(iso);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('pas une date')).toBeUndefined();
  });
});

describe('liste des annonces', () => {
  it('titre, niveau, fenêtre et état affichés ; titre et message échappés', () => {
    const html = announcementsHTML(S({
      announcements: ready([
        ann({ id: 'a1', title: '<img src=x onerror=alert(1)>', message: 'Texte <b>gras</b>' }),
        ann({ id: 'a2', title: 'Plus tard', level: 'info', startsAt: '2026-12-01T00:00:00.000Z', active: true }),
        ann({ id: 'a3', title: 'Finie', endsAt: '2020-01-01T00:00:00.000Z' }),
        ann({ id: 'a4', title: 'Coupée', active: false }),
      ]),
    }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Texte &lt;b&gt;gras&lt;/b&gt;');
    expect(html).toContain('>Attention<');
    expect(html).toContain('>Information<');
    expect(html).toContain('>Active<');
    expect(html).toContain('>Planifiée<');
    expect(html).toContain('>Expirée<');
    expect(html).toContain('>Désactivée<');
    expect(html).toContain('data-adm-anntoggle="a4"');
    expect(html).toContain('>Désactiver<');
    expect(html).toContain('>Activer<');
  });

  it('liste vide : message clair ; chargement : pas de liste', () => {
    expect(announcementsHTML(S())).toContain('Aucune annonce pour l’instant.');
    expect(announcementsHTML({ announcements: { status: 'loading', value: null, error: '' }, annEdit: null } as any)).toContain('Chargement…');
  });
});

describe('formulaire d’annonce', () => {
  it('création : formulaire vide, sans identifiant', () => {
    const html = announcementsHTML(S({ annEdit: 'new' }));
    expect(html).toContain('Nouvelle annonce');
    expect(html).toContain('data-ann-id=""');
    expect(html).toContain('maxlength="80"');
    expect(html).toContain('maxlength="500"');
    expect(html).toContain('type="datetime-local" name="startsAt"');
  });

  it('modification : valeurs de l’annonce (échappées), dates au format datetime-local', () => {
    const start = new Date(2026, 9, 20, 9, 30).toISOString();
    const html = announcementsHTML(S({
      annEdit: 'a1',
      announcements: ready([ann({ id: 'a1', title: 'Titre "guillemets"', startsAt: start })]),
    }));
    expect(html).toContain('data-ann-id="a1"');
    expect(html).toContain('value="Titre &quot;guillemets&quot;"');
    expect(html).toContain('value="2026-10-20T09:30"');
  });
});
