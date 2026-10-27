/* Port du prototype (voir tools/port-prototype.mjs). */
import { toggleEpisode } from './watched.js';
import { isKidProfile } from '../data/auth';
import { IMG, REDUCE } from './constants.js';
import { elKey, PLAY_COOLDOWN_MS, runOnce, TOGGLE_COOLDOWN_MS } from './busy.js';
import { closeCtx } from './ctxmenu.js';
import { detailEl, modal, modalClose, toast } from './dom.js';
import { getRemind, scrollToSection, showFiche } from './fiche.js';
import { fetchFull } from './ficheModel.js';
import { loadSeason } from './ficheSections.js';
import { heroVideoSync, toggleHeroSound } from './heroVideo.js';
import { load } from './home.js';
import { closeHover, hv } from './hover.js';
import { ICON } from './icons.js';
import { renderLibrary, renderLibraryPage, setLibMode, toggleLib } from './library.js';
import { closeModal, focusables, openModal, openTrailer, openVideo } from './modal.js';
import { renderFilmography } from './person.js';
import { openPlayer, playerKey } from './player.js';
import { cancelDwell, paintSound, setPreviewSound, stopPreview } from './preview.js';
import { go, goBack, openItem, route } from './router.js';
import { buildSvcRows } from './services.js';
import { playFrom } from './sources-ui.js';
import { openShareDialog } from './socialHooks.js';
import { socialAvailable } from './socialButton.js';
import { state } from './state.js';
import { allChannels, boxLocked, boxStatus, playerEl, refreshCats, renderEpgGrid, setCategory, showProg, snapChannel, toggleFav, tv, tvTest } from './tv.js';
import { esc, store } from './util.js';

/** Un seul déclenchement par bouton : un clic répété pendant l'action (ou juste après, pour une bascule) est ignoré (ODY-237). */
const once = (kind, el, fn, opts = {}) => runOnce(elKey(kind, el), fn, opts);
const toggleOnce = (kind, el, fn) => once(kind, el, fn, { cooldown: TOGGLE_COOLDOWN_MS });

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const preview = t.closest('[data-preview-sound]');
  if (preview) {
    e.preventDefault();
    const p = state.preview;
    if (!p) return;
    p.muted = !p.muted;
    setPreviewSound(p.iframe, !p.muted, p.vo);
    paintSound(p.btn, p.muted);
    return;
  }
  const scroll = t.closest('[data-scroll]');
  if (scroll) {
    e.preventDefault();
    const target = document.getElementById(scroll.dataset.scroll);
    if (target) target.scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  if (t.closest('[data-noop]')) {
    e.preventDefault();
    if (state.inDetail && t.closest('[data-noop]').classList.contains('brand')) location.hash = '#/'; // le logo ramène toujours à l’accueil, quelle que soit la profondeur
    return;
  }
  if (t.closest('[data-retry]')) {
    e.preventDefault();
    load();
    return;
  }
  const tp = t.closest('[data-tvplay]');
  if (tp) {
    e.preventDefault();
    const id = tp.dataset.tvplay;
    const last = snapChannel(store('ls_tv_last'));
    const c = allChannels().find((x) => x.id === id) || tv.favHome.find((x) => x.id === id) || (last && last.id === id ? last : null);
    if (!c) return;
    // Chaîne d'une playlist illisible ici (navigateur, ou box hors du réseau local) : on explique pourquoi.
    if (boxLocked(c)) { toast(boxStatus(c).note); return; }
    const list = tp.dataset.tvctx === 'home' ? tv.homeList : tp.dataset.tvctx === 'favs' ? tv.favHome : tp.closest('.tv-page') ? tv.list : [c];
    openPlayer(c, list, tp);
    return;
  }
  const tfav = t.closest('[data-tvfav]');
  if (tfav) {
    e.preventDefault();
    toggleOnce('tvfav', tfav, () => {
      const on = toggleFav(tfav.dataset.tvfav);
      tfav.setAttribute('aria-pressed', String(on));
      tfav.innerHTML = on ? ICON.starOn : ICON.star;
      refreshCats();
      if (tv.cat === 'Favoris') renderEpgGrid();
    });
    return;
  }
  const tcat = t.closest('[data-tvcat]');
  if (tcat) { e.preventDefault(); setCategory(tcat.dataset.tvcat); return; }
  const tset = t.closest('[data-tvsettings]');
  if (tset) {
    e.preventDefault();
    const box = detailEl.querySelector('#tv-settings');
    if (box) { box.hidden = !box.hidden; tset.setAttribute('aria-expanded', String(!box.hidden)); if (!box.hidden) { const inp = box.querySelector('input:not([type=radio])'); if (inp) inp.focus(); } }
    return;
  }
  if (t.closest('[data-tvtest]')) { e.preventDefault(); tvTest(false); return; }
  if (t.closest('[data-tvclear]')) {
    e.preventDefault();
    try { localStorage.removeItem('ls_tv_playlist'); } catch (_) { /* ignoré */ }
    tv.user = [];
    const msg = detailEl.querySelector('#tv-form-msg');
    if (msg) msg.textContent = 'Playlist retirée.';
    refreshCats();
    renderEpgGrid();
    return;
  }
  const tprog = t.closest('[data-tvprog]');
  if (tprog) { e.preventDefault(); const [cid, st] = tprog.dataset.tvprog.split('|'); showProg(cid, st); return; }
  const hcl = t.closest('[data-hclib]');
  if (hcl) {
    e.preventDefault();
    const hit = state.byKey.get(hcl.dataset.hclib);
    if (!hit) return;
    toggleOnce('lib', hcl, () => {
      const on = toggleLib({ type: hit.type, id: hit.id, name: hit.name, posterPath: hit.posterPath });
      hcl.setAttribute('aria-pressed', String(on));
      hcl.classList.toggle('is-on', on);
      hcl.innerHTML = on ? ICON.check : ICON.list;
      hcl.dataset.tip = on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream';
      hcl.setAttribute('aria-label', on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream');
      toast(on ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque');
      renderLibrary();
    });
    return;
  }
  const pers = t.closest('[data-person]');
  if (pers) { e.preventDefault(); go('#/person/' + pers.dataset.person, pers); return; }
  const bioB = t.closest('[data-bio]');
  if (bioB) {
    e.preventDefault();
    const bp = detailEl.querySelector('#pp-bio');
    const open = bioB.getAttribute('aria-expanded') !== 'true';
    if (bp) bp.classList.toggle('is-clamped', !open);
    bioB.setAttribute('aria-expanded', String(open));
    bioB.textContent = open ? 'Réduire' : 'Lire la suite';
    return;
  }
  const ppf = t.closest('[data-ppf]');
  if (ppf) { e.preventDefault(); if (state.pp) { state.pp.filter = ppf.dataset.ppf; state.pp.limit = 80; renderFilmography(); } return; }
  const pps = t.closest('[data-pps]');
  if (pps) { e.preventDefault(); if (state.pp) { state.pp.sort = pps.dataset.pps; state.pp.limit = 80; renderFilmography(); } return; }
  const ph = t.closest('[data-photo]');
  if (ph) {
    e.preventDefault();
    openModal('<h2 id="modal-title" class="sr-only">Photo</h2><img class="photo-big" src="' + esc(IMG('w780', ph.dataset.photo)) + '" alt="Photo agrandie">', ph, '');
    return;
  }
  const svcT = t.closest('[data-service]');
  if (svcT) { e.preventDefault(); go('#/service/' + svcT.dataset.service, svcT); return; }
  const svcType = t.closest('[data-svctype]');
  if (svcType) {
    e.preventDefault();
    if (state.svc) {
      state.svc.type = svcType.dataset.svctype;
      detailEl.querySelectorAll('[data-svctype]').forEach((b) => b.setAttribute('aria-pressed', String(b === svcType)));
      buildSvcRows(state.svc.sv, state.svc.type, state.token);
    }
    return;
  }
  const back = t.closest('[data-back]');
  if (back) { e.preventDefault(); goBack(); return; }
  const fr = t.closest('[data-fretry]');
  if (fr) {
    e.preventDefault();
    const [ty, id] = fr.dataset.fretry.split(':');
    showFiche(ty, id);
    return;
  }
  const rem = t.closest('[data-remind]');
  if (rem) {
    e.preventDefault();
    toggleOnce('remind', rem, () => {
      const list = getRemind();
      const i = list.indexOf(state.ficheKey);
      if (i >= 0) list.splice(i, 1); else list.push(state.ficheKey);
      store('ls_remind', list);
      const on = i < 0;
      detailEl.querySelectorAll('[data-remind]').forEach((b) => {
        b.setAttribute('aria-pressed', String(on));
        b.innerHTML = (on ? ICON.check : ICON.bell) + '<span class="f-play-label">' + (on ? 'Rappel activé' : 'Me rappeler') + '</span>';
      });
      toast(on ? 'On te rappellera la sortie' : 'Rappel retiré');
    });
    return;
  }
  const play = t.closest('[data-play]');
  if (play) { e.preventDefault(); once('play', play, () => playFrom(play), { el: play, cooldown: PLAY_COOLDOWN_MS }); return; }
  const vid = t.closest('[data-vid]');
  if (vid) {
    e.preventDefault();
    openVideo(vid.dataset.vid, vid.dataset.vtitle || 'Vidéo', vid, vid.dataset.vo === '1');
    return;
  }
  const fs = t.closest('[data-fsound]');
  if (fs) { e.preventDefault(); toggleHeroSound(fs); return; }
  const lb = t.closest('[data-lib]');
  if (lb) {
    e.preventDefault();
    const m = state.model;
    if (!m) return;
    toggleOnce('lib', lb, () => {
      const on = toggleLib({ type: m.type, id: Number(m.id), name: m.name, posterPath: m.posterPath });
      lb.setAttribute('aria-pressed', String(on));
      lb.classList.toggle('is-on', on);
      lb.innerHTML = on ? ICON.check : ICON.list;
      lb.dataset.tip = on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream';
      lb.setAttribute('aria-label', on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream');
      toast(on ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque');
    });
    return;
  }
  const rk = t.closest('[data-remindkey]');
  if (rk) {
    e.preventDefault();
    toggleOnce('remindkey', rk, () => {
      const list = getRemind();
      const k = rk.dataset.remindkey;
      const i = list.indexOf(k);
      if (i >= 0) list.splice(i, 1); else list.push(k);
      store('ls_remind', list);
      const on = i < 0;
      rk.setAttribute('aria-pressed', String(on));
      rk.innerHTML = on ? ICON.check : ICON.bell;
      rk.dataset.tip = on ? 'Rappel activé' : 'Me rappeler';
      toast(on ? 'On te rappellera la sortie' : 'Rappel retiré');
    });
    return;
  }
  if (state.ctxMenu) closeCtx();
  const goT = t.closest('[data-go]');
  if (goT && goT.getAttribute('href')) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return; // nouvel onglet / fenêtre : laisse le navigateur faire
    e.preventDefault(); go(goT.getAttribute('href'), goT);
    return;
  }
  const brw = t.closest('[data-browse]');
  if (brw) { e.preventDefault(); go('#/browse/' + brw.dataset.browse, brw); return; }
  const srch = t.closest('[data-search]');
  if (srch) { e.preventDefault(); go('#/search', srch); return; }
  const calB = t.closest('[data-calnav]');
  if (calB) { e.preventDefault(); go('#/calendar', calB); return; }
  const setB = t.closest('[data-settings]');
    if (setB) { e.preventDefault(); if (isKidProfile()) void import('./auth-ui.js').then((m) => m.leaveKidProfile(), () => toast('Impossible de charger cet écran, vérifiez la connexion.')); else go('#/settings', setB); return; }
    const libNav = t.closest('[data-libnav]');
  if (libNav) { e.preventDefault(); go('#/library', libNav); return; }
  const hidNav = t.closest('[data-hidden-nav]');
  if (hidNav) { e.preventDefault(); go('#/hidden', hidNav); return; }
  const tvNav = t.closest('[data-tvlive]');
  if (tvNav) { e.preventDefault(); go('#/tv-live', tvNav); return; }
  const libM = t.closest('[data-libm]');
  if (libM) { e.preventDefault(); setLibMode(libM.dataset.libm); return; }
  const libF = t.closest('[data-libf]');
  if (libF) { e.preventDefault(); state.libView.type = libF.dataset.libf; renderLibraryPage(); return; }
  const libS = t.closest('[data-libs]');
  if (libS) { e.preventDefault(); state.libView.sort = libS.dataset.libs; renderLibraryPage(); return; }
  const sh = t.closest('[data-share]');
  if (sh) {
    e.preventDefault();
    // Fiche d'un titre, compte connecté : fenêtre « Partager » (amis, groupes, lien public, listes partagées).
    const fm = state.kind === 'fiche' ? state.model : null;
    if (fm && socialAvailable()) {
      openShareDialog({ media: { type: fm.type === 'tv' ? 'series' : 'movie', tmdbId: Number(fm.id), title: fm.name, poster: fm.posterPath || undefined } });
      return;
    }
    const url = location.href;
    const done = () => toast('Lien copié');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => toast('Copie impossible'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { toast('Copie impossible'); }
      ta.remove();
    }
    return;
  }
  const more = t.closest('[data-more]');
  if (more) { e.preventDefault(); scrollToSection('infos'); return; }
  const sp = t.closest('[data-season]');
  if (sp) {
    e.preventDefault();
    if (state.model) loadSeason(state.model, Number(sp.dataset.season), state.token);
    return;
  }
  const sn = t.closest('[data-seen]');
  if (sn) {
    e.preventDefault();
    once('seen', sn, () => toggleEpisode(sn), { el: sn, cooldown: TOGGLE_COOLDOWN_MS });
    return;
  }
  const sr = t.closest('[data-season-retry]');
  if (sr) {
    e.preventDefault();
    const key = state.ficheKey;
    fetchFull(key.split(':')[0], key.split(':')[1]).then((m) => loadSeason(m, Number(sr.dataset.seasonRetry), state.token));
    return;
  }
  const tr = t.closest('[data-trailer]');
  if (tr) {
    e.preventDefault();
    const it = state.byKey.get(tr.dataset.trailer);
    if (it) openTrailer(it, tr);
    return;
  }
  const op = t.closest('[data-open],[data-info]');
  if (op) {
    e.preventDefault();
    openItem(op.dataset.open || op.dataset.info, op, op.dataset.openSeason ? { season: op.dataset.openSeason, episode: op.dataset.openEpisode } : undefined);
  }
});

// Arrêt de l'aperçu quand il sort de l'écran ou quand l'onglet est masqué.
window.addEventListener('scroll', () => {
  if (state.inDetail) detailEl.classList.toggle('is-scrolled', window.scrollY > window.innerHeight * 0.5);
  const p = state.preview;
  if (!p) return;
  const r = p.media.getBoundingClientRect();
  const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  if (visible < r.height * 0.4) stopPreview();
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPreview();
    cancelDwell();
  }
  heroVideoSync();
});

// Logo ou image en échec : repli sur le titre texte, puis sur l'image de repli, puis sur le fond de couleur.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.closest('.ct')) return; // tuiles de collections : repli géré dans collections.js
  if (img.classList.contains('logo-img')) {
    const span = document.createElement('span');
    span.className = 'title-text';
    span.textContent = img.dataset.logo || '';
    img.replaceWith(span);
    return;
  }
  // Image en échec : même adresse une fois (erreur passagère), puis une autre taille, puis l'image de repli, puis le titre.
  const tries = Number(img.dataset.tries || 0);
  img.dataset.tries = String(tries + 1);
  const src = img.currentSrc || img.src;
  const size = /\/t\/p\/(w\d+)\//.exec(src);
  if (tries === 0 && src) { setTimeout(() => { if (img.isConnected) img.src = src; }, 1200); return; }
  if (tries === 1 && size) {
    const alt = size[1] === 'w500' ? 'w342' : 'w500';
    img.src = src.replace('/' + size[1] + '/', '/' + alt + '/');
    return;
  }
  if (img.dataset.fb && img.dataset.fbUsed !== '1' && img.dataset.fb !== src) {
    img.dataset.fbUsed = '1';
    img.src = img.dataset.fb;
    return;
  }
  if (img.parentElement) img.parentElement.classList.add('no-img');
}, true);

// Navigation spatiale simple (télécommande / clavier) dans la fiche.
// Les ••• et ✕ des cartes ne sont pas des cibles de navigation : la carte (role=button) reste l'unique cible.
export const NAV_SEL = 'button:not([disabled]):not([tabindex="-1"]):not(.t-more):not(.t-remove), a[href]:not([tabindex="-1"]), [tabindex="0"]';
export const navItems = (g) => Array.from(g.querySelectorAll(NAV_SEL)).filter((el) => el.getClientRects().length > 0);
export const cx = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };

export function onNavKey(e) {
  const key = e.key;
  const horiz = key === 'ArrowLeft' || key === 'ArrowRight';
  const vert = key === 'ArrowUp' || key === 'ArrowDown';
  if (!horiz && !vert) return false;
  const t = document.activeElement;
  if (!t || !detailEl.contains(t)) {
    if (horiz) {
      const b = detailEl.querySelector('[data-play]');
      if (b) { b.focus(); return true; }
    }
    return false;
  }
  const group = t.closest('[data-nav]');
  if (!group) return false;
  if (horiz) {
    const items = navItems(group);
    const nx = items[items.indexOf(t) + (key === 'ArrowRight' ? 1 : -1)];
    if (nx) nx.focus();
    return true;
  }
  const groups = Array.from(detailEl.querySelectorAll('[data-nav]')).filter((g) => navItems(g).length);
  const target = groups[groups.indexOf(group) + (key === 'ArrowDown' ? 1 : -1)];
  if (!target) return true;
  const x = cx(t);
  const items = navItems(target);
  let best = items[0];
  items.forEach((el) => { if (Math.abs(cx(el) - x) < Math.abs(cx(best) - x)) best = el; });
  if (best) best.focus();
  return true;
}

document.addEventListener('keydown', (e) => {
  if (playerKey(e)) { e.preventDefault(); return; }
  if (!playerEl.hidden) return;
  if (e.key === 'Escape' && state.ctxMenu) { e.preventDefault(); closeCtx(true); return; }
  if (e.key === 'Escape' && hv.el) { e.preventDefault(); closeHover(); return; }
  if (e.key === 'Enter' && e.target instanceof Element && e.target.matches('[data-tvprog]')) {
    e.preventDefault();
    const [cid] = e.target.dataset.tvprog.split('|');
    const c = allChannels().find((x) => x.id === cid);
    if (c) openPlayer(c, tv.list, e.target);
    return;
  }
  if (state.inDetail && modal.hidden && !(e.target instanceof Element && e.target.closest('input, textarea, select'))) {
    if (e.key === 'Backspace') { e.preventDefault(); goBack(); return; }
    if (onNavKey(e)) { e.preventDefault(); return; }
  }
  if (e.key === 'Escape') {
    if (!modal.hidden) {
      e.preventDefault();
      closeModal();
    } else if (state.inDetail && !e.defaultPrevented && !(e.target instanceof Element && e.target.closest('select'))) {
      // defaultPrevented : un menu ouvert de la barre du haut (topnav.js) s'est déjà fermé avec Échap.
      e.preventDefault();
      goBack();
    }
    return;
  }
  if (modal.hidden || e.key !== 'Tab') return;
  const f = focusables();
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  const inside = modal.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
});

document.addEventListener('dblclick', (e) => {
  const cell = e.target instanceof Element && e.target.closest('[data-tvprog]');
  if (!cell) return;
  const c = allChannels().find((x) => x.id === cell.dataset.tvprog.split('|')[0]);
  if (c) openPlayer(c, tv.list, cell);
});
document.addEventListener('change', (e) => {
  const r = e.target;
  if (r instanceof HTMLInputElement && r.name === 'ttype') {
    detailEl.querySelectorAll('[data-ttype]').forEach((d) => { d.hidden = d.dataset.ttype !== r.value; });
  }
});
document.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'tv-form') { e.preventDefault(); tvTest(true); }
});
modalClose.addEventListener('click', () => closeModal());
modal.addEventListener('click', (e) => {
  if (e.target === modal && !modal.querySelector('.addon-cfg')) closeModal(); // pas de fermeture par clic sur le fond pendant la configuration d'un addon
});
window.addEventListener('popstate', () => { state.popping = true; });
window.addEventListener('hashchange', route);
