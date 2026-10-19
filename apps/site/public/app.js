(function () {
  'use strict';
  // Installateur Windows : seul endroit à modifier pour une nouvelle version (le HTML garde des valeurs de secours)
  var WIN_VERSION = '1.0.3';
  var WIN_SIZE = '91';
  var WIN = 'https://laststream.gtux-prog.workers.dev/app/windows/Laststream-Setup-' + WIN_VERSION + '.exe';

  // Textes dynamiques selon la langue de la page (<html lang>), fr par défaut
  var I18N = {
    fr: {
      mb: 'Mo',
      others: 'Les autres plateformes sont juste en dessous.',
      label: {
        windows: ['Télécharger pour Windows', 'Détecté : Windows'],
        android: ["Télécharger l'APK Android", 'Détecté : Android'],
        ios: ['Installer la version web', 'Détecté : iPhone ou iPad'],
        mac: ['Installer la version web', 'Détecté : macOS'],
        linux: ['Installer la version web', 'Détecté : Linux'],
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
        mac: ['Install the web version', 'Detected: macOS'],
        linux: ['Install the web version', 'Detected: Linux'],
        web: ['Open in browser', 'Your platform was not recognized']
      }
    }
  };
  var lang = (document.documentElement.lang || 'fr').slice(0, 2).toLowerCase();
  var T = I18N[lang] || I18N.fr;

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
    main.parentNode.insertBefore(main, main.parentNode.firstChild);
  }
  var cta = document.getElementById('hero-cta');
  if (cta) {
    cta.textContent = LABEL[os][0];
    if (os === 'windows') { cta.href = WIN; cta.setAttribute('download', ''); }
    else if (os === 'android') cta.href = '#telecharger';
  }
  var line = document.getElementById('dl-os');
  if (line) line.textContent = LABEL[os][1] + '. ' + T.others;

  // Carte Windows : version, taille et lien de téléchargement
  var winMeta = document.getElementById('win-meta');
  if (winMeta) winMeta.textContent = WIN_VERSION + ' · ' + WIN_SIZE + ' ' + T.mb;
  var winBtn = document.querySelector('.dl[data-os="windows"] .btn');
  if (winBtn) winBtn.href = WIN;

  // Android : version et lien APK à jour (route même origine)
  function mb(n) { return Math.round(n / 1048576) + ' ' + T.mb; }
  fetch('/api/android', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (j) {
      if (!j || typeof j.url !== 'string' || j.url.indexOf('https://laststream.gtux-prog.workers.dev/app/android/') !== 0) return;
      var a = document.getElementById('apk-link');
      var m = document.getElementById('apk-meta');
      if (a) a.href = j.url;
      if (m && j.versionName) m.textContent = j.versionName + (j.size ? ' · ' + mb(j.size) : '');
    })
    .catch(function () { /* valeurs par défaut conservées */ });
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
  var en = (document.documentElement.lang || 'fr').slice(0, 2).toLowerCase() === 'en';
  var T = en ? { close: 'Close', dialog: 'Enlarged screenshot' } : { close: 'Fermer', dialog: 'Capture agrandie' };
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
