/* Sous-titres texte de l'hôte, côté invité d'une watch party : bouton « Sous-titres » de la barre (addMenuButton), menu des pistes
 * (popover dans controls.sideSlot), calque dans controls.subtitleLayer. Les pistes arrivent du salon déjà validées (texte seul,
 * GuestRelaySession.onSubtitles) ; le VTT est lu avec parseCues et la cue active suit la position de lecture (tick).
 * Habillage du lecteur principal : classes `lp-subs` (player.css) et réglages lus avec src/player/subs.ts. Le dernier choix de
 * langue est mémorisé dans ce seul navigateur. Aucune URL ici. */
import { LI } from '../player/icons.js';
import { activeCue, cueHtml, parseCues, readSubStyle } from '../player/subs';

/** Clé locale du dernier choix de langue (chaîne vide = sous-titres désactivés). */
export const SUBS_KEY = 'laststream.party.subs';
/** Nombre maximal de pistes affichées (miroir de MAX_PARTY_TRACKS côté hôte). */
const MAX_TRACKS = 8;
const CC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
  '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.2 10.3a2 2 0 1 0 0 3.4M16.2 10.3a2 2 0 1 0 0 3.4"/></svg>';

/** Pistes reçues : seules les chaînes attendues sont gardées, le libellé se replie sur la langue. */
export function cleanTracks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (out.length >= MAX_TRACKS) break;
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.vtt !== 'string') continue;
    const lang = typeof t.lang === 'string' ? t.lang : '';
    const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim() : lang || 'Sous-titres';
    out.push({ id: t.id, lang, label, vtt: t.vtt });
  }
  return out;
}

/** Dernier choix de langue ; null si rien n'a été choisi ou si le stockage est indisponible. */
function readRemembered() {
  try {
    const v = globalThis.localStorage?.getItem(SUBS_KEY);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function writeRemembered(lang) {
  try {
    globalThis.localStorage?.setItem(SUBS_KEY, lang);
  } catch {
    // stockage refusé : le choix vaut pour cette page seulement
  }
}

/**
 * Crée le menu et le calque des sous-titres dans `controls` (createGuestControls). Retourne :
 * setTracks(pistes) (liste du salon, [] = aucune), tick(positionSec) (recale la cue), closeMenu(), destroy().
 * onOpen() est appelé quand le menu s'ouvre (le chat se ferme alors, pour ne pas se superposer).
 */
export function createGuestSubs(controls, { onOpen } = {}) {
  const doc = controls.root.ownerDocument;
  const layer = controls.subtitleLayer;
  const style = readSubStyle();
  layer.classList.add('lp-subs', 'c-' + style.color, 'bg-' + style.background);
  layer.style.setProperty('--subsize', String(style.size / 100));

  const pop = doc.createElement('div');
  pop.className = 'gs-pop';
  pop.hidden = true;
  pop.innerHTML = '<h3>Sous-titres</h3><div class="gs-list" role="menu"></div>';
  controls.sideSlot.appendChild(pop);
  const list = pop.querySelector('.gs-list');

  const btn = controls.addMenuButton({ id: 'subs', icon: CC_ICON, label: 'Sous-titres', onClick: toggle });
  btn.hidden = true;
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  let tracks = [];
  /** Piste active (id) et ses cues ; cache des cues analysées pour la liste courante. */
  let selected = null;
  let cues = null;
  let cache = new Map();
  let lastPos = 0;
  let lastHtml = '';
  let open = false;
  let destroyed = false;
  const listeners = [];
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };

  function cuesOf(t) {
    let c = cache.get(t.id);
    if (!c) {
      try {
        c = parseCues(t.vtt);
      } catch {
        c = [];
      }
      cache.set(t.id, c);
    }
    return c;
  }

  /** Affiche la cue active ; ne touche au DOM que si le texte change. Le HTML vient de cueHtml (texte échappé). */
  function paint() {
    const cue = cues ? activeCue(cues, lastPos) : null;
    const html = cue ? cueHtml(cue.text) : '';
    if (html === lastHtml) return;
    lastHtml = html;
    layer.innerHTML = html ? '<span>' + html + '</span>' : '';
  }

  function item(id, label) {
    const checked = id === selected;
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'gs-item';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', checked ? 'true' : 'false');
    b.innerHTML = '<span class="gs-check" aria-hidden="true">' + (checked ? LI.check : '') + '</span><span class="gs-label"></span>';
    b.querySelector('.gs-label').textContent = label;
    b.addEventListener('click', () => choose(id));
    return b;
  }

  function renderList() {
    list.textContent = '';
    list.appendChild(item(null, 'Désactivés'));
    for (const t of tracks) list.appendChild(item(t.id, t.label));
  }

  function select(t) {
    selected = t ? t.id : null;
    cues = t ? cuesOf(t) : null;
    layer.innerHTML = '';
    lastHtml = '';
    renderList();
    paint();
  }

  /** Choix de l'invité : la langue est mémorisée (sauf piste sans langue, impossible à retrouver ensuite). */
  function choose(id) {
    if (destroyed) return;
    const t = id === null ? null : tracks.find((x) => x.id === id) ?? null;
    select(t);
    if (!t) writeRemembered('');
    else if (t.lang) writeRemembered(t.lang);
    closeMenu();
  }

  /** Liste reçue du salon : la langue précédemment choisie est réactivée si elle est présente. */
  function setTracks(list) {
    if (destroyed) return;
    tracks = cleanTracks(list);
    cache = new Map();
    const remembered = readRemembered();
    const pick = remembered ? tracks.find((t) => t.lang === remembered) ?? null : null;
    btn.hidden = tracks.length === 0;
    if (tracks.length === 0) closeMenu();
    select(pick);
  }

  /** Position de lecture (secondes) : recale la cue affichée. */
  function tick(pos) {
    if (destroyed) return;
    lastPos = Number.isFinite(pos) ? pos : 0;
    paint();
  }

  function openMenu() {
    if (destroyed || open || tracks.length === 0) return;
    open = true;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    onOpen?.();
  }

  function closeMenu() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (open) closeMenu();
    else openMenu();
  }

  // Le menu se referme au clic hors de lui (bouton compris : il bascule) et à Échap.
  listen(doc, 'pointerdown', (e) => {
    if (!open) return;
    const t = e.target instanceof Node ? e.target : null;
    if (t && (pop.contains(t) || btn.contains(t))) return;
    closeMenu();
  });
  listen(doc, 'keydown', (e) => {
    if (open && e.key === 'Escape') closeMenu();
  });

  select(null);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
    listeners.length = 0;
    open = false;
    pop.remove();
    btn.remove();
    layer.innerHTML = '';
    layer.classList.remove('lp-subs', 'c-' + style.color, 'bg-' + style.background);
  }

  return { setTracks, tick, closeMenu, destroy };
}
