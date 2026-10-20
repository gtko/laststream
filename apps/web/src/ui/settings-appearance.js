/* Réglages > Apparence : cartes de thème (radiogroup, flèches du clavier) et panneau « Personnalisé »
 * (code couleur, teinte, luminosité, contraste du texte sombre, aperçu en direct). Styles : styles/settings-appearance.css. */
import { applyTheme, CUSTOM_THEME_ID, isHexColor, onAccent, PRESETS, readTheme, resolveTheme, saveTheme } from '../data/theme';
import { AA_TEXT, brightenForText, formatRatio, hexToHsl, hslToHex, textContrast } from '../data/color';
import { isServerMode, pushPrefs } from '../data/auth';
import { onNavKey } from './events.js';
import { card } from './settings-ui.js';
import { detailEl } from './dom.js';
import { esc } from './util.js';

const DEFAULT_ID = PRESETS[0].id;
const DEFAULT_ACCENT = PRESETS[0].accent.toLowerCase();
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.6 8.4l2.9 2.9 5.9-6.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_OK = '<svg class="set-ap-ci-ok" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.4 10.3l2.4 2.4 4.8-5.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARN = '<svg class="set-ap-ci-warn" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 2.8l8 14H2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.1" fill="currentColor"/></svg>';

/** Dernière couleur personnalisée de la session : revenir sur « Personnalisé » la retrouve. */
let lastCustom = '';
/** Couleur du panneau en HSL. La saturation n'a pas de curseur : elle suit le code saisi. */
const hsl = { h: 0, s: 1, l: 0.5 };

const ratioText = (r) => 'Texte bien lisible, contraste ' + formatRatio(r) + ' sur 1, AA atteint';
const WARN_TEXT = 'Le texte sera difficile à lire';
const pct = (v) => Math.round(v * 100);
/** Couleur et texte posé dessus (le même que l'application : onAccent), en variables CSS en ligne. */
const accentVars = (hex) => '--a:' + esc(hex) + ';--a-on:' + onAccent(hex);

/** Pistes des curseurs : la teinte à saturation et luminosité courantes, la luminosité du noir au blanc dans la teinte. */
function tracks() {
  const s = pct(hsl.s) + '%';
  const l = Math.min(65, Math.max(40, pct(hsl.l))) + '%';
  const hue = 'linear-gradient(90deg' + [0, 60, 120, 180, 240, 300, 360].map((h) => ', hsl(' + h + ' ' + s + ' ' + l + ')').join('') + ')';
  const light = 'linear-gradient(90deg, #000, hsl(' + Math.round(hsl.h) + ' ' + s + ' 50%), #fff)';
  return { hue, light };
}

/** Carte de thème : mini-aperçu (fond, carte, bouton plein, bouton avec anneau, pastille) puis pastille, nom et coche. */
function themeCard(id, label, accent, on) {
  const rainbow = id === CUSTOM_THEME_ID && !on;
  return '<button type="button" class="set-ap-th' + (rainbow ? ' is-rainbow' : '') + '" role="radio" aria-checked="' + on + '" tabindex="' + (on ? '0' : '-1') + '" data-set-theme="' + id + '"' +
    (rainbow ? '' : ' style="' + accentVars(accent) + '"') + '>' +
    '<span class="set-ap-mini" aria-hidden="true"><span class="set-ap-mini-card"><span class="set-ap-mini-l"></span><span class="set-ap-mini-dot"></span></span>' +
    '<span class="set-ap-mini-row"><span class="set-ap-mini-btn">Lire</span><span class="set-ap-mini-ring"></span></span></span>' +
    '<span class="set-ap-th-f"><span class="set-ap-sw" aria-hidden="true"></span><span class="set-ap-th-n">' + esc(label) + '</span><span class="set-ap-ck" aria-hidden="true">' + CHECK + '</span></span></button>';
}

function customPanel(hex, open) {
  const r = textContrast(hex);
  const ok = r >= AA_TEXT;
  const fix = ok ? '' : brightenForText(hex);
  const t = tracks();
  return '<div class="set-ap-custom" data-set-ap-custom style="' + accentVars(hex) + '"' + (open ? '' : ' hidden') + '>' +
    '<div class="set-ap-c-top" data-nav>' +
      '<span class="set-ap-big" aria-hidden="true"></span>' +
      '<div class="set-ap-hexf"><label class="set-ap-lbl" for="set-ap-hex">Code couleur</label>' +
        '<input class="set-input set-ap-hex" id="set-ap-hex" data-set-ap-hex tabindex="0" value="' + esc(hex.toUpperCase()) + '" maxlength="7" spellcheck="false" autocomplete="off" autocapitalize="characters" aria-describedby="set-ap-hex-err" aria-invalid="false">' +
        '<p class="set-ap-err" id="set-ap-hex-err" hidden>Écris # puis 6 chiffres ou lettres de A à F, par exemple #FF5A36.</p></div>' +
      '<button type="button" class="btn btn-ghost set-ap-reset" data-set-ap-reset>Réinitialiser</button>' +
    '</div>' +
    '<div class="set-ap-sliders">' +
      '<div class="set-ap-sl" data-nav><label class="set-ap-lbl" for="set-ap-hue">Teinte</label><input type="range" class="set-ap-range" id="set-ap-hue" data-set-ap-hue tabindex="0" min="0" max="360" step="1" value="' + Math.round(hsl.h) + '" aria-valuetext="' + Math.round(hsl.h) + ' degrés" style="--ap-track:' + t.hue + '"><output class="set-ap-val" for="set-ap-hue" aria-hidden="true">' + Math.round(hsl.h) + '°</output></div>' +
      '<div class="set-ap-sl" data-nav><label class="set-ap-lbl" for="set-ap-light">Luminosité</label><input type="range" class="set-ap-range" id="set-ap-light" data-set-ap-light tabindex="0" min="0" max="100" step="1" value="' + pct(hsl.l) + '" aria-valuetext="' + pct(hsl.l) + ' %" style="--ap-track:' + t.light + '"><output class="set-ap-val" for="set-ap-light" aria-hidden="true">' + pct(hsl.l) + ' %</output></div>' +
    '</div>' +
    '<div class="set-ap-contrast ' + (ok ? 'is-ok' : 'is-warn') + '" data-set-ap-contrast data-nav>' +
      '<span class="set-ap-ci">' + ICON_OK + ICON_WARN + '</span>' +
      '<p class="set-ap-cmsg" role="status" data-set-ap-ok>' + (ok ? ratioText(r) : '') + '</p>' +
      '<p class="set-ap-cmsg" role="alert" data-set-ap-warn>' + (ok ? '' : WARN_TEXT) + '</p>' +
      '<button type="button" class="btn btn-ghost btn-sm set-ap-fix" data-set-ap-fix="' + fix + '"' + (ok ? ' hidden' : '') + '>Éclaircir (' + fix.toUpperCase() + ')</button>' +
    '</div>' +
    '<div class="set-ap-prev"><span class="set-ap-lbl">Aperçu</span>' +
      '<div class="set-ap-prev-b" aria-hidden="true"><span class="set-ap-pv-btn">Regarder</span><span class="set-ap-pv-ring">Ma liste</span>' +
      '<span class="set-ap-pv-link">Voir la fiche</span><span class="set-ap-pv-chip">Nouveau</span></div></div>' +
  '</div>';
}

/** Panneau Apparence complet (rendu par settings.js). */
export function appearancePanel() {
  const th = readTheme();
  const custom = th.id === CUSTOM_THEME_ID;
  if (custom) lastCustom = th.accent;
  const hex = custom ? th.accent : (lastCustom || th.accent.toLowerCase());
  Object.assign(hsl, hexToHsl(hex));
  const cards = PRESETS.map((p) => themeCard(p.id, p.label, p.accent, th.id === p.id)).join('') +
    themeCard(CUSTOM_THEME_ID, 'Personnalisé', custom ? th.accent : '', custom);
  return card('Thème', '<div class="set-ap">' +
    '<div class="set-ap-head"><span class="set-row-l" id="set-ap-l">Couleurs de l’application</span>' +
    '<span class="set-row-d">Choisis une palette ou compose ta couleur. ' + (isServerMode() ? 'Ton choix est gardé sur ton compte.' : 'Ton choix est gardé sur cet appareil.') + '</span></div>' +
    '<div class="set-ap-grid" role="radiogroup" aria-labelledby="set-ap-l" data-nav>' + cards + '</div>' +
    customPanel(hex, custom) + '</div>');
}

const q = (sel) => detailEl.querySelector(sel);

/** Cartes : état coché, tabindex itinérant, couleur de la carte « Personnalisé » ; panneau visible si Personnalisé. */
function syncCards(theme) {
  detailEl.querySelectorAll('.set-ap-th').forEach((b) => {
    const on = b.dataset.setTheme === theme.id;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    if (b.dataset.setTheme === CUSTOM_THEME_ID) {
      b.classList.toggle('is-rainbow', !on);
      if (on) { b.style.setProperty('--a', theme.accent); b.style.setProperty('--a-on', onAccent(theme.accent)); } else { b.style.removeProperty('--a'); b.style.removeProperty('--a-on'); }
    }
  });
  const panel = q('[data-set-ap-custom]');
  if (panel) panel.hidden = theme.id !== CUSTOM_THEME_ID;
}

function syncContrast(hex) {
  const box = q('[data-set-ap-contrast]');
  if (!box) return;
  const r = textContrast(hex);
  const ok = r >= AA_TEXT;
  box.classList.toggle('is-ok', ok);
  box.classList.toggle('is-warn', !ok);
  const okEl = box.querySelector('[data-set-ap-ok]');
  const warnEl = box.querySelector('[data-set-ap-warn]');
  const fixEl = box.querySelector('[data-set-ap-fix]');
  // Textes changés seulement quand ils diffèrent : l'alerte n'est pas relue à chaque pas de curseur.
  const okText = ok ? ratioText(r) : '';
  if (okEl.textContent !== okText) okEl.textContent = okText;
  const warnText = ok ? '' : WARN_TEXT;
  if (warnEl.textContent !== warnText) warnEl.textContent = warnText;
  fixEl.hidden = ok;
  if (!ok) {
    const fix = brightenForText(hex);
    fixEl.dataset.setApFix = fix;
    fixEl.textContent = 'Éclaircir (' + fix.toUpperCase() + ')';
  }
}

/** Met le panneau à jour. `from` : champ à ne pas réécrire (« hex » pendant la saisie, « slider » pendant le glissement). */
function syncPanel(hex, from) {
  const panel = q('[data-set-ap-custom]');
  if (!panel) return;
  panel.style.setProperty('--a', hex);
  panel.style.setProperty('--a-on', onAccent(hex));
  if (from !== 'slider') Object.assign(hsl, hexToHsl(hex));
  const input = panel.querySelector('[data-set-ap-hex]');
  if (from !== 'hex') { input.value = hex.toUpperCase(); setInvalid(input, false); }
  const hue = panel.querySelector('[data-set-ap-hue]');
  const light = panel.querySelector('[data-set-ap-light]');
  const t = tracks();
  const h = Math.round(hsl.h);
  const l = pct(hsl.l);
  if (from !== 'slider') { hue.value = String(h); light.value = String(l); }
  hue.style.setProperty('--ap-track', t.hue);
  light.style.setProperty('--ap-track', t.light);
  hue.setAttribute('aria-valuetext', h + ' degrés');
  light.setAttribute('aria-valuetext', l + ' %');
  panel.querySelector('output[for="set-ap-hue"]').textContent = h + '°';
  panel.querySelector('output[for="set-ap-light"]').textContent = l + ' %';
  syncContrast(hex);
}

function setInvalid(input, bad) {
  input.setAttribute('aria-invalid', String(bad));
  const err = q('#set-ap-hex-err');
  if (err) err.hidden = !bad;
}

/** Enregistre et applique une couleur personnalisée valide (aperçu en direct sur toute l'application, compte synchronisé avec anti-rafale). */
function applyCustom(hex, from) {
  const theme = resolveTheme(CUSTOM_THEME_ID, hex);
  lastCustom = theme.accent;
  saveTheme(theme);
  applyTheme(theme);
  syncCards(theme);
  syncPanel(theme.accent, from);
  pushPrefs();
}

function choose(id) {
  const cur = readTheme();
  const theme = id === CUSTOM_THEME_ID
    ? resolveTheme(CUSTOM_THEME_ID, lastCustom || (isHexColor(cur.accent) ? cur.accent : DEFAULT_ACCENT))
    : resolveTheme(id, null);
  saveTheme(theme);
  applyTheme(theme);
  pushPrefs();
  syncCards(theme);
  if (theme.id === CUSTOM_THEME_ID) { lastCustom = theme.accent; syncPanel(theme.accent); }
}

/** Code saisi : « ff5a36 » est accepté et complété par #. `strict` : un code incomplet est aussi signalé (au départ du champ). */
function readHex(input, strict) {
  const raw = input.value.trim();
  const v = /^[0-9a-f]{6}$/i.test(raw) ? '#' + raw : raw;
  if (isHexColor(v)) { setInvalid(input, false); return v; }
  const partial = /^#?[0-9a-f]{0,5}$/i.test(raw);
  setInvalid(input, strict || !partial);
  return '';
}

// ---------- Curseurs : un rendu par image, synchronisation du compte au relâchement ----------
let frame = 0;
let moved = '';
function sliderFrame() {
  frame = 0;
  const hue = q('[data-set-ap-hue]');
  const light = q('[data-set-ap-light]');
  if (!hue || !light) return;
  hsl.h = Number(hue.value);
  hsl.l = Number(light.value) / 100;
  // Gris : la teinte seule ne change rien, on redonne de la couleur dès qu'elle bouge.
  if (moved === 'hue' && hsl.s < 0.05) hsl.s = 0.8;
  applyCustom(hslToHex(hsl), 'slider');
}

// ---------- Événements (délégués, limités au panneau Apparence) ----------
detailEl.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('.set-ap')) return;
  const th = t.closest('[data-set-theme]');
  if (th) { e.preventDefault(); choose(th.dataset.setTheme); return; }
  const fix = t.closest('[data-set-ap-fix]');
  if (fix) {
    e.preventDefault();
    if (isHexColor(fix.dataset.setApFix)) applyCustom(fix.dataset.setApFix);
    q('[data-set-ap-hex]')?.focus();
    return;
  }
  if (t.closest('[data-set-ap-reset]')) {
    e.preventDefault();
    lastCustom = '';
    choose(DEFAULT_ID);
    q('.set-ap-th[data-set-theme="' + DEFAULT_ID + '"]')?.focus();
  }
});

/** Flèches dans le groupe : gauche et droite bouclent, début et fin, haut et bas vers la carte de la rangée voisine (sinon la navigation spatiale prend le relais). */
detailEl.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  // Télécommande : sur le code et les curseurs, Haut et Bas changent de ligne (events.js ignore les champs) ;
  // Gauche et Droite gardent leur rôle natif (curseur de texte, réglage du curseur).
  if (t.matches('[data-set-ap-hex], [data-set-ap-hue], [data-set-ap-light]')) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    onNavKey(e);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!t.matches('.set-ap-th')) return;
  const radios = Array.from(t.parentElement.querySelectorAll('.set-ap-th'));
  const i = radios.indexOf(t);
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const step = (e.key === 'ArrowRight') !== (getComputedStyle(t).direction === 'rtl') ? 1 : -1;
    next = radios[(i + step + radios.length) % radios.length];
  } else if (e.key === 'Home') next = radios[0];
  else if (e.key === 'End') next = radios[radios.length - 1];
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const r = t.getBoundingClientRect();
    const down = e.key === 'ArrowDown';
    const rows = radios.filter((b) => b !== t).map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter((x) => (down ? x.r.top > r.bottom - 4 : x.r.bottom < r.top + 4));
    if (rows.length) {
      const edge = down ? Math.min(...rows.map((x) => x.r.top)) : Math.max(...rows.map((x) => x.r.top));
      const cx = r.left + r.width / 2;
      next = rows.filter((x) => Math.abs(x.r.top - edge) < 4)
        .sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0].b;
    }
  }
  if (!next) return;
  e.preventDefault();
  e.stopPropagation(); // sinon la navigation spatiale (events.js) déplacerait encore le focus
  if (next !== t) {
    choose(next.dataset.setTheme);
    next.focus();
  }
});

detailEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.closest('.set-ap')) return;
  if (t.dataset.setApHex !== undefined) {
    const hex = readHex(t, false);
    if (hex) applyCustom(hex, 'hex');
    return;
  }
  if (t.dataset.setApHue !== undefined || t.dataset.setApLight !== undefined) {
    moved = t.dataset.setApHue !== undefined ? 'hue' : 'light';
    if (!frame) frame = raf(sliderFrame);
  }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.closest('.set-ap')) return;
  if (t.dataset.setApHex !== undefined) {
    const hex = readHex(t, true);
    if (hex) applyCustom(hex);
    return;
  }
  if (t.dataset.setApHue !== undefined || t.dataset.setApLight !== undefined) {
    if (frame) sliderFrame(); // relâché avant la prochaine image : on applique tout de suite
  }
});
