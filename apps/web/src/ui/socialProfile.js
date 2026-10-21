/* Édition du profil social (Social v3, lot F2) : page #/social/profile, version bureau (formulaire à deux colonnes + aperçu
 * « Ce que voient tes amis ») et version Android (< 768 px : page défilante, lignes à feuille de choix). Les données viennent
 * du store (socialStore : loadProfile, saveProfile, rerollTag, loadPrefs, savePrefs, setStatus) ; l'avatar passe par le studio
 * d'avatars existant et par la route des profils (auth.saveProfile). Tout texte venu de l'utilisateur ou du serveur est posé
 * avec textContent. Le brouillon et ses différences sont dans socialProfileModel.js. */
import { auth, isKidProfile, isServerMode, saveProfile as saveAuthProfile } from '../data/auth';
import { tmdb } from '../data/lt';
import * as store from '../data/socialStore';
import { UserApiError } from '../data/userApi';
import { openAvatarStudio } from './avatar-studio.js';
import { hydrateAvatars } from './avatar-art.js';
import { cssUrl, safeTmdbImage } from './safeImg.js';
import { detailEl, toast } from './dom.js';
import { ICON } from './icons.js';
import {
  BIO_MAX, COLORS, EXPIRIES, FAVORITES_MAX, PREF_CHOICES, PRESENCE, addFavorite, charCount,
  cloneDraft, diffDraft, makeDraft, mediaOf, moveItem, tagCooldown, validateDraft,
} from './socialProfileModel.js';
import { registerSocialHook } from './socialHooks.js';
import { state as uiState } from './state.js';

const EMOJIS = ['🍿', '🎬', '🎥', '📺', '🛋️', '🌙', '☕', '🎧', '😴', '🤩', '😎', '🥳', '🤔', '🔥', '❤️', '👀', '🧠', '👾', '🚀', '🦇', '🧙', '🐉', '🎮', '🌧️'];
const POSTER_BGS = ['#3a2a1c', '#1f3b5c', '#5c1f2e', '#1f4a3a', '#3b2a5c', '#5c4a1f'];
const TAG_COOLDOWN_NOTE = 'Changer de tag : une fois par mois, tes amis restent tes amis.';
const MOBILE_Q = '(max-width: 767px)';

/** Réglages à choix : desktop = segments, Android = ligne qui ouvre une feuille. */
const CHOICES = [
  { key: 'activityVisibility', label: 'Qui voit ce que je regarde', mLabel: 'Ce que je regarde', mSub: 'Visible par' },
  { key: 'watchWith', label: '« Regarder avec moi »', mSub: 'Quand un ami me rejoint' },
  { key: 'libraryVisibility', label: 'Ma bibliothèque', mSub: 'Visible par' },
  { key: 'messagesFrom', label: 'Qui peut m’écrire', mLabel: 'Qui peut m’écrire' },
];
const PLAYBACK = { key: 'playbackSocial', label: 'Social pendant la lecture', mSub: 'Bulles, notes, emojis, présence', hint: 'Mode cinéma : ni bulles, ni notes, ni emojis, ni présence. Tout attend la fin du film.' };
/** Interrupteurs : chemin dans les préférences. */
const TOG = {
  history: { path: ['historyVisible'], label: 'Historique récent visible', sub: 'Les 20 derniers titres terminés' },
  spoiler: { path: ['antiSpoiler'], label: 'Anti-spoiler', sub: 'Masquer les notes des amis au-delà de ma position', mSub: 'Masquer les notes au-delà de ma position' },
  sound: { path: ['notify', 'sound'], label: 'Sons de notification', sub: 'Désactivés en « Ne pas déranger »' },
  vibrate: { path: ['notify', 'vibrate'], label: 'Vibrer à chaque message', sub: 'Jamais en mode cinéma' },
  messages: { path: ['notify', 'messages'], label: 'Messages', aria: 'Notifications de messages' },
  requests: { path: ['notify', 'requests'], label: 'Demandes d’amis', aria: 'Notifications de demandes' },
  parties: { path: ['notify', 'parties'], label: 'Invitations en watch party', aria: 'Notifications de watch party' },
  friendStarts: { path: ['notify', 'friendStarts'], label: 'Un ami commence un film', sub: 'Seulement les favoris', aria: 'Notifications d’activité' },
};

const isMobile = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_Q).matches;
const getPath = (obj, path) => path.reduce((o, k) => o[k], obj);
const setPath = (obj, path, v) => { path.slice(0, -1).reduce((o, k) => o[k], obj)[path[path.length - 1]] = v; };
const labelOf = (list, v) => (list.find((x) => x[0] === v) || [])[1] || '';

/** Crée un élément : attrs { class, text, on: { click }, … autres → setAttribute }, puis enfants (nœuds ou texte). */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const SVG = {
  reroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
};
const icon = (name, cls = 'spf-ic') => { const s = h('span', { class: cls, 'aria-hidden': 'true' }); s.innerHTML = SVG[name] || ICON[name] || ''; return s; };
const btn = (cls, text, fn, extra = {}) => h('button', { type: 'button', class: cls, text, on: { click: fn }, ...extra });
const plain = (obj) => (obj ? JSON.parse(JSON.stringify(obj)) : obj);

function errorText(e) {
  if (e instanceof UserApiError) {
    if (e.status === 429) return 'Trop de demandes, réessaie dans un instant.';
    if (e.status === 401 || e.status === 403) return 'Action refusée pour ce profil.';
    if (e.code === 'name_taken' || e.code === 'handle_taken') return 'Ce pseudo est déjà pris avec ce tag.';
    if (e.code === 'invalid_name') return 'Ce pseudo n’est pas valide.';
  }
  return 'Le serveur ne répond pas. Réessaie dans un instant.';
}

/** Initiale d'un nom pour l'avatar sans illustration. */
const initialOf = (name) => (String(name || '?').trim().slice(0, 1) || '?').toUpperCase();

/** Pastille d'avatar (initiale sur la couleur, illustration posée par hydrateAvatars). */
function avatarEl(cls, name, avatar, color) {
  const el = h('span', { class: cls, text: initialOf(name) });
  el.style.background = color;
  if (avatar) { el.dataset.avatar = avatar; void hydrateAvatars(el); }
  return el;
}

const IMG = (size, p) => safeTmdbImage(p, size) || '';
const backdropUrl = (p) => IMG('w780', p);
/** `background-image` sûr : seule une image TMDB validée y entre (jamais une URL brute du serveur). */
const bgOf = (size, p, pre = '') => { const u = cssUrl(IMG(size, p)); return u ? pre + u : ''; };
const posterBg = (f) => POSTER_BGS[Math.abs(Number(f.tmdbId) || 0) % POSTER_BGS.length];

/**
 * Monte l'éditeur dans `root` avec les données déjà chargées.
 * deps : { profile, prefs, status, onBack() } ; renvoie { destroy, draft, save, isDirty } pour les tests.
 */
export function mountProfileEditor(root, deps) {
  let profile = deps.profile;
  const baseAvatar = auth.profile ? auth.profile.avatar : null;
  let base = makeDraft(profile, deps.prefs, deps.status, baseAvatar);
  let draft = cloneDraft(base);
  let mobile = isMobile();
  let busy = false;
  let formError = '';
  let rerollAsk = false;
  let reorderIdx = -1;
  let dragFrom = -1;
  let pressTimer = 0;
  const fieldErrors = {};
  const dyn = {};
  const cleanups = [];
  const pid = auth.profile ? auth.profile.id : '';

  const page = h('div', { class: 'spf' + (mobile ? ' spf--m' : '') });
  root.replaceChildren(page);

  const diff = () => diffDraft(base, draft);
  const dirty = () => Object.keys(diff()).length > 0;
  const paint = (...names) => { for (const n of names) if (dyn[n]) dyn[n](); };
  const touched = () => { formError = ''; paint('head', 'preview', 'banner', 'favs'); };

  /** Zone repeinte à la demande : container + fonction de rendu. */
  const zone = (name, el, render) => { dyn[name] = () => { el.replaceChildren(...[].concat(render()).filter(Boolean)); }; dyn[name](); return el; };

  // ---------- Contrôles ----------
  /** Interrupteur (role switch) lié à un chemin de préférence. */
  function toggle(t) {
    const el = h('button', { type: 'button', class: 'spf-tg', role: 'switch', 'aria-label': t.aria || t.label });
    const sync = () => { const on = getPath(draft.prefs, t.path) === true; el.setAttribute('aria-checked', String(on)); el.classList.toggle('off', !on); };
    el.addEventListener('click', () => { setPath(draft.prefs, t.path, !getPath(draft.prefs, t.path)); sync(); touched(); });
    sync();
    return el;
  }
  const toggleRow = (t) => h('div', { class: mobile ? 'spf-li' : 'spf-pr' },
    h('div', { class: 'spf-t' }, h('div', { text: t.label }), (mobile ? t.mSub || t.sub : t.sub) ? h('div', { text: mobile ? t.mSub || t.sub : t.sub }) : null),
    toggle(t));

  /** Segments (bureau) : radiogroup, flèches gauche/droite. */
  function seg(def, choices, label) {
    const group = h('div', { class: 'spf-seg', role: 'radiogroup', 'aria-label': label });
    const bs = choices.map(([v, text]) => h('button', { type: 'button', class: 'spf-segb', role: 'radio', text, 'data-v': v }));
    const sync = () => bs.forEach((b) => { const on = b.dataset.v === def.get(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    bs.forEach((b, i) => {
      b.addEventListener('click', () => { def.set(b.dataset.v); sync(); touched(); });
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = bs[(i + d + bs.length) % bs.length];
        def.set(n.dataset.v); sync(); touched(); n.focus();
      });
    });
    group.append(...bs);
    sync();
    return group;
  }

  /** Feuille de choix (Android) : liste d'options radio en bas de l'écran. */
  function openSheet(title, choices, current, onPick) {
    const prev = document.activeElement;
    const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.isConnected) prev.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const opts = choices.map(([v, text, color]) => h('button', { type: 'button', class: 'spf-opt' + (v === current ? ' on' : ''), role: 'radio', 'aria-checked': String(v === current), on: { click: () => { onPick(v); close(); } } },
      color ? h('i', { class: 'spf-dot', style: 'background:' + color }) : null, h('span', { text }), v === current ? icon('check') : null));
    const sheet = h('div', { class: 'spf-sheet', on: { click: (e) => { if (e.target === sheet) close(); } } },
      h('div', { class: 'spf-sheet-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'spf-sheet-t', text: title }), h('div', { role: 'radiogroup', 'aria-label': title }, ...opts), btn('spf-btn spf-sec', 'Fermer', close)));
    document.addEventListener('keydown', onKey, true);
    page.append(sheet);
    (opts.find((o) => o.classList.contains('on')) || opts[0]).focus();
  }

  /** Réglage à choix : segments (bureau) ou ligne + feuille (Android). */
  function choice(def) {
    const choices = PREF_CHOICES[def.key];
    const acc = { get: () => draft.prefs[def.key], set: (v) => { draft.prefs[def.key] = v; } };
    if (!mobile) {
      return h('div', {}, h('span', { class: 'spf-lb', text: def.label }), seg(acc, choices, def.label), def.hint ? h('div', { class: 'spf-hint', text: def.hint }) : null);
    }
    const val = h('span', { class: 'spf-vl' });
    const row = h('button', { type: 'button', class: 'spf-li', on: { click: () => openSheet(def.mLabel || def.label, choices, acc.get(), (v) => { acc.set(v); sync(); touched(); }) } },
      h('div', { class: 'spf-t' }, h('div', { text: def.mLabel || def.label }), def.mSub ? h('div', { text: def.mSub }) : null), val);
    const sync = () => { val.textContent = labelOf(choices, acc.get()) + ' ›'; };
    sync();
    return row;
  }

  // ---------- Hooks du studio et sélecteur de titre ----------
  function pickAvatar() {
    openAvatarStudio({
      profile: { id: pid, name: draft.name.trim() }, kid: false, current: draft.avatar, color: draft.avatarColor,
      onPick: (value, color) => { draft.avatar = value; if (color) draft.avatarColor = color; paint('avatar'); touched(); },
    });
  }

  /** Fenêtre de recherche d'un titre TMDB (bannière ou favori) : `onPick(media)`. */
  function openTitlePicker(titleText, onPick, needBackdrop) {
    const prev = document.activeElement;
    let token = 0;
    let timer = 0;
    const input = h('input', { type: 'search', class: 'spf-fi', placeholder: 'Rechercher un film ou une série', 'aria-label': 'Rechercher un titre', autocomplete: 'off', maxlength: '60' });
    const list = h('div', { class: 'spf-res', 'aria-live': 'polite' });
    const close = () => { clearTimeout(timer); token += 1; modalEl.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.isConnected) prev.focus(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') {
        const f = Array.from(modalEl.querySelectorAll('button, input')).filter((x) => !x.disabled);
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const msg = (t) => list.replaceChildren(h('p', { class: 'spf-hint', text: t }));
    const run = async () => {
      const q = input.value.trim();
      const mine = ++token;
      if (q.length < 2) { msg('Tape au moins deux lettres.'); return; }
      msg('Recherche…');
      let json;
      try { json = await tmdb('search/multi', { query: q, include_adult: 'false' }); } catch { if (mine === token) msg('La recherche ne répond pas. Réessaie.'); return; }
      if (mine !== token) return;
      const found = ((json && json.results) || []).map(mediaOf).filter((m) => m && (!needBackdrop || m.backdrop)).slice(0, 12);
      if (!found.length) { msg('Aucun titre trouvé.'); return; }
      list.replaceChildren(...found.map((m) => {
        const year = '';
        const thumb = h('span', { class: 'spf-th' });
        const img = m.poster ? IMG('w92', m.poster) : '';
        if (img) thumb.style.backgroundImage = cssUrl(img);
        return h('button', { type: 'button', class: 'spf-r', on: { click: () => { onPick(m); close(); } } }, thumb,
          h('span', { class: 'spf-rt' }, h('b', { text: m.title }), h('small', { text: (m.type === 'series' ? 'Série' : 'Film') + year })));
      }));
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
    const modalEl = h('div', { class: 'spf-modal', on: { click: (e) => { if (e.target === modalEl) close(); } } },
      h('div', { class: 'spf-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': titleText },
        h('div', { class: 'spf-modal-h' }, h('h2', { class: 'spf-h2', text: titleText }), btn('spf-x', '', close, { 'aria-label': 'Fermer' })), input, list));
    modalEl.querySelector('.spf-x').append(icon('close'));
    document.addEventListener('keydown', onKey, true);
    page.append(modalEl);
    msg('Tape au moins deux lettres.');
    input.focus();
  }

  // ---------- Identité ----------
  const nameInput = h('input', { id: 'spf-nm', class: 'spf-fi', maxlength: '24', autocomplete: 'off', 'aria-describedby': 'spf-nm-err' });
  nameInput.value = draft.name;
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; delete fieldErrors.name; nameErr.hidden = true; paint('copy'); touched(); });
  const nameErr = h('div', { class: 'spf-err', id: 'spf-nm-err', role: 'alert', hidden: true });

  const bioInput = h('textarea', { id: 'spf-bio', class: 'spf-fi spf-ta', maxlength: '400', 'aria-describedby': 'spf-bio-n' });
  bioInput.value = draft.bio;
  const bioCount = h('span', { class: 'spf-count', id: 'spf-bio-n' });
  const paintBio = () => { const n = charCount(draft.bio); bioCount.textContent = '· ' + n + '/' + BIO_MAX; bioCount.classList.toggle('over', n > BIO_MAX); };
  bioInput.addEventListener('input', () => { draft.bio = bioInput.value; paintBio(); touched(); });
  paintBio();

  const swatches = zone('swatches', h('div', { class: 'spf-sws', role: 'group', 'aria-label': 'Couleur de l’avatar' }), () =>
    COLORS.map(([c, name]) => h('button', { type: 'button', class: 'spf-sw', 'aria-label': name, 'aria-pressed': String(draft.avatarColor.toLowerCase() === c), style: 'background:' + c,
      on: { click: () => { draft.avatarColor = c; paint('swatches', 'avatar'); touched(); } } })));

  const avatarBox = zone('avatar', h('span', { class: 'spf-avbox' }), () => avatarEl('spf-av spf-av--lg', draft.name, draft.avatar, draft.avatarColor));
  const avatarBtns = h('div', { class: 'spf-row' },
    btn('spf-btn spf-sec spf-sm', 'Visage d’un personnage', pickAvatar),
    zone('avclear', h('span', {}), () => (draft.avatar ? btn('spf-btn spf-sec spf-sm', 'Initiale', () => { draft.avatar = null; paint('avatar', 'avclear'); touched(); }) : [])));

  const tagRow = zone('tag', h('div', { class: 'spf-tagwrap' }), () => {
    const cd = tagCooldown(profile);
    const rr = h('button', { type: 'button', class: 'spf-rr', 'aria-label': 'Tirer un nouveau tag', disabled: cd.locked || busy,
      title: cd.locked ? cd.label : 'Tirer un nouveau tag', on: { click: () => { rerollAsk = true; paint('tag'); const y = page.querySelector('[data-reroll-yes]'); if (y) y.focus(); } } }, icon('reroll'));
    const field = h('div', { class: 'spf-fi spf-tagf', id: 'spf-tg', role: 'group', 'aria-label': 'Tag' }, h('span', { text: '#' + profile.handle.tag }), rr);
    const out = [field];
    if (rerollAsk) {
      out.push(h('div', { class: 'spf-ask', role: 'alertdialog', 'aria-label': 'Confirmer un nouveau tag' },
        h('span', { text: 'Tirer un nouveau tag ? Le suivant ne sera possible que dans 30 jours.' }),
        h('span', { class: 'spf-row' }, btn('spf-btn spf-pri spf-sm', 'Tirer', reroll, { 'data-reroll-yes': '' }), btn('spf-btn spf-sec spf-sm', 'Garder', () => { rerollAsk = false; paint('tag'); }))));
    }
    return out;
  });
  const tagNote = zone('tagnote', h('div', { class: 'spf-note' }), () => {
    const cd = tagCooldown(profile);
    return [
      'Tes amis te trouvent avec ', h('b', { text: profile.handle.full }), '. ',
      cd.locked ? cd.label + '. Tes amis restent tes amis.' : TAG_COOLDOWN_NOTE,
    ];
  });
  const copyBtn = zone('copy', h('span', { class: 'spf-copywrap' }), () => [
    h('button', { type: 'button', class: 'spf-btn spf-dash', 'aria-label': 'Copier ' + profile.handle.full, on: { click: () => { void copyHandle(); } } }, icon('copy'), 'Copier ' + profile.handle.full),
  ]);

  async function copyHandle() {
    const text = profile.handle.full;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('no-clipboard');
      toast('Copié : ' + text);
    } catch {
      const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px' });
      ta.value = text; document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      toast(ok ? 'Copié : ' + text : 'Copie impossible, sélectionne le tag à la main.');
    }
  }

  async function reroll() {
    rerollAsk = false;
    busy = true; paint('tag');
    try {
      const r = await store.rerollTag();
      profile = { ...profile, handle: r.handle, tagChangeableAt: r.tagChangeableAt || Date.now() + 30 * 86_400_000 };
      toast('Nouveau tag : ' + r.handle.full);
    } catch (e) {
      if (e instanceof UserApiError && e.code === 'tag_cooldown') {
        toast('Tu as déjà changé de tag ce mois-ci.');
        try { profile = await store.loadProfile(); } catch { /* on garde l'ancien état */ }
      } else toast(errorText(e));
    }
    busy = false;
    paint('tag', 'tagnote', 'copy', 'preview');
  }

  // ---------- Statut ----------
  let emojiOpen = false;
  const stInput = h('input', { id: 'spf-st', class: 'spf-fi', maxlength: '80', autocomplete: 'off', placeholder: 'Un mot sur ce que tu fais', 'aria-label': 'Message de statut' });
  stInput.value = draft.statusText;
  stInput.addEventListener('input', () => { draft.statusText = stInput.value; touched(); });
  const emojiBtn = zone('emoji', h('span', { class: 'spf-emojiwrap' }), () => {
    const out = [h('button', { type: 'button', class: 'spf-fi spf-emoji', 'aria-label': 'Choisir un emoji', 'aria-haspopup': 'true', text: draft.emoji || '🙂', on: { click: () => { emojiOpen = !emojiOpen; paint('emoji'); } } })];
    if (emojiOpen) {
      out.push(h('div', { class: 'spf-pop', role: 'group', 'aria-label': 'Emojis' },
        ...EMOJIS.map((e) => h('button', { type: 'button', class: 'spf-e', text: e, on: { click: () => { draft.emoji = e; emojiOpen = false; paint('emoji'); touched(); } } })),
        btn('spf-e spf-e--none', 'Aucun', () => { draft.emoji = ''; emojiOpen = false; paint('emoji'); touched(); })));
    }
    return out;
  });
  const expiry = zone('expiry', h('div', { class: 'spf-exp' }), () => [
    h('span', { text: 'Effacer' }),
    ...EXPIRIES.map(([v, text]) => h('button', { type: 'button', class: 'spf-chip' + (draft.expiry === v ? ' on' : ''), 'aria-pressed': String(draft.expiry === v), text,
      on: { click: () => { draft.expiry = v; paint('expiry'); touched(); } } })),
    draft.expiry === 'keep' && draft.expiresAt ? h('span', { class: 'spf-hint', text: 'Efface le ' + new Date(draft.expiresAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : null,
  ]);
  const presence = zone('presence', h('div', {}), () => {
    const acc = { get: () => draft.presence, set: (v) => { draft.presence = v; } };
    if (!mobile) return [h('span', { class: 'spf-lb', text: 'Présence' }), seg(acc, PRESENCE.map(([v, l]) => [v, l]), 'Présence')];
    const cur = PRESENCE.find((p) => p[0] === draft.presence) || PRESENCE[0];
    return [h('div', { class: 'spf-card' }, h('button', { type: 'button', class: 'spf-li', on: { click: () => openSheet('Présence', PRESENCE, draft.presence, (v) => { draft.presence = v; paint('presence'); touched(); }) } },
      h('i', { class: 'spf-dot', style: 'background:' + cur[2] }), h('div', { class: 'spf-t' }, h('div', { text: cur[1] })), h('span', { class: 'spf-vl', text: '›' })))];
  });
  const statusErr = h('div', { class: 'spf-err', role: 'alert', hidden: true });

  // ---------- Bannière et favoris ----------
  const bannerEl0 = h('div', { class: 'spf-bn' });
  const bannerBox = zone('banner', bannerEl0, () => {
    const b = draft.banner;
    bannerEl0.style.backgroundImage = b && b.backdrop ? bgOf('w780', b.backdrop, 'linear-gradient(90deg,rgba(12,11,17,.75),rgba(12,11,17,.2)),') : '';
    return [
      h('span', { class: 'spf-bn-t', text: b ? b.title : 'Aucune bannière' }),
      h('span', { class: 'spf-row' },
        btn('spf-btn spf-sec spf-sm', b ? 'Changer' : 'Choisir', pickBanner),
        b ? btn('spf-btn spf-sec spf-sm', 'Retirer', () => { draft.banner = null; touched(); }, { 'aria-label': 'Retirer la bannière' }) : null),
    ];
  });
  function pickBanner() {
    openTitlePicker('Choisir une bannière', (m) => { draft.banner = { tmdbId: m.tmdbId, type: m.type, backdrop: m.backdrop, title: m.title }; touched(); }, true);
  }

  const favsBox = zone('favs', h('div', { class: 'spf-favs', role: 'list', 'aria-label': 'Mes favoris' }), () => {
    const tiles = draft.favorites.map((f, i) => favTile(f, i));
    for (let k = draft.favorites.length; k < FAVORITES_MAX; k++) tiles.push(h('button', { type: 'button', class: 'spf-fav spf-fav--add', 'aria-label': 'Ajouter un favori', on: { click: addFav } }, icon('plus', 'spf-ic spf-ic--lg')));
    return tiles;
  });
  function addFav() {
    openTitlePicker('Ajouter un favori', (m) => {
      draft.favorites = addFavorite(draft.favorites, { tmdbId: m.tmdbId, type: m.type, title: m.title, ...(m.poster ? { poster: m.poster } : {}) });
      touched();
    }, false);
  }
  function moveFav(i, to) {
    draft.favorites = moveItem(draft.favorites, i, to);
    reorderIdx = to >= 0 && to < draft.favorites.length ? to : i;
    touched();
    const t = favsBox.querySelectorAll('.spf-fav[data-i]')[reorderIdx];
    if (t) t.focus();
  }
  function favTile(f, i) {
    const reorder = reorderIdx === i;
    const t = h('div', { class: 'spf-fav' + (reorder ? ' is-reorder' : ''), role: 'listitem', tabindex: '0', draggable: 'true', 'data-i': i,
      'aria-label': f.title + ', favori ' + (i + 1) + ' sur ' + draft.favorites.length + '. Alt et flèches pour réordonner.' });
    t.style.background = posterBg(f);
    if (bgOf('w185', f.poster)) { t.style.backgroundImage = bgOf('w185', f.poster); t.classList.add('has-img'); } else t.append(h('span', { class: 'spf-fav-t', text: f.title }));
    const act = (cls, label, ic, fn) => h('button', { type: 'button', class: 'spf-fa ' + cls, 'aria-label': label, on: { click: (e) => { e.stopPropagation(); fn(); } } }, icon(ic));
    t.append(...[
      act('spf-fa-rm', 'Retirer ' + f.title, 'close', () => { draft.favorites = draft.favorites.filter((_, k) => k !== i); reorderIdx = -1; touched(); }),
      i > 0 ? act('spf-fa-l', 'Déplacer ' + f.title + ' vers la gauche', 'back', () => moveFav(i, i - 1)) : null,
      i < draft.favorites.length - 1 ? act('spf-fa-r', 'Déplacer ' + f.title + ' vers la droite', 'chev', () => moveFav(i, i + 1)) : null].filter(Boolean));
    t.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); moveFav(i, i - 1); } else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); moveFav(i, i + 1); } else if (e.key === 'Delete') { e.preventDefault(); draft.favorites = draft.favorites.filter((_, k) => k !== i); touched(); } else if (e.key === 'Escape' && reorderIdx !== -1) { reorderIdx = -1; paint('favs'); }
    });
    // Appui long : mode réordonner (flèches visibles). Glisser-déposer au bureau.
    t.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; clearTimeout(pressTimer); pressTimer = setTimeout(() => { reorderIdx = i; paint('favs'); }, 450); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) t.addEventListener(ev, () => clearTimeout(pressTimer));
    t.addEventListener('dragstart', (e) => { dragFrom = i; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } });
    t.addEventListener('dragover', (e) => { if (dragFrom >= 0) e.preventDefault(); });
    t.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom >= 0 && dragFrom !== i) { draft.favorites = moveItem(draft.favorites, dragFrom, i); touched(); } dragFrom = -1; });
    t.addEventListener('dragend', () => { dragFrom = -1; });
    return t;
  }
  const favsErr = h('div', { class: 'spf-err', role: 'alert', hidden: true });

  // ---------- Aperçu (bureau) ----------
  const previewBox = zone('preview', h('aside', { class: 'spf-prev', 'aria-label': 'Aperçu de ton profil' }), () => {
    const pres = PRESENCE.find((p) => p[0] === draft.presence) || PRESENCE[0];
    const name = draft.name.trim() || profile.handle.name;
    const stText = draft.statusText.trim();
    const bannerEl = h('div', { class: 'spf-prev-bn' });
    if (draft.banner && draft.banner.backdrop) bannerEl.style.backgroundImage = bgOf('w780', draft.banner.backdrop);
    const av = avatarEl('spf-av spf-av--md', name, draft.avatar, draft.avatarColor);
    if (draft.presence !== 'invisible') av.append(h('i', { class: 'spf-pdot', style: 'background:' + pres[2] }));
    const stats = profile.stats;
    return [
      h('div', { class: 'spf-prev-h', text: 'Ce que voient tes amis' }),
      h('div', { class: 'spf-prev-card' }, bannerEl,
        h('div', { class: 'spf-prev-b' }, av,
          h('div', { class: 'spf-prev-n' }, name, h('span', { text: '#' + profile.handle.tag })),
          draft.emoji || stText ? h('div', { class: 'spf-prev-s', text: [draft.emoji, stText].filter(Boolean).join(' ') }) : null,
          draft.bio.trim() ? h('div', { class: 'spf-prev-bio', text: draft.bio.trim() }) : null,
          h('div', { class: 'spf-prev-f' }, ...Array.from({ length: FAVORITES_MAX }, (_, i) => {
            const f = draft.favorites[i];
            const c = h('div', { class: 'spf-pf' + (f ? '' : ' empty'), title: f ? f.title : null });
            if (f) { c.style.background = posterBg(f); if (bgOf('w154', f.poster)) c.style.backgroundImage = bgOf('w154', f.poster); else c.textContent = f.title; }
            return c;
          })),
          stats ? h('div', { class: 'spf-prev-st' }, h('span', {}, h('b', { text: String(stats.hoursWatched) }), ' h vues'), h('span', {}, h('b', { text: String(stats.notes) }), ' notes'), h('span', {}, h('b', { text: String(stats.friends) }), ' amis')) : null)),
      h('div', { class: 'spf-hint', text: 'Les profils enfants n’ont pas de profil social. Chaque profil adulte du compte a son propre pseudo et son propre tag.' }),
    ];
  });

  // ---------- En-tête ----------
  const goBack = () => {
    if (dirty() && !window.confirm('Quitter sans enregistrer tes modifications ?')) return;
    deps.onBack();
  };
  const cancel = () => {
    if (dirty()) { discard(); return; }
    deps.onBack();
  };
  function discard() {
    draft = cloneDraft(base);
    nameInput.value = draft.name; bioInput.value = draft.bio; stInput.value = draft.statusText;
    formError = ''; rerollAsk = false; emojiOpen = false; reorderIdx = -1;
    for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
    nameErr.hidden = true; statusErr.hidden = true; favsErr.hidden = true;
    paintBio();
    paint('swatches', 'avatar', 'avclear', 'emoji', 'expiry', 'presence', 'banner', 'favs', 'prefs', 'preview', 'head');
  }
  const saveBtn = btn('spf-btn spf-pri', 'Enregistrer', () => { void save(); });
  const cancelBtn = btn('spf-btn spf-sec', 'Annuler', cancel);
  const dirtyNote = h('span', { class: 'spf-dirty', role: 'status', text: 'Modifications non enregistrées' });
  const errLine = h('div', { class: 'spf-err spf-err--top', role: 'alert' });
  const head = zone('head', h('header', { class: 'spf-head' }), () => {
    const d = dirty();
    dirtyNote.hidden = !d;
    saveBtn.disabled = busy || !d;
    saveBtn.textContent = busy ? 'Enregistrement…' : 'Enregistrer';
    cancelBtn.disabled = busy;
    cancelBtn.hidden = mobile;
    errLine.hidden = !formError;
    errLine.textContent = formError;
    const back = h('button', { type: 'button', class: 'spf-back', 'aria-label': 'Retour', on: { click: goBack } }, icon('back'));
    return mobile
      ? [back, h('h1', { class: 'spf-h1', text: 'Éditer mon profil' }), dirtyNote, saveBtn]
      : [back, h('h1', { class: 'spf-h1', text: 'Mon profil social' }), dirtyNote, cancelBtn, saveBtn];
  });

  // ---------- Enregistrement ----------
  async function save() {
    if (busy) return;
    const errors = validateDraft(draft);
    nameErr.hidden = !errors.name; nameErr.textContent = errors.name || '';
    statusErr.hidden = !errors.status; statusErr.textContent = errors.status || '';
    favsErr.hidden = !errors.favorites; favsErr.textContent = errors.favorites || '';
    if (errors.bio) bioCount.classList.add('over');
    if (Object.keys(errors).length) {
      formError = Object.values(errors)[0];
      paint('head');
      const first = errors.name ? nameInput : errors.bio ? bioInput : errors.status ? stInput : null;
      if (first) first.focus();
      return;
    }
    const d = diff();
    if (!Object.keys(d).length) return;
    busy = true; formError = ''; paint('head', 'tag');
    const jobs = [];
    const job = (key, fn) => jobs.push(Promise.resolve().then(fn).then((value) => ({ key, ok: true, value }), (error) => ({ key, ok: false, error })));
    if (d.profile) job('profile', () => store.saveProfile(d.profile));
    if (d.prefs) job('prefs', () => store.savePrefs(d.prefs));
    if (d.presence) job('presence', () => store.setStatus(d.presence));
    if (d.avatar !== undefined) job('avatar', () => saveAuthProfile(pid, { avatar: d.avatar }));
    const res = await Promise.all(jobs);
    const nextBase = cloneDraft(base);
    const failed = [];
    for (const r of res) {
      if (!r.ok) { failed.push(r); continue; }
      if (r.key === 'profile') {
        profile = r.value;
        const fresh = makeDraft(profile, base.prefs, base.presence, base.avatar);
        for (const k of ['name', 'avatarColor', 'bio', 'emoji', 'statusText', 'expiry', 'expiresAt', 'banner', 'favorites']) { nextBase[k] = fresh[k]; draft[k] = plain(fresh[k]); }
      } else if (r.key === 'prefs') { nextBase.prefs = plain(r.value); draft.prefs = plain(r.value); } else if (r.key === 'presence') nextBase.presence = draft.presence;
      else if (r.key === 'avatar') nextBase.avatar = draft.avatar;
    }
    base = nextBase;
    busy = false;
    nameInput.value = draft.name; bioInput.value = draft.bio; stInput.value = draft.statusText; paintBio();
    if (failed.length) {
      formError = 'Tout n’a pas été enregistré : ' + errorText(failed[0].error);
      if (failed.some((f) => f.key === 'profile' && f.error instanceof UserApiError && (f.error.code === 'name_taken' || f.error.code === 'invalid_name'))) {
        nameErr.hidden = false; nameErr.textContent = errorText(failed.find((f) => f.key === 'profile').error);
      }
    } else toast('Profil enregistré');
    paint('swatches', 'avatar', 'avclear', 'emoji', 'expiry', 'presence', 'banner', 'favs', 'prefs', 'preview', 'tag', 'tagnote', 'copy', 'head');
  }

  // ---------- Assemblage ----------
  const prefsZone = zone('prefs', h('div', { class: 'spf-prefs' }), () => (mobile ? mobilePrefs() : desktopPrefs()));
  function desktopPrefs() {
    return [
      h('section', { class: 'spf-card spf-span' }, h('h2', { class: 'spf-h2', text: 'Confidentialité' }),
        h('div', { class: 'spf-grid2' },
          choice(CHOICES[0]), choice(CHOICES[1]), choice(CHOICES[2]), choice(CHOICES[3]),
          toggleRow(TOG.history), toggleRow(TOG.spoiler), choice(PLAYBACK))),
      h('section', { class: 'spf-card spf-span' }, h('h2', { class: 'spf-h2', text: 'Notifications' }),
        h('div', { class: 'spf-grid2' }, toggleRow(TOG.messages), toggleRow(TOG.requests), toggleRow(TOG.parties), toggleRow(TOG.friendStarts), toggleRow(TOG.sound))),
    ];
  }
  function mobilePrefs() {
    const sec = (label, ...rows) => h('section', { class: 'spf-sec' }, h('div', { class: 'spf-lbu', text: label }), h('div', { class: 'spf-card' }, ...rows));
    return [
      sec('Confidentialité', choice(CHOICES[0]), choice(CHOICES[1]), choice(CHOICES[2]), choice(CHOICES[3]), toggleRow(TOG.history)),
      sec('Pendant la lecture', choice(PLAYBACK), toggleRow(TOG.spoiler), toggleRow(TOG.vibrate)),
      sec('Notifications Android', toggleRow(TOG.messages), toggleRow(TOG.requests), toggleRow(TOG.parties), toggleRow(TOG.friendStarts)),
    ];
  }

  const nameField = h('div', {}, h('label', { class: 'spf-lb', for: 'spf-nm', text: 'Pseudo' }), nameInput, nameErr);
  const tagField = h('div', {}, h('label', { class: 'spf-lb', for: 'spf-tg', text: 'Tag' }), tagRow);
  const bioField = h('div', {}, h('label', { class: 'spf-lb', for: 'spf-bio' }, 'Bio ', bioCount), bioInput);
  const identityRows = [h('div', { class: 'spf-nt' }, nameField, tagField), tagNote, copyBtn, bioField];
  const statusRows = [presence, h('div', {}, h('label', { class: 'spf-lb', for: 'spf-st', text: 'Statut personnalisé' }), h('div', { class: 'spf-row spf-nowrap' }, emojiBtn, stInput), statusErr, expiry)];
  const favBlock = h('div', {}, h('div', { class: 'spf-lbline' }, h('span', { class: mobile ? 'spf-lbu' : 'spf-lb', text: 'Mes 4 favoris' }), mobile ? h('span', { class: 'spf-hint', text: 'Appui long pour réordonner' }) : null), favsBox, favsErr);

  if (!mobile) {
    page.append(head, h('div', { class: 'spf-body' },
      h('div', { class: 'spf-form' },
        h('section', { class: 'spf-card' }, h('h2', { class: 'spf-h2', text: 'Identité' }),
          h('div', { class: 'spf-idrow' }, avatarBox, h('div', { class: 'spf-col' }, swatches, avatarBtns)), ...identityRows),
        h('section', { class: 'spf-card' }, h('h2', { class: 'spf-h2', text: 'Statut et vitrine' }), ...statusRows,
          h('div', {}, h('span', { class: 'spf-lb', text: 'Bannière (une image de film)' }), bannerBox), favBlock),
        prefsZone),
      previewBox));
  } else {
    const bannerHero = h('div', { class: 'spf-hero' },
      h('div', { class: 'spf-hero-bn' }, btn('spf-chip spf-chip--float', 'Bannière', pickBanner, {})),
      h('button', { type: 'button', class: 'spf-hero-av', 'aria-label': 'Changer l’avatar', on: { click: pickAvatar } }, avatarBox, h('span', { class: 'spf-pen' }, icon('pencil'))),
      zone('herocap', h('div', { class: 'spf-hero-cap' }), () => {
        const b = draft.banner;
        const bn = page.querySelector('.spf-hero-bn');
        if (bn) bn.style.backgroundImage = b && b.backdrop ? bgOf('w780', b.backdrop) : '';
        return b ? ['Bannière : ' + b.title, ' ', btn('spf-chip spf-chip--sm', 'Retirer', () => { draft.banner = null; touched(); })] : 'Aucune bannière';
      }));
    // La bannière du héros se repeint avec la zone 'banner' (même source).
    const baseBanner = dyn.banner;
    dyn.banner = () => { baseBanner(); paint('herocap'); };
    page.append(head, bannerHero,
      h('section', { class: 'spf-sec' }, h('div', { class: 'spf-lbu', text: 'Avatar' }), swatches, avatarBtns),
      h('section', { class: 'spf-sec' }, h('div', { class: 'spf-lbu', text: 'Identité' }), ...identityRows),
      h('section', { class: 'spf-sec' }, h('div', { class: 'spf-lbu', text: 'Statut' }), ...statusRows),
      h('section', { class: 'spf-sec' }, favBlock),
      prefsZone);
    bannerBox.hidden = true;
    paint('herocap');
  }
  page.prepend(errLine);
  page.append(h('div', { class: 'spf-foot' }, 'Les profils enfants n’ont pas de profil social.'));
  // Le bouton « Désactiver mon profil social » est masqué : le contrat S1/S2 n'a pas de route de désactivation (voir rapport F2).
  head.after(errLine);
  paint('head');

  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_Q) : null;
  const onMq = () => {
    if (!mq || mq.matches === mobile) return;
    cleanups.forEach((f) => f());
    mountProfileEditor(root, { ...deps, profile, prefs: base.prefs, status: base.presence });
  };
  if (mq && mq.addEventListener) { mq.addEventListener('change', onMq); cleanups.push(() => mq.removeEventListener('change', onMq)); }
  const onDoc = (e) => { if (emojiOpen && !e.target.closest('.spf-emojiwrap')) { emojiOpen = false; paint('emoji'); } if (reorderIdx !== -1 && !e.target.closest('.spf-fav')) { reorderIdx = -1; paint('favs'); } };
  document.addEventListener('click', onDoc);
  cleanups.push(() => document.removeEventListener('click', onDoc));
  const onBefore = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBefore);
  cleanups.push(() => window.removeEventListener('beforeunload', onBefore));

  return {
    destroy: () => { clearTimeout(pressTimer); cleanups.forEach((f) => f()); },
    save, isDirty: dirty, diff,
    get draft() { return draft; },
  };
}

let current = null;

/** Page #/social/profile : charge profil et préférences, puis monte le formulaire. */
export async function showSocialProfile() {
  if (current) { current.destroy(); current = null; }
  uiState.kind = 'socialprofile';
  document.title = 'Mon profil social · Laststream';
  const back = () => { if (uiState.depth > 0) history.back(); else location.hash = '#/'; };
  detailEl.innerHTML = '';
  const root = h('div', { class: 'spf-root' });
  detailEl.append(root);
  if (isKidProfile() || !isServerMode()) {
    root.append(h('p', { class: 'spf-msg', text: isKidProfile() ? 'Les profils enfants n’ont pas de profil social.' : 'Le profil social demande un compte sur un serveur Laststream.' }), btn('spf-btn spf-sec', 'Retour', back));
    return;
  }
  const load = async () => {
    root.replaceChildren(h('p', { class: 'spf-msg', role: 'status', text: 'Chargement de ton profil social…' }));
    try {
      const [profile, prefs] = await Promise.all([store.loadProfile(), store.loadPrefs()]);
      if (!root.isConnected) return;
      current = mountProfileEditor(root, { profile, prefs, status: store.getState().status, onBack: back });
      const t = root.querySelector('.spf-h1');
      if (t) { t.tabIndex = -1; t.focus({ preventScroll: true }); }
    } catch (e) {
      if (!root.isConnected) return;
      root.replaceChildren(h('p', { class: 'spf-msg', role: 'alert', text: errorText(e) }), h('div', { class: 'spf-row' }, btn('spf-btn spf-pri', 'Réessayer', () => { void load(); }), btn('spf-btn spf-sec', 'Retour', back)));
    }
  };
  await load();
}

registerSocialHook('openProfileEditor', () => {
  if (isKidProfile() || !isServerMode()) return;
  location.hash = '#/social/profile';
});
