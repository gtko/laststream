import { describe, expect, it } from 'vitest';
import { installShellCompat } from '../src/shellCompat';

describe('installShellCompat (LASTSTREAM-WEB-1)', () => {
  it('pose une fonction vide : l’appel des anciennes coques ne lève plus', () => {
    const win: { initShellComm?: unknown } = {};
    installShellCompat(win);
    expect(typeof win.initShellComm).toBe('function');
    expect(() => (win.initShellComm as () => void)()).not.toThrow();
  });

  it('ne remplace jamais une fonction déjà définie', () => {
    const own = () => 'coque';
    const win: { initShellComm?: unknown } = { initShellComm: own };
    installShellCompat(win);
    expect(win.initShellComm).toBe(own);
  });

  it('module chargé : défini sur la page', async () => {
    await import('../src/shellCompat');
    expect(typeof (globalThis as { initShellComm?: unknown }).initShellComm).toBe('function');
  });
});
