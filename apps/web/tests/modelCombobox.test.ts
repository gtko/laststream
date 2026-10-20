// Combobox du modèle OpenRouter (Réglages > Serveur) : repli en saisie libre, chargement, ARIA, clavier, filtre, feuille mobile.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CACHE_KEY } from '../src/data/openrouterModels';

const RAW = {
  data: [
    { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', context_length: 128000, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    { id: 'openai/gpt-4.1', name: 'OpenAI: GPT-4.1', context_length: 1047576, pricing: { prompt: '0.000002', completion: '0.000008' } },
    { id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4', context_length: 1000000, pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'zeta/eclair:free', name: 'Zeta: Éclair (free)', context_length: 32000, pricing: { prompt: '0', completion: '0' } },
  ],
};

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let fetchOk = false;
let release: () => void = () => undefined;
const fetchMock = vi.fn(async () => {
  if (!fetchOk) throw new TypeError('Failed to fetch');
  await new Promise<void>((r) => { release = r; });
  return new Response(JSON.stringify(RAW));
});

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const root = () => $('[data-mcb]');
const input = () => $<HTMLInputElement>('#m1');
const hidden = () => $<HTMLInputElement>('input[name="svc.openrouterModel"]');
const options = () => Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[];
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const activeOpt = () => document.getElementById(input().getAttribute('aria-activedescendant') || '');

beforeAll(async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  const { modelComboHTML } = await import('../src/ui/model-combobox.js');
  document.body.innerHTML = '<form id="f"><div class="set-row"><label for="m1">Modèle OpenRouter</label>' + modelComboHTML('m1', 'openai/gpt-4o-mini') + '</div></form><button id="ailleurs">x</button>';
  await settle(10);
});

describe('erreur réseau : saisie libre', () => {
  it('bandeau, champ libre avec la valeur enregistrée, et le formulaire lit toujours svc.openrouterModel', () => {
    expect(root().classList.contains('is-free')).toBe(true);
    expect(($('.mcb-warn') as HTMLElement).hidden).toBe(false);
    expect(input().getAttribute('role')).toBeNull();
    expect(input().value).toBe('openai/gpt-4o-mini');
    type(input(), '  mon/modele  ');
    expect(new FormData($<HTMLFormElement>('#f')).get('svc.openrouterModel')).toBe('mon/modele');
    type(input(), 'openai/gpt-4o-mini');
  });

  it('« Réessayer » : squelettes (role=status) puis liste ouverte et mise en cache', async () => {
    fetchOk = true;
    $<HTMLButtonElement>('[data-mcb-retry]').click();
    expect(root().classList.contains('is-free')).toBe(false);
    expect(root().classList.contains('is-open')).toBe(true);
    expect(($('.mcb-sk-wrap[role="status"]') as HTMLElement).hidden).toBe(false);
    expect($('.mcb-count').textContent).toBe('Chargement…');
    release();
    await settle(10);
    expect(($('.mcb-sk-wrap') as HTMLElement).hidden).toBe(true);
    expect(options()).toHaveLength(4);
    expect($('.mcb-count').textContent).toBe('4 modèles · prix par million de tokens (entrée / sortie)');
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).models).toHaveLength(4);
  });
});

describe('combobox ARIA et clavier', () => {
  it('rôles, groupes par fournisseur, modèle actuel coché et actif', () => {
    const lb = $('[role="listbox"]');
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-controls')).toBe(lb.id);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(document.querySelectorAll('.mcb-grp')).map((g) => g.textContent)).toEqual(['Anthropic', 'OpenAI', 'Zeta']);
    const cur = options().find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(cur.dataset.mcbOpt).toBe('openai/gpt-4o-mini');
    expect(cur.classList.contains('is-cur')).toBe(true);
    expect(activeOpt()).toBe(cur);
    expect(cur.textContent).toContain('Économique');
    expect(options()[3].textContent).toContain('Gratuit');
  });

  it('↑/↓ circulaires, Début/Fin, Échap ferme et vide la recherche', () => {
    const ids = () => activeOpt()?.dataset.mcbOpt;
    key(input(), 'End');
    expect(ids()).toBe('zeta/eclair:free');
    key(input(), 'ArrowDown');
    expect(ids()).toBe('anthropic/claude-sonnet-4');
    key(input(), 'ArrowUp');
    expect(ids()).toBe('zeta/eclair:free');
    key(input(), 'Home');
    expect(ids()).toBe('anthropic/claude-sonnet-4');
    type(input(), 'claude');
    const esc = key(input(), 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(root().classList.contains('is-open')).toBe(false);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
    expect(input().value).toBe('GPT-4o-mini');
    expect($('#m1-cp').textContent!.replace(/ /g, ' ')).toBe('0,15 $ / 0,60 $');
  });

  it('Entrée choisit le modèle actif : valeur enregistrée = id, estimation mise à jour', () => {
    key(input(), 'ArrowDown');
    expect(root().classList.contains('is-open')).toBe(true);
    type(input(), 'ECLAIR');
    expect(options().map((o) => o.dataset.mcbOpt)).toEqual(['zeta/eclair:free']);
    const enter = key(input(), 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(hidden().value).toBe('zeta/eclair:free');
    expect(input().value).toBe('Éclair');
    expect($('.mcb-est').textContent).toContain('modèle gratuit');
  });

  it('clic sur une option, tri (aria-pressed), fermeture au clic extérieur', () => {
    input().dispatchEvent(new Event('focusin', { bubbles: true }));
    expect(root().classList.contains('is-open')).toBe(true);
    $<HTMLButtonElement>('[data-mcb-sort="price"]').click();
    expect($('[data-mcb-sort="price"]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-mcb-sort="name"]').getAttribute('aria-pressed')).toBe('false');
    const openai = options().filter((o) => o.dataset.mcbOpt!.startsWith('openai/')).map((o) => o.dataset.mcbOpt);
    expect(openai).toEqual(['openai/gpt-4o-mini', 'openai/gpt-4.1']);
    options().find((o) => o.dataset.mcbOpt === 'openai/gpt-4.1')!.click();
    expect(hidden().value).toBe('openai/gpt-4.1');
    expect(root().classList.contains('is-open')).toBe(false);
    input().dispatchEvent(new Event('focusin', { bubbles: true }));
    expect(root().classList.contains('is-open')).toBe(true);
    $('#ailleurs').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root().classList.contains('is-open')).toBe(false);
  });
});

describe('aucun résultat et identifiant personnalisé', () => {
  it('liste vide → identifiant personnalisé → revenir à la liste', () => {
    key(input(), 'ArrowDown');
    type(input(), 'zzz/inconnu');
    expect(options()).toHaveLength(0);
    expect(($('.mcb-empty') as HTMLElement).hidden).toBe(false);
    expect($('.mcb-empty').textContent).toContain('Aucun modèle pour « zzz/inconnu »');
    $<HTMLButtonElement>('.mcb-empty [data-mcb-custom]').click();
    expect(root().classList.contains('is-free')).toBe(true);
    expect(hidden().value).toBe('zzz/inconnu');
    expect(($('.mcb-note') as HTMLElement).hidden).toBe(false);
    expect($('.mcb-est').textContent).toMatch(/^Coût inconnu/);
    $<HTMLButtonElement>('[data-mcb-back]').click();
    expect(root().classList.contains('is-free')).toBe(false);
    expect(hidden().value).toBe('zzz/inconnu');
    key(input(), 'Escape');
    expect(input().value).toBe('zzz/inconnu');
  });
});

describe('feuille du bas (mobile)', () => {
  it('le bouton ouvre la feuille avec voile et recherche ; Échap la ferme et rend le focus au bouton', () => {
    const trig = $<HTMLButtonElement>('[data-mcb-trig]');
    trig.click();
    expect(root().classList.contains('is-sheet')).toBe(true);
    expect(trig.getAttribute('aria-expanded')).toBe('true');
    expect(($('.mcb-veil') as HTMLElement).hidden).toBe(false);
    const q = $<HTMLInputElement>('[data-mcb-q="sheet"]');
    expect(document.activeElement).toBe(q);
    expect(q.getAttribute('aria-controls')).toBe($('[role="listbox"]').id);
    type(q, 'sonnet');
    expect(options().map((o) => o.dataset.mcbOpt)).toEqual(['anthropic/claude-sonnet-4']);
    key(q, 'Escape');
    expect(root().classList.contains('is-sheet')).toBe(false);
    expect(document.activeElement).toBe(trig);
    trig.click();
    $<HTMLElement>('.mcb-veil').click();
    expect(root().classList.contains('is-open')).toBe(false);
  });
});

describe('correctifs de revue', () => {
  it('Échap avec le focus sur un bouton de tri : ferme la liste sans quitter la page ni la rouvrir', () => {
    key(input(), 'ArrowDown');
    expect(root().classList.contains('is-open')).toBe(true);
    const prix = $<HTMLButtonElement>('[data-mcb-sort="price"]');
    prix.focus();
    const e = key(prix, 'Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(root().classList.contains('is-open')).toBe(false);
    expect(document.activeElement).toBe(input());
    // Texte resélectionné : la prochaine frappe remplace le nom affiché.
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(input().value.length);
    expect(input().value.length).toBeGreaterThan(0);
  });

  it('clic sur le champ déjà focalisé : la liste se rouvre', () => {
    expect(document.activeElement).toBe(input());
    expect(root().classList.contains('is-open')).toBe(false);
    input().click();
    expect(root().classList.contains('is-open')).toBe(true);
    key(input(), 'Escape');
    expect(root().classList.contains('is-open')).toBe(false);
  });

  it('le premier caractère tapé après une fermeture n’est pas perdu', () => {
    expect(root().classList.contains('is-open')).toBe(false);
    type(input(), 'c');
    expect(root().classList.contains('is-open')).toBe(true);
    expect(input().value).toBe('c');
    expect(options().length).toBeGreaterThan(0);
    expect(options().every((o) => /c/i.test(o.textContent || ''))).toBe(true);
    key(input(), 'Escape');
  });

  it('identifiant libre peu plausible : avertissement sans blocage', () => {
    key(input(), 'ArrowDown');
    $<HTMLButtonElement>('.mcb-foot [data-mcb-custom]').click();
    type(input(), 'pas un identifiant');
    expect(($('.mcb-invalid') as HTMLElement).hidden).toBe(false);
    expect(hidden().value).toBe('pas un identifiant');
    type(input(), 'openai/gpt-4o-mini');
    expect(($('.mcb-invalid') as HTMLElement).hidden).toBe(true);
    $<HTMLButtonElement>('[data-mcb-back]').click();
    key(input(), 'Escape');
  });

  it('retour arrière (popstate) avec la feuille ouverte : défilement rétabli', () => {
    $<HTMLButtonElement>('[data-mcb-trig]').click();
    expect(document.documentElement.classList.contains('mcb-lock')).toBe(true);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(document.documentElement.classList.contains('mcb-lock')).toBe(false);
    expect(root().classList.contains('is-open')).toBe(false);
  });

  it('feuille retirée du DOM sans fermeture : le rendu suivant lève le blocage', async () => {
    $<HTMLButtonElement>('[data-mcb-trig]').click();
    expect(document.documentElement.classList.contains('mcb-lock')).toBe(true);
    const { modelComboHTML } = await import('../src/ui/model-combobox.js');
    document.body.innerHTML = '<form>' + modelComboHTML('m2', 'openai/gpt-4o-mini') + '</form>';
    await settle(0);
    expect(document.documentElement.classList.contains('mcb-lock')).toBe(false);
  });
});
