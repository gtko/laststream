(function () {
  'use strict';
  var WIN = 'https://laststream.gtux-prog.workers.dev/app/windows/Laststream-Setup-1.0.0.exe';

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
  var LABEL = {
    windows: ['Télécharger pour Windows', 'Détecté : Windows'],
    android: ["Télécharger l'APK Android", 'Détecté : Android'],
    ios: ['Installer la version web', 'Détecté : iPhone ou iPad'],
    mac: ['Installer la version web', 'Détecté : macOS'],
    linux: ['Installer la version web', 'Détecté : Linux'],
    web: ['Ouvrir dans le navigateur', 'Ta plateforme n\'a pas été reconnue']
  };
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
  if (line) line.textContent = LABEL[os][1] + '. Les autres plateformes sont juste en dessous.';

  // Android : version et lien APK à jour (route même origine)
  function mb(n) { return Math.round(n / 1048576) + ' Mo'; }
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
