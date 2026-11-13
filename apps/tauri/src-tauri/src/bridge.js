// Coque Tauri : recrée l'environnement de la coque Windows (WebView2) avant tout script de la page, pour que
// l'interface web (apps/web/src/player/shell.ts) parle exactement le même protocole sans rien changer.
//  - window.chrome.webview : postMessage(chaîne) vers la coque, évènement `message` ({data: chaîne JSON}) depuis la coque ;
//  - window.qt.webChannelTransport : relais attendu par shell.ts (cadre principal seulement) ;
//  - Maj + clic droit : menu contextuel natif ; liens data: M3U et vlc: envoyés à `play-external` ;
//  - window.initShellComm() appelé au chargement s'il existe ; alert/confirm/prompt désactivés (comme la coque Windows).
(function () {
  'use strict';
  if (window.__lsShell) return;
  var top = window.self === window.top;
  var listeners = [];
  var internals = function () { return window.__TAURI_INTERNALS__; };
  // Messages postés avant que l'IPC Tauri soit prêt : gardés puis envoyés dans l'ordre.
  var pending = [];
  var flushTimer = null;
  function post(text) {
    var ipc = internals();
    if (!ipc || typeof ipc.invoke !== 'function') {
      pending.push(text);
      if (!flushTimer) flushTimer = setInterval(flush, 20);
      return;
    }
    ipc.invoke('shell_post', { message: text }).catch(function () { /* coque fermée ou origine refusée */ });
  }
  function flush() {
    var ipc = internals();
    if (!ipc || typeof ipc.invoke !== 'function') return;
    clearInterval(flushTimer);
    flushTimer = null;
    var queue = pending;
    pending = [];
    queue.forEach(post);
  }

  Object.defineProperty(window, '__lsShell', {
    value: Object.freeze({
      // Appelé par la coque (Webview::eval) avec la chaîne JSON du message.
      deliver: function (json) {
        var ev = { data: json };
        listeners.slice().forEach(function (fn) { try { fn(ev); } catch (e) { /* un écouteur ne casse pas les autres */ } });
      },
    }),
  });

  var webview = {
    postMessage: function (message) { post(typeof message === 'string' ? message : JSON.stringify(message)); },
    addEventListener: function (type, fn) { if (type === 'message' && typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn); },
    removeEventListener: function (type, fn) { var i = listeners.indexOf(fn); if (type === 'message' && i >= 0) listeners.splice(i, 1); },
  };
  if (!window.chrome) window.chrome = {};
  try { window.chrome.webview = webview; } catch (e) { /* objet figé : rien à faire */ }

  if (top) {
    window.qt = { webChannelTransport: { send: webview.postMessage } };
    webview.addEventListener('message', function (ev) {
      var t = window.qt && window.qt.webChannelTransport;
      if (t && typeof t.onmessage === 'function') t.onmessage(ev);
    });
  }

  // Maj + clic droit : le menu natif plutôt que celui de la page.
  var shiftPass = function (ev) { if (ev.shiftKey) ev.stopImmediatePropagation(); };
  window.addEventListener('contextmenu', shiftPass, true);
  window.addEventListener('mouseup', function (ev) { if (ev.button === 2) shiftPass(ev); }, true);

  // Lecteur externe : liste M3U en data: et liens vlc: (comme la coque Windows).
  window.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.indexOf('data:application/octet-stream;charset=utf-8;base64,') === 0 || /^vlc:/i.test(href)) {
      ev.preventDefault();
      post(JSON.stringify({ id: 1, args: ['play-external', href] }));
    }
  }, true);

  // Signaux que WebView2 / la fenêtre Windows produisaient eux-mêmes, recréés dans la page (cadre principal) :
  //  - plein écran HTML de la page → `win-set-visibility {fullscreen}` (la coque ne redimensionne rien elle-même) ;
  //  - touches multimédia (fenêtre au premier plan) → `media-key` "play-pause" / "next-track" / "previous-track".
  function localSignal(name, payload) {
    window.__lsShell.deliver(JSON.stringify({ id: 1, object: 'transport', type: 1, args: [name, payload] }));
  }
  if (top) {
    document.addEventListener('fullscreenchange', function () {
      localSignal('win-set-visibility', { fullscreen: !!document.fullscreenElement });
    });
    var MEDIA_KEYS = { MediaPlayPause: 'play-pause', MediaPlay: 'play-pause', MediaPause: 'play-pause', MediaTrackNext: 'next-track', MediaTrackPrevious: 'previous-track' };
    window.addEventListener('keydown', function (ev) {
      var action = MEDIA_KEYS[ev.key];
      if (action) { ev.preventDefault(); localSignal('media-key', action); }
    }, true);
  }

  // Boîtes de dialogue du navigateur désactivées (la coque Windows les coupe aussi).
  window.alert = function () {};
  window.confirm = function () { return false; };
  window.prompt = function () { return null; };

  window.addEventListener('load', function () {
    if (top && typeof window.initShellComm === 'function') { try { window.initShellComm(); } catch (e) { /* page ancienne */ } }
  });
})();
