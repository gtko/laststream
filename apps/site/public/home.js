/* Accueil Laststream (FR et EN) : menu, révélations, compteurs, story pinée, tilt du héro, lightbox.
   Les téléchargements dynamiques (/api/windows, /api/android) restent dans /app.js. */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var supportsSDA = !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: view()'));
  var header = document.querySelector('.site-header');
  var MENU_MAX = 1080; // aligné sur la media query du menu dans home.css
  var STORY_MAX = 900; // aligné sur la media query de la story

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function onMQ(mq, fn) {
    if (mq.addEventListener) mq.addEventListener('change', fn);
    else if (mq.addListener) mq.addListener(fn);
  }

  /* ---------- Menu mobile ---------- */
  var toggle = document.querySelector('.menu-toggle');
  var nav = document.getElementById('nav');
  function setMenu(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
    var label = toggle.querySelector('.sr-only');
    if (label) label.textContent = toggle.getAttribute(open ? 'data-close' : 'data-open') || '';
  }
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setMenu(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) { setMenu(false); toggle.focus(); }
    });
    onMQ(window.matchMedia('(min-width: ' + (MENU_MAX + 1) + 'px)'), function (m) { if (m.matches) setMenu(false); });
  }

  /* ---------- Titres qui se remplissent ---------- */
  var fills = Array.prototype.slice.call(document.querySelectorAll('.fill'));
  fills.forEach(function (el) {
    var top = document.createElement('span');
    top.className = 'fill-top';
    top.setAttribute('aria-hidden', 'true');
    top.textContent = el.textContent;
    el.appendChild(top);
    el.classList.add('fill-ready');
  });

  /* ---------- Révélations + remplissage (repli IntersectionObserver) ---------- */
  var revealEls = document.querySelectorAll('[data-reveal]');
  function showAll() {
    revealEls.forEach(function (el) { el.classList.add('is-in'); });
    fills.forEach(function (el) { el.classList.add('is-in'); });
  }
  if ('IntersectionObserver' in window && !reduce.matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.15 });
    revealEls.forEach(function (el) { io.observe(el); });
    if (!supportsSDA) {
      var ioFill = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('is-in'); ioFill.unobserve(en.target); }
        });
      }, { rootMargin: '0px 0px -20% 0px', threshold: 0.6 });
      fills.forEach(function (el) { ioFill.observe(el); });
    }
  } else {
    showAll();
  }

  /* ---------- Compteurs animés ---------- */
  var counters = document.querySelectorAll('.count');
  function runCounter(el) {
    var to = parseFloat(el.getAttribute('data-to')) || 0;
    var from = parseFloat(el.getAttribute('data-from')) || 0;
    var dur = 1700;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = clamp((ts - start) / dur, 0, 1);
      var e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      el.textContent = String(Math.round(lerp(from, to, e)));
      if (p < 1) requestAnimationFrame(step);
    }
    el.textContent = String(from);
    requestAnimationFrame(step);
  }
  if ('IntersectionObserver' in window && !reduce.matches) {
    var ioCount = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { runCounter(en.target); ioCount.unobserve(en.target); }
      });
    }, { threshold: 0.8 });
    counters.forEach(function (el) { ioCount.observe(el); });
  }

  /* ---------- Story pinée : mockups pilotés par le scroll ---------- */
  var story = document.querySelector('[data-story]');
  var laptop = document.querySelector('[data-laptop]');
  var phone = document.querySelector('[data-phone]');
  var screens = Array.prototype.slice.call(document.querySelectorAll('[data-screen]'));
  var steps = Array.prototype.slice.call(document.querySelectorAll('.story-step'));
  var dots = Array.prototype.slice.call(document.querySelectorAll('.story-dots li'));
  var centers = [];
  var lastActive = -1;

  // États clés : 0 accueil, 1 fiche, 2 enfant, 3 téléphone (le portable s'efface)
  var L = [
    { rx: 16, ry: 0, rz: 0, s: 0.9, x: 0, y: 2, o: 1 },
    { rx: 4, ry: -16, rz: 0, s: 1.0, x: 0, y: 0, o: 1 },
    { rx: 6, ry: 14, rz: 0, s: 0.98, x: -2, y: 0, o: 1 },
    { rx: 12, ry: -24, rz: 0, s: 0.6, x: -30, y: -6, o: 0 }
  ];
  var P = [
    { rx: 0, ry: -40, rz: 10, s: 0.8, x: 30, y: 60, o: 0 },
    { rx: 0, ry: -40, rz: 10, s: 0.8, x: 30, y: 60, o: 0 },
    { rx: 0, ry: -30, rz: 8, s: 0.85, x: 26, y: 46, o: 0 },
    { rx: 0, ry: -10, rz: -3, s: 1, x: 0, y: 0, o: 1 }
  ];

  function mix(a, b, t) {
    return {
      rx: lerp(a.rx, b.rx, t), ry: lerp(a.ry, b.ry, t), rz: lerp(a.rz, b.rz, t),
      s: lerp(a.s, b.s, t), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), o: lerp(a.o, b.o, t)
    };
  }
  // Interpolation entre deux poses ; on tient la pose autour de chaque étape
  function ease(t) {
    var i = Math.min(Math.floor(t), L.length - 2);
    return { i: i, e: smooth(clamp((clamp(t - i, 0, 1) - 0.2) / 0.6, 0, 1)) };
  }

  function measure() {
    var sy = window.scrollY || window.pageYOffset;
    var mobile = window.innerWidth <= STORY_MAX;
    // Desktop : centre de chaque étape ; mobile : haut de l'étape (le texte passe sous la scène)
    centers = steps.map(function (s) {
      var r = s.getBoundingClientRect();
      return r.top + sy + (mobile ? 0 : r.height / 2);
    });
  }

  function storyActive() {
    return story && laptop && phone && !reduce.matches && steps.length > 1;
  }

  function progress() {
    var vh = window.innerHeight;
    var mobile = window.innerWidth <= STORY_MAX;
    var focus = (window.scrollY || window.pageYOffset) + vh * (mobile ? 0.62 : 0.5);
    if (focus <= centers[0]) return 0;
    if (focus >= centers[centers.length - 1]) return centers.length - 1;
    for (var i = 0; i < centers.length - 1; i++) {
      if (focus >= centers[i] && focus < centers[i + 1]) return i + (focus - centers[i]) / (centers[i + 1] - centers[i]);
    }
    return 0;
  }

  function updateStory() {
    if (!storyActive() || !centers.length) return;
    var mobile = window.innerWidth <= STORY_MAX;
    var t = progress();
    var k = ease(t);
    var l = mix(L[k.i], L[k.i + 1], k.e);
    var p = mix(P[k.i], P[k.i + 1], k.e);
    // Pas de superposition : le portable s'efface avant que le téléphone n'apparaisse
    if (k.i === L.length - 2) {
      l.o = 1 - clamp(k.e * 2, 0, 1);
      p.o = clamp(k.e * 2 - 1, 0, 1);
    }
    laptop.style.opacity = l.o.toFixed(3);
    laptop.style.visibility = l.o < 0.01 ? 'hidden' : '';
    laptop.style.transform = 'translate3d(' + l.x.toFixed(2) + '%,' + l.y.toFixed(2) + '%,0) rotateX(' + l.rx.toFixed(2) + 'deg) rotateY(' + l.ry.toFixed(2) + 'deg) scale(' + l.s.toFixed(4) + ')';
    phone.style.opacity = p.o.toFixed(3);
    phone.style.visibility = p.o < 0.01 ? 'hidden' : '';
    phone.style.transform = 'translate(-50%, -50%) translate3d(' + (p.x * (mobile ? 0.6 : 1)).toFixed(2) + '%,' + p.y.toFixed(2) + '%,0) rotateY(' + p.ry.toFixed(2) + 'deg) rotateZ(' + p.rz.toFixed(2) + 'deg) scale(' + p.s.toFixed(4) + ')';

    var active = Math.round(t);
    if (active !== lastActive) {
      lastActive = active;
      steps.forEach(function (s, i) { s.classList.toggle('is-active', i === active); });
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === active); });
      var screenIdx = Math.min(active, screens.length - 1);
      screens.forEach(function (s, i) { s.classList.toggle('is-active', i === screenIdx); });
    }
  }

  /* ---------- Tilt du héro (repli si pas de scroll-timeline) ---------- */
  var heroShot = document.querySelector('[data-tilt]');
  function updateTilt() {
    if (supportsSDA || !heroShot || reduce.matches) return;
    var r = heroShot.getBoundingClientRect();
    var vh = window.innerHeight;
    var p = clamp((vh - r.top) / (vh * 0.45 + r.height * 0.45), 0, 1);
    heroShot.style.transform = 'rotateX(' + ((1 - p) * 26).toFixed(2) + 'deg) scale(' + (0.88 + 0.12 * p).toFixed(4) + ')';
  }

  /* ---------- Boucle de scroll unique ---------- */
  var ticking = false;
  function frame() {
    ticking = false;
    if (header) header.classList.toggle('is-scrolled', (window.scrollY || window.pageYOffset) > 8);
    updateStory();
    updateTilt();
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(frame); }
  }
  function onResize() { measure(); onScroll(); }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('load', onResize);
  onMQ(reduce, function () {
    if (reduce.matches) {
      if (laptop) laptop.removeAttribute('style');
      if (phone) phone.removeAttribute('style');
      if (heroShot) heroShot.removeAttribute('style');
      showAll();
    }
    lastActive = -1;
    onResize();
  });
  onResize();

  /* ---------- Lightbox de la galerie ---------- */
  var box = document.getElementById('lightbox');
  if (box && typeof box.showModal === 'function') {
    var boxImg = box.querySelector('img');
    document.querySelectorAll('.shot[data-full]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var img = btn.querySelector('img');
        boxImg.src = btn.getAttribute('data-full');
        boxImg.alt = img ? img.alt : '';
        box.showModal();
      });
    });
    box.addEventListener('click', function (e) { if (e.target === box) box.close(); });
    box.addEventListener('close', function () { boxImg.removeAttribute('src'); });
  } else if (box) {
    // Navigateur sans <dialog> : les vignettes ouvrent la grande capture dans l'onglet
    document.querySelectorAll('.shot[data-full]').forEach(function (btn) {
      btn.addEventListener('click', function () { window.location.href = btn.getAttribute('data-full'); });
    });
  }
})();
