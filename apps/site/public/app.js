(function () {
  'use strict';
  // Versions et liens : lus dans latest.json (/api/<plateforme>, src/worker.js) ; le HTML garde des valeurs de secours
  // (page de la dernière release GitHub)
  var APP = 'https://app.laststream.app/app/';
  var GITHUB = 'https://github.com/gtko/laststream/releases/download/';

  // Textes dynamiques selon la langue de la page (<html lang>), fr par défaut
  var I18N = {
    fr: {
      mb: 'Mo',
      others: 'Les autres plateformes sont juste en dessous.',
      label: {
        windows: ['Télécharger pour Windows', 'Détecté : Windows'],
        android: ["Télécharger l'APK Android", 'Détecté : Android'],
        ios: ['Installer la version web', 'Détecté : iPhone ou iPad'],
        mac: ['Télécharger pour Mac', 'Détecté : macOS'],
        linux: ['Télécharger pour Linux', 'Détecté : Linux'],
        web: ['Ouvrir dans le navigateur', 'Ta plateforme n\'a pas été reconnue']
      }
    },
    en: {
      mb: 'MB',
      others: 'The other platforms are just below.',
      label: {
        windows: ['Download for Windows', 'Detected: Windows'],
        android: ['Download the Android APK', 'Detected: Android'],
        ios: ['Install the web version', 'Detected: iPhone or iPad'],
        mac: ['Download for Mac', 'Detected: macOS'],
        linux: ['Download for Linux', 'Detected: Linux'],
        web: ['Open in browser', 'Your platform was not recognized']
      }
    }
  };
  var lang = (document.documentElement.lang || 'fr').slice(0, 2).toLowerCase();
  // Autres langues (pages générées par scripts/i18n-site.mjs) : textes traduits dans <script type="application/json" id="ls-i18n">
  var T = I18N[lang] || pageI18N() || I18N.en;

  function detectOS() {
    var ua = navigator.userAgent || '';
    var touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || touchMac) return 'ios';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
    return 'web';
  }
  var LABEL = T.label;
  var os = detectOS();

  // Carte mise en avant + bouton principal du héro
  var cards = document.querySelectorAll('.dl');
  var main = null;
  cards.forEach(function (c) {
    if ((c.getAttribute('data-os') || '').split(' ').indexOf(os) !== -1) main = c;
  });
  if (!main) main = document.querySelector('.dl[data-os="web"]');
  if (main) {
    main.classList.add('is-main');
    if (T.badge) main.setAttribute('data-badge', T.badge);
    main.parentNode.insertBefore(main, main.parentNode.firstChild);
  }
  var cta = document.getElementById('hero-cta');
  if (cta) {
    cta.textContent = LABEL[os][0];
    if (os === 'windows') { cta.href = document.getElementById('win-link').href; cta.setAttribute('download', ''); }
    else if (os === 'android' || os === 'mac' || os === 'linux') cta.href = '#telecharger';
  }
  var line = document.getElementById('dl-os');
  if (line) line.textContent = LABEL[os][1] + '. ' + T.others;

  // Cartes : version, taille et liens à jour (routes même origine). `files` : [id du lien, fichier tiré de l'URL du flux].
  // Le flux pointe sur le fichier de mise à jour (Mac : .app.tar.gz) ; l'installation se fait avec le .dmg voisin.
  function mb(n) { return Math.round(n / 1048576) + ' ' + T.mb; }
  var same = function (u) { return u; };
  var dmg = function (u) { return u.replace(/\.app\.tar\.gz$/, '.dmg'); };
  var deb = function (u) { return u.replace(/\.AppImage$/, '.deb'); };
  function latest(api, platform, files, metaId, withSize) {
    fetch('/api/' + api, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) {
        if (!j || typeof j.url !== 'string') return;
        var ok = j.url.indexOf(APP + platform + '/') === 0 || (platform === 'android' && j.url.indexOf(GITHUB) === 0);
        if (!ok) return;
        files.forEach(function (f) {
          var a = document.getElementById(f[0]);
          if (a) a.href = f[1](j.url);
        });
        var m = document.getElementById(metaId);
        if (m && j.versionName) m.textContent = j.versionName + (withSize && j.size ? ' · ' + mb(j.size) : '');
        if (platform === 'tauri/windows-x86_64' && os === 'windows' && cta) cta.href = j.url;
      })
      .catch(function () { /* valeurs par défaut conservées */ });
  }
  latest('windows', 'tauri/windows-x86_64', [['win-link', same]], 'win-meta', true);
  latest('android', 'android', [['apk-link', same]], 'apk-meta', true);
  latest('macos-aarch64', 'tauri/macos-aarch64', [['mac-arm-link', dmg]], 'mac-meta', false);
  latest('macos-x86_64', 'tauri/macos-x86_64', [['mac-intel-link', dmg]], null, false);
  latest('linux', 'tauri/linux-x86_64', [['linux-appimage-link', same], ['linux-deb-link', deb]], 'linux-meta', false);
})();

// Apparition douce des sections au défilement (désactivée si l'utilisateur réduit les animations)
(function () {
  'use strict';
  var els = document.querySelectorAll('.rv');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!els.length || reduce || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js-rv');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach(function (el) { io.observe(el); });
})();

// Lightbox des captures (section Aperçu) : grande version, Échap ou clic pour fermer, focus géré, aria-modal
(function () {
  'use strict';
  var links = document.querySelectorAll('a[data-lightbox]');
  if (!links.length) return;
  var lang = (document.documentElement.lang || 'fr').slice(0, 2).toLowerCase();
  var T = lang === 'fr' ? { close: 'Fermer', dialog: 'Capture agrandie' } : pageI18N() || { close: 'Close', dialog: 'Enlarged screenshot' };
  var box = null, img = null, btn = null, lastFocus = null;

  function build() {
    box = document.createElement('div');
    box.className = 'lb';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', T.dialog);
    img = document.createElement('img');
    img.alt = '';
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lb-close';
    btn.setAttribute('aria-label', T.close);
    btn.textContent = '×';
    box.appendChild(img);
    box.appendChild(btn);
    document.body.appendChild(box);
    btn.addEventListener('click', close);
    box.addEventListener('click', function (e) { if (e.target !== btn) close(); });
    document.addEventListener('keydown', function (e) {
      if (box.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); btn.focus(); }
    });
  }

  function open(a) {
    if (!box) build();
    var pic = a.querySelector('img');
    lastFocus = document.activeElement;
    img.src = a.getAttribute('href');
    img.alt = pic ? pic.alt : '';
    box.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    btn.focus();
  }

  function close() {
    if (!box || box.hidden) return;
    box.hidden = true;
    img.removeAttribute('src');
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  links.forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      open(a);
    });
  });
})();

/** Textes de la page dans une langue générée (scripts/i18n-site.mjs), ou null. */
function pageI18N() {
  var el = document.getElementById('ls-i18n');
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch (e) { return null; }
}
