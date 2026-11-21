import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initShellUpdateBanner } from '../src/ui/update-banner.js';

/** Coque factice : `emit` simule un signal de la coque, `sent` garde les événements envoyés. */
function fakeShell() {
  const listeners = new Map<string, Array<(a: unknown) => void>>();
  const sent: string[] = [];
  return {
    sent,
    emit: (event: string) => (listeners.get(event) ?? []).forEach((fn) => fn(undefined)),
    transport: {
      kind: 'webview2' as const,
      info: {},
      send: (event: string) => { sent.push(event); },
      on: (event: string, fn: (a: unknown) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
    },
  };
}

describe('bandeau de mise à jour de l’ancienne coque Windows', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('apparaît quand la coque a téléchargé la nouvelle app, et « Installer » lui demande de l’installer', async () => {
    const shell = fakeShell();
    await initShellUpdateBanner({ isTauri: false, connect: async () => shell.transport });
    expect(document.querySelector('.uiupd-banner')).toBeNull();
    shell.emit('autoupdater-show-notif');
    shell.emit('autoupdater-show-notif');
    expect(document.querySelectorAll('.uiupd-banner')).toHaveLength(1);
    const go = document.querySelector('.upd-go') as HTMLButtonElement;
    go.click();
    expect(shell.sent).toEqual(['autoupdater-notif-clicked']);
    expect(go.disabled).toBe(true);
  });

  it('« Plus tard » retire le bandeau sans rien envoyer', async () => {
    const shell = fakeShell();
    await initShellUpdateBanner({ isTauri: false, connect: async () => shell.transport });
    shell.emit('autoupdater-show-notif');
    (document.querySelector('.upd-later') as HTMLButtonElement).click();
    expect(document.querySelector('.uiupd-banner')).toBeNull();
    expect(shell.sent).toEqual([]);
  });

  it('rien dans l’app Tauri (elle a sa propre boîte) ni hors coque', async () => {
    const connect = vi.fn(async () => fakeShell().transport);
    await initShellUpdateBanner({ isTauri: true, connect });
    expect(connect).not.toHaveBeenCalled();
    await initShellUpdateBanner({ isTauri: false, connect: async () => null });
    expect(document.querySelector('.uiupd-banner')).toBeNull();
  });

  it('destroy retire le bandeau et ignore les signaux suivants', async () => {
    const shell = fakeShell();
    const destroy = await initShellUpdateBanner({ isTauri: false, connect: async () => shell.transport });
    shell.emit('autoupdater-show-notif');
    destroy();
    expect(document.querySelector('.uiupd-banner')).toBeNull();
    shell.emit('autoupdater-show-notif');
    expect(document.querySelector('.uiupd-banner')).toBeNull();
  });
});
