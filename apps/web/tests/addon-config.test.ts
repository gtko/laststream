// Configuration d'un addon dans l'app : fonctions pures et fenêtres (avertissement, puis page dans une iframe).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Le DOM de l'app doit exister avant l'import des modules d'interface (dom.js lit #modal à l'import).
const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { canEmbed, extractInstallLink, openAddonConfig } = await import('../src/ui/addonConfig.js');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'KEYSECRET1234567';
const PAGE = `https://addon.example/${SECRET}/configure`;
const LSECRET = 'LINKSECRET98765';
const LINK = `https://addon.example/${LSECRET}/manifest.json`;
const q = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const modalEl = () => document.getElementById('modal') as HTMLElement;

describe('extractInstallLink', () => {
  it('accepte stremio:// et http(s) finissant par /manifest.json (query ignorée)', () => {
    expect(extractInstallLink(' stremio://a.example/cfg/manifest.json ')).toBe('https://a.example/cfg/manifest.json');
    expect(extractInstallLink('https://a.example/manifest.json?x=1')).toBe('https://a.example/manifest.json?x=1');
    expect(extractInstallLink('http://a.example/MANIFEST.JSON')).toBe('http://a.example/MANIFEST.JSON');
  });
  it('refuse le reste', () => {
    expect(extractInstallLink('bonjour')).toBe('');
    expect(extractInstallLink('')).toBe('');
    expect(extractInstallLink('https://a.example/configure')).toBe('');
    expect(extractInstallLink('https://a.example/manifest.json\nhttps://b.example/manifest.json')).toBe('');
    expect(extractInstallLink('javascript:alert(1)//manifest.json')).toBe('');
    expect(extractInstallLink('https://a.example/' + 'x'.repeat(2100) + '/manifest.json')).toBe('');
    expect(extractInstallLink('https://')).toBe('');
  });
});

describe('canEmbed', () => {
  it('https toujours, http seulement si l’app n’est pas en https, jamais un autre schéma', () => {
    expect(canEmbed('https://a.example/configure', 'https:')).toBe(true);
    expect(canEmbed('https://a.example/configure', 'http:')).toBe(true);
    expect(canEmbed('http://a.example/configure', 'http:')).toBe(true);
    expect(canEmbed('http://a.example/configure', 'https:')).toBe(false);
    expect(canEmbed('javascript:alert(1)', 'http:')).toBe(false);
    expect(canEmbed('stremio://a.example/configure', 'http:')).toBe(false);
    expect(canEmbed('', 'http:')).toBe(false);
  });
});

describe('fenêtres de configuration', () => {
  let openOutside: ReturnType<typeof vi.fn>;
  let onApply: ReturnType<typeof vi.fn>;
  const clip = { readText: vi.fn(async () => LINK) };

  beforeAll(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clip });
  });
  beforeEach(async () => {
    const { closeModal } = await import('../src/ui/modal.js');
    closeModal(true);
    openOutside = vi.fn(async () => undefined);
    onApply = vi.fn(async () => undefined);
    openAddonConfig({ name: 'Mon <b>Addon</b>', page: PAGE, openOutside, onApply });
  });

  it('avertit d’abord : aucune iframe, nom échappé, focus sur Annuler', () => {
    expect(q('#modal .addon-cfg-warn')).not.toBeNull();
    expect(q('#modal-title').textContent).toBe('Configurer Mon <b>Addon</b>');
    expect(q('#modal-title').querySelector('b')).toBeNull();
    expect(q('#modal').textContent).toContain('Ne saisis ta clé de débrideur que dans les addons');
    expect(q('#modal details summary').textContent).toBe('En savoir plus');
    expect(document.querySelector('#modal iframe')).toBeNull();
    expect(document.activeElement).toBe(q('[data-acw-cancel]'));
  });

  it('« Annuler » ferme sans iframe', () => {
    q<HTMLElement>('[data-acw-cancel]').click();
    expect(modalEl().hidden).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('« Continuer » charge la page dans une iframe isolée (sans navigation du haut)', () => {
    q<HTMLElement>('[data-acw-go]').click();
    const f = q<HTMLIFrameElement>('#modal iframe');
    expect(f.getAttribute('src')).toBe(PAGE);
    const sb = f.getAttribute('sandbox') || '';
    expect(sb).toContain('allow-scripts');
    expect(sb).not.toContain('allow-top-navigation');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(f.getAttribute('allow')).toBe('clipboard-write');
    expect(q('.addon-cfg-empty').textContent).toContain('Page de addon.example');
    expect(q('#modal').textContent).toContain('pas « Installer »');
    expect(f.getAttribute('title')).toBe('Configuration de Mon <b>Addon</b>');
    expect(q('#modal .modal').classList.contains('addon-cfg')).toBe(true);
  });

  it('« Ouvrir dans le navigateur » passe par openOutside', () => {
    q<HTMLElement>('[data-acw-go]').click();
    q<HTMLElement>('[data-acw-out]').click();
    expect(openOutside).toHaveBeenCalledWith(PAGE);
  });

  it('« Utiliser ce lien » valide, applique et ferme ; un texte invalide est refusé sans réafficher l’adresse', async () => {
    q<HTMLElement>('[data-acw-go]').click();
    const input = q<HTMLInputElement>('#acw-link');
    input.value = PAGE;
    q<HTMLElement>('[data-acw-use]').click();
    await settle();
    expect(onApply).not.toHaveBeenCalled();
    expect(q('.addon-cfg-status').textContent).not.toContain(SECRET);
    expect(q('.addon-cfg-status').textContent).toContain('Ce n’est pas un lien d’installation');
    input.value = LINK;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(onApply).toHaveBeenCalledWith(LINK);
    expect(modalEl().hidden).toBe(true);
    const toastText = document.querySelector('.toast')?.textContent ?? '';
    expect(toastText).not.toContain(SECRET);
    expect(toastText).toContain('Lien appliqué : Mon <b>Addon</b>');
  });

  it('page http dans une app https : pas d’iframe, message, ouverture proposée mais non automatique', () => {
    const real = window.location;
    vi.stubGlobal('location', { ...real, protocol: 'https:' });
    openAddonConfig({ name: 'X', page: 'http://addon.example/configure', openOutside, onApply });
    q<HTMLElement>('[data-acw-go]').click();
    vi.unstubAllGlobals();
    expect(document.querySelector('#modal iframe')).toBeNull();
    expect(q('#modal').textContent).toContain('Cette page ne peut pas s’afficher dans l’app');
    expect(openOutside).not.toHaveBeenCalled();
  });

  it('détection : lien du presse-papiers repéré au retour au premier plan, seulement si la lecture est déjà accordée ; l’adresse n’est pas affichée', async () => {
    q<HTMLElement>('[data-acw-go]').click();
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: vi.fn(async () => ({ state: 'prompt' })) } });
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(q<HTMLInputElement>('#acw-link').value).toBe('');
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: vi.fn(async () => ({ state: 'granted' })) } });
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(q<HTMLInputElement>('#acw-link').value).toBe(''); // le lien reste en mémoire, pas dans le champ
    expect(q('#modal').innerHTML).not.toContain(LSECRET);
    expect(q('.addon-cfg-status').textContent).toContain('addon.example');
    expect(q('.addon-cfg-status').textContent).not.toContain(SECRET);
    expect(onApply).not.toHaveBeenCalled();
    q<HTMLElement>('[data-acw-use]').click(); // champ vide : utilise le lien détecté
    await settle();
    expect(onApply).toHaveBeenCalledWith(LINK);
  });

  it('« Coller » applique le lien sans l’écrire dans le champ ; échec (ko) : la fenêtre reste ouverte, sans adresse', async () => {
    onApply.mockResolvedValueOnce({ status: 'ko', error: `Injoignable ${LINK}` });
    q<HTMLElement>('[data-acw-go]').click();
    q<HTMLElement>('[data-acw-paste]').click();
    await settle();
    expect(onApply).toHaveBeenCalledWith(LINK);
    expect(modalEl().hidden).toBe(false);
    expect(q<HTMLInputElement>('#acw-link').value).toBe('');
    expect(q('.addon-cfg-status').textContent).toContain('ne répond pas');
    expect(q('#modal').innerHTML).not.toContain(LSECRET);
  });

  it('statut warn : toast « sans ressource stream »', async () => {
    onApply.mockResolvedValueOnce({ status: 'warn' });
    q<HTMLElement>('[data-acw-go]').click();
    q<HTMLElement>('[data-acw-paste]').click();
    await settle();
    expect(modalEl().hidden).toBe(true);
    expect(document.querySelector('.toast')?.textContent).toContain('sans ressource « stream »');
  });

  it('même origine que l’app : pas d’iframe', () => {
    openAddonConfig({ name: 'X', page: location.origin + '/configure', openOutside, onApply });
    q<HTMLElement>('[data-acw-go]').click();
    expect(document.querySelector('#modal iframe')).toBeNull();
    expect(q('#modal').textContent).toContain('Cette page ne peut pas s’afficher dans l’app');
  });
});
