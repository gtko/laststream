// capacitor.js (app Android Tauri) avec le vrai @capacitor/core de l'interface : plateforme « android », plugins natifs
// disponibles, appels et écouteurs passés au plugin Tauri `capacitor`, erreurs au format Capacitor. Les méthodes déclarées
// doivent suivre les `@PluginMethod` des plugins Kotlin.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../src-tauri/src/capacitor.js', import.meta.url), 'utf8');

// Faux `__TAURI_INTERNALS__` : appels enregistrés, canaux rappelables, réponses programmables.
const invoked = [];
const callbacks = new Map();
let nextCallback = 1;
let answer = () => Promise.resolve(null);
globalThis.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    invoked.push([cmd, args]);
    return cmd === 'plugin:capacitor|call' ? answer(args) : Promise.resolve(null);
  },
  transformCallback(fn) {
    const id = nextCallback++;
    callbacks.set(id, fn);
    return id;
  },
  unregisterCallback(id) {
    callbacks.delete(id);
  },
};
globalThis.window = globalThis;
vm.runInThisContext(SOURCE);
const { Capacitor, CapacitorHttp, registerPlugin } = await import('@capacitor/core');

const tick = () => new Promise((r) => setTimeout(r, 0));

test('plateforme android, plugins natifs disponibles', () => {
  assert.equal(Capacitor.getPlatform(), 'android');
  assert.equal(Capacitor.isNativePlatform(), true);
  for (const name of ['LaststreamPlayer', 'LaststreamDownloads', 'LaststreamUpdate', 'LaststreamDisplay', 'CapacitorHttp', 'App']) {
    assert.equal(Capacitor.isPluginAvailable(name), true, name);
  }
  assert.equal(Capacitor.isPluginAvailable('Share'), false);
});

test('appel : commande capacitor|call, résultat rendu tel quel', async () => {
  answer = () => Promise.resolve({ width: 3840, height: 2160 });
  const display = registerPlugin('LaststreamDisplay');
  assert.deepEqual(await display.getOutput(), { width: 3840, height: 2160 });
  assert.deepEqual(invoked.at(-1), ['plugin:capacitor|call', { plugin: 'LaststreamDisplay', method: 'getOutput', options: {} }]);
  answer = (args) => Promise.resolve({ status: 200, data: args.options.url, headers: {} });
  const r = await CapacitorHttp.request({ url: 'http://192.168.1.2:11470/', method: 'GET' });
  assert.equal(r.data, 'http://192.168.1.2:11470/');
});

test('rejet : Error avec message et code (format Capacitor)', async () => {
  answer = () => Promise.reject({ message: 'Autorise l’installation', code: 'permission' });
  const update = registerPlugin('LaststreamUpdate');
  await assert.rejects(update.install({ url: 'https://x/app.apk' }), (e) => {
    assert.ok(e instanceof Error);
    assert.equal(e.message, 'Autorise l’installation');
    assert.equal(e.code, 'permission');
    return true;
  });
});

test('écouteur : canal Tauri, messages remis dans l’ordre, retrait', async () => {
  const player = registerPlugin('LaststreamPlayer');
  const got = [];
  const handle = await player.addListener('progress', (d) => got.push(d.position));
  const reg = invoked.findLast(([cmd]) => cmd === 'plugin:capacitor|registerListener');
  assert.equal(reg[1].event, 'LaststreamPlayer:progress');
  const id = Number(reg[1].handler.replace('__CHANNEL__:', ''));
  const cb = callbacks.get(id);
  cb({ message: { position: 2 }, index: 1 });
  cb({ message: { position: 1 }, index: 0 });
  assert.deepEqual(got, [1, 2]);
  await handle.remove();
  await tick();
  const rem = invoked.findLast(([cmd]) => cmd === 'plugin:capacitor|removeListener');
  assert.deepEqual(rem[1], { event: 'LaststreamPlayer:progress', channelId: id });
  assert.equal(callbacks.has(id), false);
});

// ---------- Méthodes déclarées = méthodes Kotlin ----------

const MOBILE = new URL('../../mobile/android/app/src/main/java/com/laststream/app/', import.meta.url);
const BRIDGE = new URL('../src-tauri/gen/android/app/src/main/java/com/laststream/app/bridge/', import.meta.url);

function kotlinFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? kotlinFiles(p) : p.endsWith('.kt') ? [p] : [];
  });
}

function pluginMethods() {
  const out = {};
  for (const file of [...kotlinFiles(MOBILE.pathname), ...kotlinFiles(BRIDGE.pathname)]) {
    const src = readFileSync(file, 'utf8');
    const name = src.match(/@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    out[name] = [...src.matchAll(/@PluginMethod\s+(?:fun|\n\s*fun)\s+(\w+)/g)].map((m) => m[1]).sort();
  }
  return out;
}

test('méthodes déclarées par capacitor.js = @PluginMethod des plugins Kotlin', () => {
  const declared = globalThis.__lsCapacitor.plugins;
  const kotlin = pluginMethods();
  assert.deepEqual(Object.keys(kotlin).sort(), Object.keys(declared).sort());
  for (const [name, methods] of Object.entries(kotlin)) {
    // checkPermissions / requestPermissions : hérités du Plugin de Capacitor, non annotés.
    const own = declared[name].filter((m) => m !== 'checkPermissions' && m !== 'requestPermissions').sort();
    assert.deepEqual(own, methods, name);
  }
});
