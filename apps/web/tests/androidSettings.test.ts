// Réglages sur Android : choix du serveur (Serveur Laststream par défaut, ou mon propre serveur).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ native: true }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@capacitor/core')>();
  return { ...mod, Capacitor: { ...mod.Capacitor, isNativePlatform: () => cap.native } };
});

import { PUBLIC_BASE } from '../src/data/config';
import { setRelaunch } from '../src/data/serverMode';

const LAN = 'http://192.168.1.20:7000';
const relaunch = vi.fn<() => void>();

function mockFetch(url: string): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname === '/health') return json({ ok: true });
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: { preferred: ['fr'], acceptVostfr: true }, sources: [] });
  return json({ error: 'not_found' }, 404);
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const page = () => document.querySelector('#detail .set-page') as HTMLElement;
const pressed = (mode: string) => page().querySelector(`[data-set-srvmode="${mode}"]`)?.getAttribute('aria-pressed');

beforeAll(async () => {
  // Le runtime Capacitor expose aussi `window.Capacitor` (lu par servedByLastAddon) : on le simule, en empêchant
  // le module @capacitor/core de le remplacer par son objet web à son initialisation.
  const nativeCapacitor = { isNativePlatform: () => true };
  Object.defineProperty(globalThis, 'Capacitor', { configurable: true, get: () => nativeCapacitor, set: () => undefined });
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ mode: 'public', base: PUBLIC_BASE, config: 'CFG' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = function scroll() { /* défilement sans effet en test */ };
  setRelaunch(relaunch);
  location.hash = '#/settings';
  await import('../src/main.js');
  await settle(900);
});

describe('Réglages Android : serveur', () => {
  it('propose le serveur Laststream par défaut, adresse en lecture seule', () => {
    expect(pressed('public')).toBe('true');
    expect(pressed('custom')).toBe('false');
    expect(page().textContent).toContain('Adresse : ' + PUBLIC_BASE);
    expect(page().querySelector('input[name="base"][type="hidden"]')).not.toBeNull();
  });

  it('« Mon propre serveur » affiche un champ d’adresse, et « Tester » répond OK via /health', async () => {
    (page().querySelector('[data-set-srvmode="custom"]') as HTMLElement).click();
    await settle(50);
    expect(pressed('custom')).toBe('true');
    const input = page().querySelector('input[name="base"]') as HTMLInputElement;
    expect(input.type).toBe('url');
    input.value = LAN;
    (page().querySelector('[data-set-ping]') as HTMLElement).click();
    await vi.waitFor(() => expect(page().querySelector('#set-la-msg')?.textContent).toContain('OK'));
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('« Serveur Laststream » revient en un clic, sans relance quand le serveur ne change pas', async () => {
    (page().querySelector('[data-set-srvmode="public"]') as HTMLElement).click();
    await settle(50);
    expect(pressed('public')).toBe('true');
    expect(page().textContent).toContain('Adresse : ' + PUBLIC_BASE);
    expect(relaunch).not.toHaveBeenCalled();
  });
});
