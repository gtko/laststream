// API Capacitor pour l'app Android Tauri : l'interface web (chargée depuis app.laststream.app) est écrite pour l'app
// Capacitor et appelle `@capacitor/core` (registerPlugin, CapacitorHttp, @capacitor/app). Ce script recrée ce que
// le pont natif de Capacitor pose avant les scripts de la page :
//  - `window.androidBridge` : plateforme « android » pour @capacitor/core ;
//  - `Capacitor.PluginHeaders` : plugins natifs et méthodes disponibles ;
//  - `Capacitor.nativePromise` / `nativeCallback` : appels et écouteurs, par le plugin Tauri `capacitor`
//    (commandes `call`, `registerListener`, `removeListener`), servi par `CapacitorBridgePlugin` (Kotlin).
// Les listes de méthodes suivent les `@PluginMethod` des plugins Kotlin (vérifié par scripts/capacitor.test.mjs).
(function () {
  'use strict';
  if (window.__lsCapacitor) return;

  var promise = function (names) {
    return names.map(function (name) { return { name: name, rtype: 'promise' }; });
  };
  var listeners = [
    { name: 'addListener', rtype: 'callback' },
    { name: 'removeListener', rtype: 'promise' },
    { name: 'removeAllListeners', rtype: 'promise' },
  ];
  var PLUGINS = {
    LaststreamPlayer: ['isAvailable', 'open', 'update', 'addSubtitles', 'play', 'pause', 'seek', 'setRate', 'setAudioTrack',
      'setSubtitleTrack', 'setSubtitleDelay', 'getState', 'close', 'minimize', 'expand', 'setSocial', 'setNotes', 'pushMessage'],
    LaststreamDownloads: ['start', 'cancel', 'size', 'truncate', 'write', 'finalize', 'remove', 'usage', 'localPath',
      'requestNotifications', 'checkPermissions', 'requestPermissions'],
    LaststreamUpdate: ['getVersion', 'canInstall', 'install'],
    LaststreamDisplay: ['getOutput'],
    CapacitorHttp: ['request', 'get', 'post', 'put', 'patch', 'delete'],
    App: ['exitApp', 'getInfo', 'getState', 'minimizeApp', 'getLaunchUrl'],
  };

  function internals() {
    var t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== 'function') throw new Error('Pont natif indisponible');
    return t;
  }

  // Erreur au format Capacitor : `message`, `code` et `data` du rejet Kotlin.
  function toError(e) {
    var msg = e && typeof e === 'object' ? e.message : e;
    var err = new Error(typeof msg === 'string' && msg ? msg : 'Erreur native');
    if (e && typeof e === 'object') {
      if (e.code !== undefined) err.code = e.code;
      if (e.data !== undefined) err.data = e.data;
    }
    return err;
  }

  function call(plugin, method, options) {
    return Promise.resolve()
      .then(function () {
        return internals().invoke('plugin:capacitor|call', { plugin: plugin, method: method, options: options || {} });
      })
      .then(function (r) { return r === null ? undefined : r; }, function (e) { throw toError(e); });
  }

  // Écouteurs : un canal Tauri par `addListener`, messages remis dans l'ordre d'envoi (champ `index`).
  var subs = {}; // callbackId → { plugin, eventName, channel }
  var seq = 0;

  function channel(callback) {
    var next = 0;
    var pending = {};
    return internals().transformCallback(function (m) {
      if (!m || typeof m !== 'object' || typeof m.index !== 'number') return;
      pending[m.index] = m;
      while (pending[next] !== undefined) {
        var cur = pending[next];
        delete pending[next];
        next++;
        if (cur.end) return;
        try { callback(cur.message); } catch (err) { console.error(err); }
      }
    });
  }

  function addListener(plugin, eventName, callback) {
    var id = 'ls-cap-' + (++seq);
    var ch = channel(callback);
    subs[id] = { plugin: plugin, eventName: eventName, channel: ch };
    internals()
      .invoke('plugin:capacitor|registerListener', { event: plugin + ':' + eventName, handler: '__CHANNEL__:' + ch })
      .catch(function (e) { console.error('addListener ' + plugin + '.' + eventName, e); });
    return id;
  }

  function removeListener(id) {
    var s = subs[id];
    if (!s) return Promise.resolve();
    delete subs[id];
    var t = internals();
    if (typeof t.unregisterCallback === 'function') t.unregisterCallback(s.channel);
    return t.invoke('plugin:capacitor|removeListener', { event: s.plugin + ':' + s.eventName, channelId: s.channel })
      .then(function () {}, function () {});
  }

  var cap = window.Capacitor || {};
  cap.PluginHeaders = Object.keys(PLUGINS).map(function (name) {
    return { name: name, methods: promise(PLUGINS[name]).concat(listeners) };
  });
  cap.nativePromise = function (plugin, method, options) {
    if (method === 'removeListener') return removeListener(options && options.callbackId);
    if (method === 'removeAllListeners') {
      return Promise.all(Object.keys(subs).filter(function (id) { return subs[id].plugin === plugin; }).map(removeListener))
        .then(function () {});
    }
    return call(plugin, method, options);
  };
  cap.nativeCallback = function (plugin, method, options, callback) {
    if (method === 'addListener' && options && typeof options.eventName === 'string' && typeof callback === 'function') {
      return addListener(plugin, options.eventName, callback);
    }
    call(plugin, method, options).then(function (r) { if (callback) callback(r); }, function (e) { if (callback) callback(null, e); });
    return '';
  };
  window.Capacitor = cap;
  // @capacitor/core lit la plateforme ici ; le pont natif lui-même passe par Tauri.
  if (!window.androidBridge) window.androidBridge = { postMessage: function () {} };
  window.__lsCapacitor = { plugins: PLUGINS };
})();
