/*
 * Édition d'un profil en page plein écran (ODY-142) : en-tête fixe (retour, Annuler, Enregistrer), aperçu en direct
 * (grand avatar et mini « Qui regarde ? »), puis Identité, Apparence (avatar, couleur), Contrôle parental (profil enfant,
 * code parental, PIN) et, en modification, une zone de danger qui demande de saisir le nom avant de supprimer.
 * Le studio d'avatars garde sa vue plein écran par-dessus la page (son retour ramène ici).
 */
import { auth, isProfileLocked, parentalProfile, removeProfile, saveProfile, unlock } from '../data/auth';
import { KID_SECTIONS, sectionAllowed } from '../data/kid';
import { KID_AGES } from '../data/userApi';
import { isValidAvatar, parseColAvatar } from '../data/avatars';
import { isKidAllowed, loadCatalog, recentAvatars } from '../data/avatar-catalog';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { closeAvatarStudio, describeAvatar, describeAvatarSync, openAvatarStudio } from './avatar-studio.js';
import { openHouseholdPanel, paintProfileInviteRow, profileInviteRowHTML } from './household.js';
import { ICON } from './icons.js';
import { esc } from './util.js';

/** Les 8 couleurs de profil (fond de l'initiale ou de l'avatar). */
export const PROFILE_COLORS = ['#ff5a36', '#7b5bf5', '#19c3a6', '#f5b700', '#3b82f6', '#ec4899', '#22c55e', '#94a3b8'];
const COLOR_NAMES = ['corail', 'violet', 'turquoise', 'jaune', 'bleu', 'rose', 'vert', 'gris'];
const NAME_MAX = 20;
/** Autres fenêtres ouvertes au-dessus de la page (studio, panneau d'invitation, clavier PIN) : elles gèrent le clavier. */
const OVERLAYS = '.as-overlay, .hh-back, .pin-back';

const initialOf = (name) => (name || '').trim().slice(0, 1).toUpperCase() || '?';

/** Un profil enfant sans code parental défini : le profil principal doit en choisir un. */
function needsParentalCode(profile) {
  const m = parentalProfile();
  return !!profile.isKid && !!m && !m.hasPin;
}

/** Quatre cases d'un code à 4 chiffres ; la valeur complète reste en mémoire (state[name]), jamais dans le DOM. */
function pinBoxesHTML(name, label, help) {
  return '<fieldset class="pfe-pin" data-pfe-pin="' + name + '"><legend class="pfe-h3">' + label + '</legend>' +
    '<p class="pfe-help" data-pfe-pin-help="' + name + '">' + help + '</p>' +
    '<div class="pfe-pin-boxes">' + [0, 1, 2, 3].map((i) =>
      '<input type="password" class="pfe-pin-box" inputmode="numeric" maxlength="1" autocomplete="one-time-code" data-pfe-digit="' + i + '"' +
      ' aria-label="' + label + ', chiffre ' + (i + 1) + ' sur 4">').join('') + '</div>' +
    '</fieldset>';
}

/** Page ouverte (une seule à la fois). */
let current = null;

/**
 * Ouvre la page d'édition (`p` = null : création). `onDone()` est appelé après un enregistrement ou une suppression
 * réussis (la page est déjà fermée) ; `errorText(err)` traduit une erreur de l'API.
 * @param {any} p
 * @param {{ onDone: () => void, errorText: (err: unknown) => string }} opts
 */
export function openProfileEditor(p, opts) {
  if (isProfileLocked()) return;
  if (current) current.close();
  const isNew = !p;
  const cur = p || { name: '', avatarColor: PROFILE_COLORS[0], isKid: false, kidMaxAge: 12, hasPin: false };
  const state = { avatar: isValidAvatar(cur.avatar) ? cur.avatar : null, color: cur.avatarColor || PROFILE_COLORS[0], removePin: false, busy: false, pin: '', parental: '' };
  // Le profil principal (porteur du code parental) ne se supprime pas d'ici : pas de zone de danger.
  const isMain = !isNew && (!!cur.isMainProfile || cur.id === parentalProfile()?.id);
  const saveLabel = isNew ? 'Créer le profil' : 'Enregistrer';
  const dirtyHTML = '<span class="pfe-dirty" data-pfe-dirty role="status" hidden><span class="pfe-dot" aria-hidden="true"></span>Modifications non enregistrées</span>';
  const others = auth.profiles.filter((x) => x.id !== cur.id).slice(0, 3);
  const inviteRow = profileInviteRowHTML(p);
  const prevFocus = document.activeElement;

  const node = document.createElement('div');
  node.className = 'pf-back pfe-page';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  node.setAttribute('aria-labelledby', 'pfe-title');
  node.innerHTML = '<form class="pf-editor pfe" novalidate>' +
    '<header class="pfe-head"><div class="pfe-head-in">' +
    '<button type="button" class="pfe-icon-btn" data-pfe-cancel aria-label="Retour">' + ICON.back + '</button>' +
    '<h1 id="pfe-title" class="pfe-title">' + (isNew ? 'Nouveau profil' : 'Modifier le profil') + '</h1>' +
    '<div class="pfe-head-end">' + dirtyHTML +
    '<button type="button" class="btn btn-ghost pfe-btn" data-pfe-cancel>Annuler</button>' +
    '<button type="submit" class="btn btn-primary pfe-btn" data-pfe-save disabled>' + saveLabel + '</button></div>' +
    '</div></header>' +
    '<div class="pfe-layout">' +
    // Aperçu en direct
    '<aside class="pfe-preview" aria-label="Aperçu du profil">' +
    '<div class="pfe-preview-card"><span class="pfe-hero" data-pfe-hero></span>' +
    '<p class="pfe-hero-name" data-pfe-hero-name></p>' +
    '<p class="pfe-pill" data-pfe-hero-kid hidden>' + ICON.shield + 'Profil enfant, protégé</p></div>' +
    '<div class="pfe-mini" aria-hidden="true"><p class="pfe-mini-title">Qui regarde ?</p><div class="pfe-mini-row">' +
    others.map((o) => '<span class="pfe-mini-pf"><span class="pfe-art pfe-mini-art"' + avatarAttrs(o.avatar, o.avatarColor || PROFILE_COLORS[0]) + '>' +
      esc(initialOf(o.name)) + '</span><span class="pfe-mini-name">' + esc(o.name) + '</span></span>').join('') +
    '<span class="pfe-mini-pf is-me" data-pfe-mini-me></span></div></div>' +
    '</aside>' +
    '<div class="pfe-main">' +
    '<p class="pin-msg pfe-msg" id="pfe-msg" role="alert"></p>' +
    // Identité
    '<section class="pfe-card" aria-labelledby="pfe-s-id"><h2 class="pfe-h2" id="pfe-s-id">Identité</h2>' +
    '<div class="pfe-field"><div class="pfe-label-row"><label class="pfe-label" for="pfe-name">Nom du profil</label>' +
    '<span class="pfe-count" data-pfe-count aria-hidden="true"></span></div>' +
    '<input id="pfe-name" class="pfe-input" type="text" name="name" maxlength="' + NAME_MAX + '" required autocomplete="off" spellcheck="false"' +
    ' aria-describedby="pfe-name-help" value="' + esc(cur.name) + '">' +
    '<p class="pfe-help" id="pfe-name-help" data-pfe-name-help></p></div></section>' +
    // Apparence
    '<section class="pfe-card" aria-labelledby="pfe-s-look"><h2 class="pfe-h2" id="pfe-s-look">Apparence</h2>' +
    '<div class="pfe-sub"><h3 class="pfe-h3" id="pfe-av-label">Avatar</h3>' +
    '<p class="pfe-help pfe-avline"><span data-pfe-avname></span><span class="pfe-avsub" data-pfe-avsub></span></p>' +
    '<div class="pfe-tiles" role="group" aria-labelledby="pfe-av-label" data-pfe-quick></div>' +
    '<div class="pfe-recent" data-pfe-recent hidden><span class="pfe-h4" id="pfe-recent-label">Récemment utilisés</span>' +
    '<div class="pfe-tiles" role="group" aria-labelledby="pfe-recent-label" data-pfe-recent-list></div></div>' +
    '<button type="button" class="btn btn-ghost pfe-btn pfe-change" data-pfe-studio>Changer d\'avatar</button>' +
    '<div class="pfe-kidwarn" data-pfe-kidwarn hidden role="alert"><p>Cet avatar n\'est pas disponible pour un profil enfant : choisis-en un autre.</p>' +
    '<button type="button" class="btn btn-ghost btn-sm pfe-btn" data-pfe-kidpick>Choisir un avatar enfant</button></div></div>' +
    '<div class="pfe-sub"><h3 class="pfe-h3" id="pfe-color-label">Couleur</h3>' +
    '<div class="pfe-colors" role="group" aria-labelledby="pfe-color-label">' +
    PROFILE_COLORS.map((c, i) => '<button type="button" class="pfe-color-btn" data-pfe-color="' + c + '" aria-label="Couleur ' + COLOR_NAMES[i] + '" aria-pressed="false" style="--c:' + c + '">' + ICON.check + '</button>').join('') +
    '</div></div></section>' +
    // Contrôle parental
    '<section class="pfe-card" aria-labelledby="pfe-s-kid"><h2 class="pfe-h2" id="pfe-s-kid">Contrôle parental</h2>' +
    '<label class="pfe-switch-row"><span class="pfe-switch-text"><strong>Profil enfant</strong>' +
    '<small id="pfe-kid-desc">Seuls les avatars et les contenus pour enfants sont proposés. Le code parental est demandé pour quitter ce profil.</small></span>' +
    '<input type="checkbox" name="kid" role="switch" class="pfe-switch" aria-describedby="pfe-kid-desc"' + (cur.isKid ? ' checked' : '') + '></label>' +
    '<p class="pfe-pill" data-pfe-kidpill hidden>' + ICON.shield + 'Profil enfant, protégé</p>' +
    '<div class="pfe-sub" data-kidage hidden><label class="pfe-field"><span class="pfe-label">Âge maximal</span><select name="age" class="pfe-input">' +
    KID_AGES.map((a) => '<option value="' + a + '"' + (a === (cur.kidMaxAge || 12) ? ' selected' : '') + '>' + a + ' ans</option>').join('') + '</select></label>' +
    '<fieldset class="pf-sections"><legend>Rubriques autorisées</legend>' + KID_SECTIONS.map(([id, label]) =>
      '<label class="set-check"><input type="checkbox" name="sec" value="' + id + '"' + (sectionAllowed(cur.allowedCatalogs, id) ? ' checked' : '') + '> <span>' + esc(label) + '</span></label>').join('') +
    '</fieldset></div>' +
    '<div class="pfe-sub" data-parental hidden>' + pinBoxesHTML('parental', 'Code parental',
      'Il protège la sortie du profil enfant : c\'est le code du profil principal. Choisis-le maintenant (4 chiffres).') + '</div>' +
    '<div class="pfe-sub">' + pinBoxesHTML('pin', 'Code PIN du profil', cur.hasPin
      ? 'Ce profil a déjà un code. Saisis-en un nouveau pour le changer.'
      : 'Facultatif. Ces 4 chiffres seront demandés pour ouvrir ce profil.') +
    (cur.hasPin ? '<div class="pfe-nopin"><button type="button" class="btn btn-ghost btn-sm pfe-btn" data-pfe-nopin aria-pressed="false">Retirer le code</button>' +
      '<p class="pfe-help" data-pfe-nopin-note hidden>Le code sera retiré à l\'enregistrement.</p></div>' : '') + '</div>' +
    '</section>' +
    (inviteRow ? '<section class="pfe-card" aria-labelledby="pfe-s-share"><h2 class="pfe-h2" id="pfe-s-share">Accès</h2>' + inviteRow + '</section>' : '') +
    (isNew || isMain ? '' : '<section class="pfe-card pfe-danger" aria-labelledby="pfe-s-danger"><h2 class="pfe-h2" id="pfe-s-danger">Zone de danger</h2>' +
      '<p class="pfe-help">Supprimer ce profil efface sa bibliothèque, sa progression et ses réglages. Les autres profils ne changent pas.</p>' +
      '<button type="button" class="btn pfe-btn pfe-danger-btn" data-pfe-delete>Supprimer le profil</button></section>') +
    '</div></div>' +
    // Barre d'actions collante (mobile)
    '<div class="pfe-bar">' + dirtyHTML + '<div class="pfe-bar-actions">' +
    '<button type="button" class="btn btn-ghost pfe-btn" data-pfe-cancel>Annuler</button>' +
    '<button type="submit" class="btn btn-primary pfe-btn" data-pfe-save disabled>' + saveLabel + '</button></div></div>' +
    '</form>';
  document.body.appendChild(node);
  if (inviteRow) void paintProfileInviteRow(node.querySelector('[data-hh-row]'), p);

  const form = node.querySelector('form');
  const f = form.elements;
  const msg = node.querySelector('#pfe-msg');
  const kidBox = f.kid;
  const $ = (sel) => node.querySelector(sel);
  const $$ = (sel) => [...node.querySelectorAll(sel)];

  // ---------- Fenêtres de confirmation ----------
  let dialog = null;
  function openDialog(html, focusSel) {
    const back = document.createElement('div');
    back.className = 'pfe-dialog-back';
    back.innerHTML = html;
    form.setAttribute('inert', '');
    node.appendChild(back);
    dialog = { back, prev: document.activeElement };
    back.querySelector(focusSel)?.focus();
    return back;
  }
  function closeDialog() {
    if (!dialog) return;
    const { back, prev } = dialog;
    dialog = null;
    back.remove();
    form.removeAttribute('inert');
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  }

  // ---------- État modifié ----------
  const secs = () => [...form.querySelectorAll('input[name="sec"]:checked')].map((x) => x.value).join(',');
  const snapshot = () => JSON.stringify([
    f.name.value.trim(), state.avatar, String(state.color).toLowerCase(), kidBox.checked,
    kidBox.checked ? f.age.value : '', kidBox.checked ? secs() : '', state.pin, kidBox.checked && needsParentalCode({ isKid: true }) ? state.parental : '', state.removePin,
  ]);

  function close() {
    if (current !== handle) return;
    current = null;
    closeAvatarStudio();
    node.removeEventListener('keydown', onKey);
    node.remove();
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
  }
  const handle = { close };

  /** Retour, Annuler, Échap : on sort, après confirmation si des modifications ne sont pas enregistrées. */
  function requestLeave() {
    if (state.busy) return; // enregistrement en cours : on ne quitte pas au milieu
    if (snapshot() === initial) { close(); return; }
    const back = openDialog('<div class="pfe-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pfe-leave-title" aria-describedby="pfe-leave-desc">' +
      '<h2 class="pfe-h2" id="pfe-leave-title">Quitter sans enregistrer ?</h2>' +
      '<p class="pfe-help" id="pfe-leave-desc">Tes modifications seront perdues.</p>' +
      '<div class="pfe-dialog-actions"><button type="button" class="btn btn-ghost pfe-btn" data-pfe-stay>Continuer l\'édition</button>' +
      '<button type="button" class="btn btn-primary pfe-btn" data-pfe-leave>Quitter sans enregistrer</button></div></div>', '[data-pfe-stay]');
    back.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (t.closest('[data-pfe-stay]') || t === back) closeDialog();
      else if (t.closest('[data-pfe-leave]')) { closeDialog(); close(); }
    });
  }

  /** Suppression : le nom du profil doit être saisi à l'identique ; « Annuler » a le focus. */
  function requestDelete() {
    const back = openDialog('<form class="pfe-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pfe-del-title" aria-describedby="pfe-del-desc" novalidate>' +
      '<h2 class="pfe-h2" id="pfe-del-title">Supprimer le profil « ' + esc(cur.name) + ' » ?</h2>' +
      '<p class="pfe-help" id="pfe-del-desc">Sa bibliothèque, sa progression et ses réglages seront effacés. C\'est définitif.</p>' +
      '<label class="pfe-field"><span class="pfe-label">Pour confirmer, saisis le nom du profil : <strong>' + esc(cur.name) + '</strong></span>' +
      '<input class="pfe-input" type="text" autocomplete="off" spellcheck="false" data-pfe-delname></label>' +
      '<p class="pin-msg pfe-msg" role="alert" data-pfe-delmsg></p>' +
      '<div class="pfe-dialog-actions"><button type="button" class="btn btn-ghost pfe-btn" data-pfe-delcancel>Annuler</button>' +
      '<button type="submit" class="btn pfe-btn pfe-danger-btn" data-pfe-delok disabled>Supprimer définitivement</button></div></form>', '[data-pfe-delcancel]');
    const input = back.querySelector('[data-pfe-delname]');
    const ok = back.querySelector('[data-pfe-delok]');
    const matches = () => input.value.trim() === String(cur.name).trim();
    input.addEventListener('input', () => { ok.disabled = !matches(); });
    back.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (t.closest('[data-pfe-delcancel]') || t === back)) closeDialog();
    });
    back.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!matches() || ok.dataset.busy) return;
      ok.dataset.busy = '1';
      ok.disabled = true;
      try {
        await removeProfile(cur.id);
        closeDialog();
        close();
        opts.onDone();
      } catch (err) {
        delete ok.dataset.busy;
        ok.disabled = !matches();
        back.querySelector('[data-pfe-delmsg]').textContent = opts.errorText(err);
      }
    });
  }

  // ---------- Rendu ----------
  let heroKey = '';
  /** Aperçu : grand avatar, nom, mini « Qui regarde ? », initiale des vignettes, ligne « avatar actuel ». */
  function paintArt() {
    const name = f.name.value.trim();
    const initial = initialOf(name);
    const key = state.avatar + '|' + state.color + '|' + (state.avatar ? '' : initial);
    if (key !== heroKey) {
      heroKey = key;
      const art = (cls) => '<span class="pfe-art ' + cls + '"' + avatarAttrs(state.avatar, state.color) + '>' + (state.avatar ? '' : esc(initial)) + '</span>';
      $('[data-pfe-hero]').innerHTML = art('pfe-hero-art');
      $('[data-pfe-mini-me]').innerHTML = art('pfe-mini-art') + '<span class="pfe-mini-name" data-pfe-mini-name></span>';
      hydrateAvatars(node);
    }
    const init = $('button[data-pfe-pick=""] .pfe-art');
    if (init && init.textContent !== initial) init.textContent = initial;
    $('[data-pfe-hero-name]').textContent = name || (isNew ? 'Nouveau profil' : 'Sans nom');
    $('[data-pfe-hero-name]').classList.toggle('is-empty', !name);
    $('[data-pfe-mini-name]').textContent = name || 'Profil';
  }

  /** Ligne « avatar actuel » : nom et collection (chargés au besoin). */
  function paintAvatarLine() {
    const sync = describeAvatarSync(state.avatar);
    $('[data-pfe-avname]').textContent = sync.name;
    $('[data-pfe-avsub]').textContent = sync.sub;
    const wanted = state.avatar;
    void describeAvatar(wanted).then((d) => {
      if (state.avatar !== wanted || !node.isConnected) return;
      $('[data-pfe-avname]').textContent = d.name;
      $('[data-pfe-avsub]').textContent = d.sub;
    });
  }

  const paintPressed = () => {
    $$('button[data-pfe-pick], button[data-pfe-recent]').forEach((b) => {
      const v = b.dataset.pfePick !== undefined ? (b.dataset.pfePick || null) : b.dataset.pfeRecent;
      b.setAttribute('aria-pressed', String(v === state.avatar));
    });
    $$('[data-pfe-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pfeColor.toLowerCase() === String(state.color).toLowerCase())));
  };

  const tileHTML = (v, recent) => {
    const label = v ? describeAvatarSync(v).name : 'Initiale sur la couleur du profil';
    return '<button type="button" class="pfe-tile" ' + (recent ? 'data-pfe-recent="' + esc(v) + '"' : 'data-pfe-pick="' + esc(v || '') + '"') +
      ' aria-pressed="false" aria-label="' + esc(label) + '"><span class="pfe-art"' + avatarAttrs(v, state.color) + '>' +
      (v ? '' : esc(initialOf(f.name.value))) + '</span><span class="pfe-tick" aria-hidden="true">' + ICON.check + '</span></button>';
  };

  // Récemment utilisés : les derniers choix de ce profil (rien pour un profil nouveau). Profil enfant : seulement les
  // avatars autorisés ; catalogue indisponible, ils sont masqués.
  const recents = isNew ? [] : recentAvatars(cur.id);
  let tilesToken = 0;
  async function renderTiles() {
    const token = ++tilesToken;
    let allow = () => true;
    if (kidBox.checked) {
      let cat = null;
      try { cat = await loadCatalog(); } catch { cat = null; }
      if (!node.isConnected || token !== tilesToken) return;
      if (kidBox.checked) allow = cat ? (v) => isKidAllowed(cat, v) : () => false;
    }
    const shown = recents.filter(allow);
    const quick = [null];
    const own = isValidAvatar(cur.avatar) ? cur.avatar : null;
    if (own && allow(own) && !shown.includes(own)) quick.push(own);
    if (state.avatar && !quick.includes(state.avatar) && !shown.includes(state.avatar)) quick.push(state.avatar);
    $('[data-pfe-quick]').innerHTML = quick.map((v) => tileHTML(v, false)).join('');
    $('[data-pfe-recent]').hidden = shown.length === 0;
    $('[data-pfe-recent-list]').innerHTML = shown.map((v) => tileHTML(v, true)).join('');
    hydrateAvatars(node);
    paintPressed();
  }

  /** Avatar d'un profil enfant : vérifié contre le catalogue ; avertit et propose le studio enfant si non autorisé. */
  async function checkKid() {
    const warn = $('[data-pfe-kidwarn]');
    if (!kidBox.checked || !state.avatar) { warn.hidden = true; return; }
    let cat = null;
    try { cat = await loadCatalog(); } catch { cat = null; }
    if (!node.isConnected) return;
    warn.hidden = !kidBox.checked || !state.avatar || (cat ? isKidAllowed(cat, state.avatar) : !parseColAvatar(state.avatar));
  }

  /** Après chaque changement : compteur, aide, indicateur, boutons Enregistrer, aperçu. */
  function refresh() {
    const raw = f.name.value;
    const name = raw.trim();
    const dirty = snapshot() !== initial;
    const can = !state.busy && name !== '' && (isNew || dirty);
    $$('[data-pfe-save]').forEach((b) => { b.disabled = !can; });
    $$('[data-pfe-dirty]').forEach((d) => { d.hidden = !dirty; });
    $('[data-pfe-count]').textContent = raw.length + '/' + NAME_MAX;
    $('[data-pfe-name-help]').textContent = name ? 'Affiché sur l\'écran « Qui regarde ? ».'
      : isNew ? 'Donne un nom au profil pour pouvoir le créer.' : 'Le nom ne peut pas être vide.';
    $('[data-pfe-name-help]').classList.toggle('is-warn', !name && (!isNew || raw !== ''));
    const kid = kidBox.checked;
    $('[data-kidage]').hidden = !kid;
    $('[data-parental]').hidden = !(kid && needsParentalCode({ isKid: true }));
    $('[data-pfe-kidpill]').hidden = !kid;
    $('[data-pfe-hero-kid]').hidden = !kid;
    paintArt();
  }

  // ---------- Cases du code ----------
  const pinBoxes = (fs) => [...fs.querySelectorAll('[data-pfe-digit]')];
  function syncPin(fs) {
    state[fs.dataset.pfePin] = pinBoxes(fs).map((b) => b.value).join('');
    refresh();
  }
  function fillPin(fs, from, digits) {
    const boxes = pinBoxes(fs);
    let i = from;
    for (const d of digits) { if (i > 3) break; boxes[i].value = d; i += 1; }
    boxes[Math.min(i, 3)].focus();
    syncPin(fs);
  }
  function setRemovePin(on) {
    state.removePin = on;
    const fs = $('[data-pfe-pin="pin"]');
    for (const b of pinBoxes(fs)) { b.disabled = on; if (on) b.value = ''; }
    const btn = $('[data-pfe-nopin]');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Garder le code' : 'Retirer le code';
    $('[data-pfe-nopin-note]').hidden = !on;
    syncPin(fs);
  }

  // ---------- Studio d'avatars ----------
  const openStudio = (kidMode) => openAvatarStudio({
    profile: { id: cur.id, name: f.name.value.trim() },
    kid: kidMode,
    current: state.avatar,
    color: state.color,
    onPick: (value, color) => {
      state.avatar = value;
      if (color) state.color = color;
      void renderTiles();
      paintAvatarLine();
      void checkKid();
      refresh();
    },
  });

  // ---------- Événements ----------
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.dataset.pfeDigit !== undefined) {
      const d = t.value.replace(/\D/g, '');
      t.value = d.slice(-1);
      const fs = t.closest('[data-pfe-pin]');
      if (t.value && Number(t.dataset.pfeDigit) < 3) pinBoxes(fs)[Number(t.dataset.pfeDigit) + 1].focus();
      syncPin(fs);
      return;
    }
    refresh();
  });
  form.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.pfeDigit === undefined) return;
    const boxes = pinBoxes(t.closest('[data-pfe-pin]'));
    const i = Number(t.dataset.pfeDigit);
    if (e.key === 'Backspace' && !t.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].focus(); syncPin(t.closest('[data-pfe-pin]')); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
    else if (e.key === 'ArrowRight' && i < 3) { e.preventDefault(); boxes[i + 1].focus(); }
  });
  form.addEventListener('paste', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.pfeDigit === undefined) return;
    const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 4);
    if (!digits) return;
    e.preventDefault();
    fillPin(t.closest('[data-pfe-pin]'), Number(t.dataset.pfeDigit), digits);
  });
  form.addEventListener('change', (e) => {
    if (e.target !== kidBox) { refresh(); return; }
    void renderTiles();
    void checkKid();
    refresh();
  });
  node.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || dialog) return;
    const inviteBtn = t.closest('[data-hh-invite]');
    if (inviteBtn) {
      openHouseholdPanel(cur, { opener: inviteBtn, onChange: () => void paintProfileInviteRow(node.querySelector('[data-hh-row]'), cur) });
      return;
    }
    if (t.closest('[data-pfe-cancel]')) { requestLeave(); return; }
    if (t.closest('[data-pfe-studio]')) { openStudio(kidBox.checked); return; }
    if (t.closest('[data-pfe-kidpick]')) { openStudio(true); return; }
    if (t.closest('[data-pfe-nopin]')) { setRemovePin(!state.removePin); return; }
    if (t.closest('[data-pfe-delete]')) { requestDelete(); return; }
    const tile = t.closest('button[data-pfe-pick], button[data-pfe-recent]');
    if (tile) {
      state.avatar = tile.dataset.pfePick !== undefined ? (tile.dataset.pfePick || null) : tile.dataset.pfeRecent;
      paintPressed();
      paintAvatarLine();
      void checkKid();
      refresh();
      return;
    }
    const pc = t.closest('[data-pfe-color]');
    if (pc) { state.color = pc.dataset.pfeColor; void renderTiles(); paintPressed(); refresh(); }
  });

  /** Échap = retour (ou ferme la confirmation) ; Tab reste dans la page ou dans la confirmation. */
  function onKey(e) {
    // Écouteur posé sur la page : les touches n'atteignent pas le clavier global (events.js : retour, navigation).
    e.stopPropagation();
    if (!node.isConnected || node.hasAttribute('inert')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (dialog) closeDialog(); else requestLeave();
      return;
    }
    if (e.key !== 'Tab' || document.querySelector(OVERLAYS)) return;
    const scope = dialog ? dialog.back : form;
    const items = [...scope.querySelectorAll('button, input:not([type="hidden"]), select, a[href]')]
      .filter((x) => !x.disabled && !x.closest('[hidden]') && x.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || !scope.contains(a))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (a === last || !scope.contains(a))) { e.preventDefault(); first.focus(); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    const input = { name: f.name.value.trim(), avatarColor: state.color, isKid: kidBox.checked };
    if (!input.name) { msg.textContent = 'Donne un nom au profil.'; f.name.focus(); return; }
    if (!isNew && snapshot() === initial) return;
    msg.textContent = '';
    if (input.isKid) {
      input.kidMaxAge = Number(f.age.value);
      const chosen = [...form.querySelectorAll('input[name="sec"]:checked')].map((x) => x.value);
      // Défaut (toutes les rubriques sauf la TV jeunesse) = liste vide.
      const isDefault = chosen.length === KID_SECTIONS.length - 1 && !chosen.includes('tv');
      input.allowedCatalogs = isDefault ? [] : chosen;
    }
    // Profil enfant : un avatar « collection » doit être autorisé (catalogue requis) ; sinon on bloque et on propose le studio enfant.
    if (input.isKid && parseColAvatar(state.avatar)) {
      let cat = null;
      try { cat = await loadCatalog(); } catch { cat = null; }
      if (!cat || !isKidAllowed(cat, state.avatar)) {
        $('[data-pfe-kidwarn]').hidden = false;
        $('[data-pfe-kidwarn]').scrollIntoView?.({ block: 'center' });
        return;
      }
    }
    if (state.avatar !== (cur.avatar || null)) input.avatar = state.avatar;
    const pin = state.pin;
    const fail = (text, sel) => { msg.textContent = text; if (sel) $(sel)?.focus(); msg.scrollIntoView?.({ block: 'nearest' }); };
    if (pin && !/^\d{4}$/.test(pin)) { fail('Le code PIN compte 4 chiffres.', '[data-pfe-pin="pin"] [data-pfe-digit]'); return; }
    const mustSetParental = input.isKid && needsParentalCode({ isKid: true });
    const parental = state.parental;
    if (mustSetParental && !/^\d{4}$/.test(parental)) {
      fail('Choisis un code parental à 4 chiffres : il protège la sortie du profil enfant.', '[data-pfe-pin="parental"] [data-pfe-digit]');
      return;
    }
    if (pin) input.pin = pin;
    else if (state.removePin) input.pin = null;
    state.busy = true;
    refresh();
    try {
      // Pas encore de code parental : le profil principal en reçoit un avant que l'enfant soit créé ou modifié.
      // Le PIN tout juste posé verrouille le principal : on le déverrouille aussitôt pour que la création de l'enfant passe.
      if (mustSetParental) {
        await saveProfile(parentalProfile().id, { pin: parental });
        await unlock(parentalProfile().id, parental);
      }
      await saveProfile(isNew ? null : cur.id, input);
      close();
      opts.onDone();
    } catch (err) {
      state.busy = false;
      refresh();
      fail(opts.errorText(err), null);
    }
  });

  current = handle;
  node.addEventListener('keydown', onKey);
  void renderTiles();
  paintAvatarLine();
  const initial = snapshot();
  refresh();
  void checkKid();
  f.name.focus();
}
