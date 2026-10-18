/* Port du prototype (voir tools/port-prototype.mjs). */
import { toggleEpisode } from './watched.js';
import { browseMore } from './kids.js';
import { isKidProfile } from '../data/auth';
import { leaveKidProfile } from './auth-ui.js';
import { IMG, REDUCE } from './constants.js';
import { closeCtx } from './ctxmenu.js';
import { detailEl, modal, modalClose, toast } from './dom.js';
import { getRemind, scrollToSection, showFiche } from './fiche.js';
import { fetchFull } from './ficheModel.js';
import { loadSeason } from './ficheSections.js';
import { heroVideoSync, toggleHeroSound } from './heroVideo.js';
import { load } from './home.js';
import { closeHover, hv } from './hover.js';
import { ICON } from './icons.js';
import { renderLibrary, renderLibraryPage, toggleLib } from './library.js';
import { closeModal, focusables, openModal, openTrailer, openVideo } from './modal.js';
import { renderFilmography } from './person.js';
import { closePlayer, openPlayer, playerKey, showBanner, updateBanner, zap } from './player.js';
import { cancelDwell, postYT, stopPreview } from './preview.js';
import { go, goBack, openItem, route } from './router.js';
import { buildSvcRows } from './services.js';
import { playFrom } from './sources-ui.js';
import { state } from './state.js';
import { allChannels, bannerEl, moreRows, playerEl, refreshCats, renderEpgGrid, setCategory, showProg, toggleFav, tv, tvTest } from './tv.js';
import { esc, store } from './util.js';

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const preview = t.closest('[data-preview-sound]');
  if (preview) {
    e.preventDefault();
    const p = state.preview;
    if (!p) return;
    p.muted = !p.muted;
    postYT(p.iframe, p.muted ? 'mute' : 'unMute');
    p.btn.textContent = p.muted ? 'Son' : 'Couper le son';
    p.btn.setAttribute('aria-pressed', String(!p.muted));
    p.btn.setAttribute('aria-label', p.muted ? 'Activer le son' : 'Couper le son');
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
    if (state.inDetail && t.closest('[data-noop]').classList.contains('brand')) goBack();
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
    const last = store('ls_tv_last');
    const c = allChannels().find((x) => x.id === id) || (last && last.id === id ? last : null);
    if (!c) return;
    const list = tp.dataset.tvctx === 'home' ? tv.homeList : tp.closest('.tv-page') ? tv.list : [c];
    openPlayer(c, list, tp);
    return;
  }
  if (t.closest('[data-pclose]')) { e.preventDefault(); closePlayer(); return; }
  if (t.closest('[data-pnext]')) { e.preventDefault(); zap(1); return; }
  if (t.closest('[data-pprev]')) { e.preventDefault(); zap(-1); return; }
  if (t.closest('[data-pinfo]')) { e.preventDefault(); tv.info = !tv.info; updateBanner(); if (tv.info) showBanner(true); else bannerEl.classList.remove('is-on'); return; }
  const tfav = t.closest('[data-tvfav]');
  if (tfav) {
    e.preventDefault();
    const on = toggleFav(tfav.dataset.tvfav);
    tfav.setAttribute('aria-pressed', String(on));
    tfav.innerHTML = on ? ICON.starOn : ICON.star;
    refreshCats();
    if (tv.cat === 'Favoris') renderEpgGrid();
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
  if (t.closest('[data-tvmore]')) { e.preventDefault(); moreRows(); return; }
  const hcl = t.closest('[data-hclib]');
  if (hcl) {
    e.preventDefault();
    const hit = state.byKey.get(hcl.dataset.hclib);
    if (!hit) return;
    const on = toggleLib({ type: hit.type, id: hit.id, name: hit.name, posterPath: hit.posterPath });
    hcl.setAttribute('aria-pressed', String(on));
    hcl.classList.toggle('is-on', on);
    hcl.innerHTML = on ? ICON.check : ICON.list;
    hcl.dataset.tip = on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream';
    hcl.setAttribute('aria-label', on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream');
    toast(on ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque');
    renderLibrary();
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
  if (t.closest('[data-ppmore]')) { e.preventDefault(); if (state.pp) { state.pp.limit += 120; renderFilmography(); } return; }
  const ph = t.closest('[data-photo]');
  if (ph) {
    e.preventDefault();
    openModal('<h2 id="modal-title" class="sr-only">Photo</h2><img class="photo-big" src="' + esc(IMG('w780', ph.dataset.photo)) + '" alt="Photo agrandie">', ph, '');
    return;
  }
  const svcT = t.closest('[data-service]');
  if (svcT) { e.preventDefault(); go('#/service/' + svcT.dataset.service, svcT); return; }
  const svcs = t.closest('[data-svcs]');
  if (svcs) { e.preventDefault(); go('#/services', svcs); return; }
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
    return;
  }
  const play = t.closest('[data-play]');
  if (play) { e.preventDefault(); playFrom(play); return; }
  const vid = t.closest('[data-vid]');
  if (vid) {
    e.preventDefault();
    openVideo(vid.dataset.vid, vid.dataset.vtitle || 'Vidéo', vid);
    return;
  }
  const fs = t.closest('[data-fsound]');
  if (fs) { e.preventDefault(); toggleHeroSound(fs); return; }
  const lb = t.closest('[data-lib]');
  if (lb) {
    e.preventDefault();
    const m = state.model;
    if (!m) return;
    const on = toggleLib({ type: m.type, id: Number(m.id), name: m.name, posterPath: m.posterPath });
    lb.setAttribute('aria-pressed', String(on));
    lb.classList.toggle('is-on', on);
    lb.innerHTML = on ? ICON.check : ICON.list;
    lb.dataset.tip = on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream';
    lb.setAttribute('aria-label', on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream');
    toast(on ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque');
    return;
  }
  const rk = t.closest('[data-remindkey]');
  if (rk) {
    e.preventDefault();
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
    return;
  }
  const cx = t.closest('[data-ctx]');
  if (cx) {
    e.preventDefault();
    const key = state.ctxMenu && state.ctxMenu.dataset.key;
    const it = key && state.byKey.get(key);
    closeCtx();
    if (!it) return;
    if (cx.dataset.ctx === 'open') { go('#/' + it.type + '/' + it.id, null); return; }
    const on = toggleLib({ type: it.type, id: it.id, name: it.name, posterPath: it.posterPath });
    toast(on ? 'Ajouté à ta bibliothèque' : 'Retiré de ta bibliothèque');
    renderLibrary();
    return;
  }
  if (state.ctxMenu) closeCtx();
  const brw = t.closest('[data-browse]');
  if (brw) { e.preventDefault(); go('#/browse/' + brw.dataset.browse, brw); return; }
  if (t.closest('[data-browse-more]')) { e.preventDefault(); browseMore(); return; }
  const srch = t.closest('[data-search]');
  if (srch) { e.preventDefault(); go('#/search', srch); return; }
  const setB = t.closest('[data-settings]');
    if (setB) { e.preventDefault(); if (isKidProfile()) leaveKidProfile(); else go('#/settings', setB); return; }
    const libNav = t.closest('[data-libnav]');
  if (libNav) { e.preventDefault(); go('#/library', libNav); return; }
  const tvNav = t.closest('[data-tvlive]');
  if (tvNav) { e.preventDefault(); go('#/tv-live', tvNav); return; }
  const libF = t.closest('[data-libf]');
  if (libF) { e.preventDefault(); state.libView.type = libF.dataset.libf; renderLibraryPage(); return; }
  const libS = t.closest('[data-libs]');
  if (libS) { e.preventDefault(); state.libView.sort = libS.dataset.libs; renderLibraryPage(); return; }
  const sh = t.closest('[data-share]');
  if (sh) {
    e.preventDefault();
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
      toggleEpisode(sn);
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
    openItem(op.dataset.open || op.dataset.info, op);
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
  if (img.classList.contains('logo-img')) {
    const span = document.createElement('span');
    span.className = 'title-text';
    span.textContent = img.dataset.logo || '';
    img.replaceWith(span);
    return;
  }
  if (img.dataset.fb && img.dataset.fbUsed !== '1') {
    img.dataset.fbUsed = '1';
    img.src = img.dataset.fb;
    return;
  }
  if (img.parentElement) img.parentElement.classList.add('no-img');
}, true);

// Navigation spatiale simple (télécommande / clavier) dans la fiche.
export const NAV_SEL = 'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex="0"]';
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
  if (e.key === 'Escape' && state.ctxMenu) { e.preventDefault(); closeCtx(); return; }
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
    } else if (state.inDetail && !(e.target instanceof Element && e.target.closest('select'))) {
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
  if (e.target === modal) closeModal();
});
window.addEventListener('popstate', () => { state.popping = true; });
window.addEventListener('hashchange', route);
