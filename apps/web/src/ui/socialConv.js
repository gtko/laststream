/* Discussions Social v3 (lot F3) : gestionnaire des fenêtres. Bureau : une fenêtre ouverte, ancrée à gauche de la barre
 * latérale, et des onglets réduits (avec non-lus) à sa gauche ; l'état ouvert est conservé par profil. Mobile (< 768 px) :
 * plein écran, une seule discussion. Le module enregistre openConversation et renderConversationList dans socialHooks ;
 * main.js appelle configureSocialConv({ launch, toast }) une fois la lecture disponible. */
import * as store from '../data/socialStore';
import { auth } from '../data/auth';
import { registerSocialHook } from './socialHooks.js';
import { socialAvailable } from './socialButton.js';
import { renderConversationList } from './socialConvList.js';
import { createThread } from './socialConvThread.js';
import { avatarEl, h, iconBtn, SVG } from './socialConvDom.js';
import { MAX_TABS, MOBILE_MAX, convInfo, loadWinState, normalizeConv, saveWinState, setActiveConv } from './socialConvModel.js';

let deps = { launch: () => undefined, toast: () => undefined };
/** Conversation ouverte, onglets réduits (du plus récent au plus ancien). */
let active = null;
let min = [];
let ctrl = null;
let root = null;
let tabsEl = null;
let slot = null;
let unsub = null;
let mql = null;
let observers = [];
let restored = false;

const profileId = () => (auth.profile ? auth.profile.id : '');
const isMobile = () => (mql ? mql.matches : (typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX));
const persist = () => { if (!isMobile()) saveWinState(profileId(), { active, min }); };

/** Distance entre la fenêtre et le bord droit : la largeur de la barre latérale ouverte, plus une marge. */
function anchor() {
  if (!root) return;
  const sb = document.getElementById('social-sidebar');
  const w = sb && !sb.hidden ? sb.getBoundingClientRect().width : 0;
  root.style.setProperty('--cvw-right', (w + 16) + 'px');
}

function watchLayout() {
  anchor();
  const sb = document.getElementById('social-sidebar');
  if (sb && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(anchor);
    mo.observe(sb, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    observers.push(() => mo.disconnect());
  }
  if (sb && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(anchor);
    ro.observe(sb);
    observers.push(() => ro.disconnect());
  }
  window.addEventListener('resize', anchor);
  observers.push(() => window.removeEventListener('resize', anchor));
}

function ensureRoot() {
  if (root) return;
  root = h('div', 'cvw-root');
  slot = h('div', 'cvw-slot');
  tabsEl = h('div', 'cvw-tabs');
  root.append(slot, tabsEl);
  document.body.append(root);
  watchLayout();
  unsub = store.subscribe(onStore);
}

function teardownRoot() {
  if (ctrl) { ctrl.destroy(); ctrl = null; }
  if (unsub) { unsub(); unsub = null; }
  observers.forEach((f) => f());
  observers = [];
  if (root) { root.remove(); root = null; }
  slot = null;
  tabsEl = null;
  setActiveConv(null);
}

function mountActive() {
  if (ctrl && ctrl.conv === active && ctrl.mode === (isMobile() ? 'sheet' : 'window')) return;
  if (ctrl) { ctrl.destroy(); ctrl = null; }
  if (!active) return;
  const mode = isMobile() ? 'sheet' : 'window';
  ctrl = createThread({
    conv: active, mode, deps,
    onClose: () => closeConv(active),
    onMinimize: mode === 'window' ? () => minimize() : undefined,
  });
  ctrl.mode = mode;
  root.classList.toggle('is-sheet', mode === 'sheet');
  slot.append(ctrl.el);
  ctrl.activate();
}

function paintTabs(s = store.getState()) {
  if (!tabsEl) return;
  tabsEl.textContent = '';
  for (const conv of min) {
    const inf = convInfo(conv, s);
    const name = inf ? inf.name : 'Discussion';
    const tab = h('div', 'cvw-tab');
    const main = h('button', 'cvw-tab-main', null, { type: 'button', 'aria-label': 'Ouvrir la discussion avec ' + name + (inf && inf.unread ? ', ' + inf.unread + ' non lu' + (inf.unread > 1 ? 's' : '') : '') });
    main.append(
      inf && inf.kind === 'group' ? avatarEl({ name, avatarColor: inf.members[0] && inf.members[0].avatarColor }, 26)
        : avatarEl({ name, avatarColor: inf && inf.avatarColor, avatar: inf && inf.avatar }, 26),
      h('span', 'cvw-tab-name', name),
    );
    if (inf && inf.unread > 0) main.append(h('span', 'cvw-badge', inf.unread > 99 ? '99+' : String(inf.unread), { 'aria-hidden': 'true' }));
    main.addEventListener('click', () => open(conv));
    const x = iconBtn('cvw-tab-x', 'Fermer la discussion avec ' + name, SVG.close.replace(/width="18" height="18"/, 'width="14" height="14"'), () => closeConv(conv));
    tab.append(main, x);
    tabsEl.append(tab);
  }
}

function onStore(s) {
  if (!socialAvailable()) { closeAll(); return; }
  // Conversation disparue (groupe quitté, ami retiré) une fois la liste connue.
  if (s.me) {
    const gone = (c) => !convInfo(c, s);
    const known = s.conversations.length + s.groups.length + s.friends.length + s.household.length > 0;
    if (active && known && gone(active)) closeConv(active);
    const before = min.length;
    min = min.filter((c) => !known || !gone(c));
    if (min.length !== before) persist();
  }
  if (ctrl) ctrl.update(s);
  paintTabs(s);
}

function open(conv) {
  if (!active || active !== conv) {
    if (active && !isMobile() && !min.includes(active)) min.unshift(active);
    min = min.filter((c) => c !== conv).slice(0, MAX_TABS);
    active = conv;
  }
  if (isMobile()) min = [];
  setActiveConv(active);
  persist();
  mountActive();
  paintTabs();
  if (ctrl) ctrl.activate();
}

function minimize() {
  if (!active) return;
  min = [active, ...min.filter((c) => c !== active)].slice(0, MAX_TABS);
  active = null;
  if (ctrl) { ctrl.destroy(); ctrl = null; }
  setActiveConv(null);
  persist();
  paintTabs();
}

function closeConv(conv) {
  if (conv === active) {
    active = null;
    if (ctrl) { ctrl.destroy(); ctrl = null; }
    setActiveConv(null);
  }
  min = min.filter((c) => c !== conv);
  persist();
  paintTabs();
  if (!active && min.length === 0) teardownRoot();
}

function closeAll() {
  active = null;
  min = [];
  teardownRoot();
}

/** Hook `openConversation` : « dm:<pid> », « g:<id> » (ou un pid seul, ancien appel de la barre). */
export function openConversation(arg) {
  const conv = normalizeConv(arg);
  if (!conv || !socialAvailable()) return;
  ensureRoot();
  if (!store.getState().me) Promise.resolve().then(() => store.refresh()).catch(() => undefined);
  open(conv);
}

/** Retour du gestionnaire à l'état initial (tests). */
export function resetSocialConv() {
  closeAll();
  restored = false;
  if (mql && onMql) mql.removeEventListener('change', onMql);
  mql = null;
}

function onMql() {
  if (!root) return;
  // Changement de largeur : la discussion ouverte est reconstruite en fenêtre ou en plein écran (brouillon conservé).
  mountActive();
  paintTabs();
}

/** Restaure fenêtre et onglets du profil une fois le store chargé (bureau seulement). */
function restore() {
  if (restored || isMobile()) return;
  const saved = loadWinState(profileId());
  if (!saved.active && saved.min.length === 0) { restored = true; return; }
  const off = store.subscribe((s) => {
    if (!s.me || restored) return;
    restored = true;
    queueMicrotask(off);
    if (!socialAvailable() || root) return;
    const ok = (c) => !!convInfo(c, s);
    const a = saved.active && ok(saved.active) ? saved.active : null;
    const m = saved.min.filter(ok);
    if (!a && m.length === 0) return;
    ensureRoot();
    min = m;
    active = a;
    setActiveConv(active);
    mountActive();
    paintTabs(s);
  });
}

/** Branche la lecture et le message d'erreur ; restaure l'état ouvert. À appeler une fois depuis main.js. */
export function configureSocialConv(d) {
  deps = { launch: d.launch, toast: d.toast };
  if (typeof window !== 'undefined' && window.matchMedia && !mql) {
    mql = window.matchMedia('(max-width: ' + MOBILE_MAX + 'px)');
    mql.addEventListener('change', onMql);
  }
  if (socialAvailable()) restore();
}

registerSocialHook('openConversation', openConversation);
registerSocialHook('renderConversationList', (el) => renderConversationList(el, deps));
