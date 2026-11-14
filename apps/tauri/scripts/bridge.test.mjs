// bridge.js dans une WebView2 simulée : `chrome.webview` natif non modifiable, `window.ipc` de wry qui l'appelle.
// Le polyfill doit s'installer quand même, la page doit joindre la coque (`shell_post`) et l'IPC interne de Tauri doit
// repartir vers le `chrome.webview` natif sans boucler.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../src-tauri/src/bridge.js', import.meta.url), 'utf8');

function load({ nativeWebview }) {
  const nativeSent = [];
  const chrome = {};
  if (nativeWebview) {
    const native = { postMessage: (m) => nativeSent.push(m), addEventListener() {} };
    Object.defineProperty(chrome, 'webview', { get: () => native, enumerable: true, configurable: false });
  }
  const window = { chrome, addEventListener() {} };
  window.self = window;
  window.top = window;
  Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: (s) => window.chrome.webview.postMessage(s) }) });
  const invoked = [];
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      invoked.push([cmd, args.message]);
      if (nativeWebview) window.ipc.postMessage(JSON.stringify({ cmd, callback: 1, error: 2, payload: args }));
      return Promise.resolve();
    },
  };
  vm.runInNewContext(SOURCE, { window, document: { addEventListener() {} }, setInterval, clearInterval });
  return { window, invoked, nativeSent };
}

test('WebView2 : polyfill installé malgré le chrome.webview natif, IPC Tauri renvoyé au natif', () => {
  const { window, invoked, nativeSent } = load({ nativeWebview: true });
  window.chrome.webview.postMessage('{"id":0,"type":3}');
  assert.deepEqual(invoked, [['shell_post', '{"id":0,"type":3}']]);
  assert.equal(nativeSent.length, 1);
  assert.equal(JSON.parse(nativeSent[0]).cmd, 'shell_post');
});

test('réponses de la coque remises aux écouteurs de la page (chaîne JSON), relais qt compris', () => {
  for (const nativeWebview of [true, false]) {
    const { window } = load({ nativeWebview });
    const got = [];
    window.chrome.webview.addEventListener('message', (e) => got.push(e.data));
    window.qt.webChannelTransport.onmessage = (e) => got.push(`qt:${e.data}`);
    window.__lsShell.deliver('{"id":1,"type":1,"args":["x",1]}');
    assert.deepEqual(got.sort(), ['{"id":1,"type":1,"args":["x",1]}', 'qt:{"id":1,"type":1,"args":["x",1]}'].sort());
  }
});
