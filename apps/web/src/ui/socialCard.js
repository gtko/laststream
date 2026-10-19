/* Fiche d'un ami (Social v3, maquette « FicheAmi ») dans la barre latérale : bannière, avatar, bio, statut, carte « en train de
 * regarder » (Regarder avec … / Demander à rejoindre), favoris, onglets Récemment / Bibliothèque / Notes, menu ⋯ (watch party,
 * bibliothèque, surnom, favori, sourdine, activité masquée, retirer, bloquer et signaler avec confirmation). Les données
 * viennent du store (relations, blocages) et de l'API (profil, bibliothèque, historique) ; tout texte passe par esc(). */
import * as store from '../data/socialStore';
import { getFriendHistory, getFriendLibrary } from '../data/socialV2Api';
import { getFriendProfile } from '../data/socialV3Api';
import { posterPathOf } from '../data/serverUserStore';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { SI } from './socialIcons.js';
import { inviteToParty, openShareDialog } from './socialHooks.js';
import {
  ago, avatarHTML, clock, customStatusText, episodeCode, livePos, nameHTML, nameOf, posterBox, progressPct, shortName, socialErrorMessage,
  watchLine,
} from './socialFmt.js';
import { playDirect } from './sources-ui.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

const TABS = [['recent', 'Récemment'], ['lib', 'Bibliothèque'], ['notes', 'Ses notes']];
const REASONS = [['spam', 'Spam'], ['harassment', 'Harcèlement'], ['other', 'Autre']];
const BACKDROP_OK = /^https:\/\/image\.tmdb\.org\/t\/p\/\w+\/[\w.-]+$/;

const pathOf = (p) => (p ? posterPathOf(p) || (p.startsWith('/') ? p : '') : '');

/** Fiche d'une tuile de bibliothèque (même forme qu'un titre du catalogue, enregistré dans state.byKey). */
function itemOf(x) {
  const type = x.type === 'series' ? 'tv' : 'movie';
  const raw = { id: x.tmdbId, poster_path: pathOf(x.poster) };
  raw[type === 'tv' ? 'name' : 'title'] = x.title;
  return register(toItem(raw, type));
}

function libTileHTML(x) {
  const it = itemOf(x);
  const k = esc(it.key);
  const have = userStore.inLibrary(it.key);
  return '<div class="ss-tile">' + posterCard(it) +
    '<div class="ss-tile-acts"><button type="button" class="ss-btn ss-btn-sm" data-ss-act="lib-play" data-key="' + k + '" data-fk="lib-play:' + k + '">Lire</button>' +
    '<button type="button" class="ss-btn ss-btn-sm" data-ss-act="lib-save" data-key="' + k + '" data-fk="lib-save:' + k + '"' + (have ? ' disabled' : '') +
    ' aria-label="' + (have ? 'Déjà dans ma bibliothèque' : 'Ajouter à ma bibliothèque') + '">' + (have ? 'Ajouté' : 'Ajouter') + '</button></div></div>';
}

/** Cible de lecture directe : un film, ou l'épisode en cours / le premier d'une série. */
function requestOf(key) {
  const it = state.byKey.get(key);
  if (!it) return null;
  let season = null;
  let episode = null;
  if (it.type === 'tv') {
    const cont = userStore.continueWatching().find((e) => e.type === 'tv' && e.id === it.id && e.season != null);
    season = cont ? cont.season : 1;
    episode = cont ? cont.episode : 1;
  }
  return { type: it.type, id: String(it.id), name: it.name, season, episode, key };
}

function sinceText(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const same = d.getFullYear() === new Date().getFullYear();
  return 'Amis depuis ' + d.toLocaleDateString('fr-FR', same ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

/** Crée le contrôleur de la fiche. `deps` : root (la barre), box (zone de la fiche), toast, findFriend(pid), back(), openChat(pid), watchWith(friend). */
export function createFriendCard(deps) {
  const { box, root } = deps;
  const c = { pid: null, tab: 'recent', menu: false, profile: null, lib: { status: 'loading', items: [] }, hist: { status: 'loading', items: [] }, seq: 0, dialog: null };

  const friend = () => (c.pid ? deps.findFriend(c.pid) : null);

  async function act(fn, ok) {
    try {
      const r = await Promise.resolve().then(fn);
      if (ok) deps.toast(typeof ok === 'function' ? ok(r) : ok);
      return true;
    } catch (err) {
      deps.toast(err instanceof UserApiError && err.status === 403 ? 'Cette personne n’accepte pas cette demande.' : socialErrorMessage(err));
      return false;
    }
  }

  // ---------- Rendu ----------

  function nowHTML(f) {
    const w = f.watching;
    if (!w) return '';
    const pct = progressPct(w);
    const name = esc(shortName(f));
    const where = clock(livePos(w));
    const end = w.duration ? clock(w.duration) : '';
    return '<section class="ss-c-now" aria-label="En train de regarder">' +
      '<div class="ss-c-now-top">' + posterBox(w.poster, w.title, 'ss-poster-m') +
      '<div class="ss-c-now-t"><p class="ss-c-eyebrow">En train de regarder</p><p class="ss-c-now-title">' + esc(w.title) + '</p>' +
      '<p class="ss-prog"><span>' + esc([episodeCode(w), where].filter(Boolean).join(' · ')) + '</span>' +
      '<span class="ss-bar-t" aria-hidden="true"><i style="width:' + pct + '%"></i></span><span>' + esc(end) + '</span></p></div></div>' +
      '<div class="ss-c-now-acts"><button type="button" class="ss-btn2 ss-pri" data-ss-act="watch" data-pid="' + esc(f.pid) + '" data-fk="watch:' + esc(f.pid) + '">' + SI.play + 'Regarder avec ' + name + '</button>' +
      '<button type="button" class="ss-btn2 ss-sec" data-ss-act="c-join" data-pid="' + esc(f.pid) + '" data-fk="c-join">' + SI.join + 'Demander à rejoindre</button></div>' +
      '<p class="ss-c-hint">« Regarder avec ' + name + ' » démarre seul à ' + esc(clock(livePos(w) + 7)) + ' avec ta source. « Demander à rejoindre » propose à ' + name + ' une watch party synchronisée.</p></section>';
  }

  function menuHTML(f) {
    const item = (act2, label, cls = '') => '<button type="button" role="menuitem" class="ss-mi ' + cls + '" data-ss-act="' + act2 + '" data-fk="' + act2 + '">' + label + '</button>';
    return '<div role="menu" class="ss-menu" aria-label="Plus d’actions">' +
      item('m-party', 'Inviter dans ma watch party') +
      item('m-library', 'Voir sa bibliothèque complète') +
      item('m-nick', 'Surnom privé…') +
      item('m-fav', f.favorite ? 'Retirer des favoris' : 'Mettre en favori (en haut)') +
      item('m-mute', f.muted ? 'Réactiver ses notifications' : 'Couper ses notifications') +
      item('m-hide', f.hideActivity ? 'Afficher son activité' : 'Masquer son activité') +
      (f.household ? '' : '<div class="ss-mi-sep" role="separator"></div>' +
        item('m-remove', 'Retirer des amis', 'is-danger') + item('m-block', 'Bloquer et signaler', 'is-danger')) + '</div>';
  }

  function favsHTML(p) {
    const favs = p && p.favorites ? p.favorites.slice(0, 4) : [];
    if (!favs.length) return '';
    return '<h3 class="ss-hd ss-c-hd">' + (favs.length > 1 ? 'Ses ' + favs.length + ' favoris' : 'Son favori') + '</h3><ul class="ss-c-favs">' +
      favs.map((x) => '<li>' + posterBox(x.poster, x.title, 'ss-poster-f') + '</li>').join('') + '</ul>';
  }

  function recentHTML() {
    const h = c.hist;
    if (h.status === 'loading') return '<p class="ss-empty" role="status">Chargement…</p>';
    if (h.status === 'error') return '<p class="ss-empty" role="alert">Historique indisponible. <button type="button" class="ss-link" data-ss-act="lib-retry">Réessayer</button></p>';
    if (h.status === 'hidden') return '<p class="ss-empty">Son historique n’est pas partagé.</p>';
    if (!h.items.length) return '<p class="ss-empty">Rien de récent.</p>';
    return '<ul class="ss-list ss-hist">' + h.items.map((x) => {
      const code = episodeCode(x);
      const state2 = x.watched ? 'Terminé' : 'En cours · ' + clock(x.pos);
      const when = ago(x.updatedAt);
      return '<li class="ss-hrow">' + posterBox(x.poster, x.title, 'ss-poster-s') + '<span class="ss-row-t"><span class="ss-name">' + esc(x.title || 'Sans titre') + (code ? ' · ' + esc(code) : '') + '</span>' +
        '<span class="ss-sub">' + esc(state2 + (when ? ' · il y a ' + when : '')) + '</span></span></li>';
    }).join('') + '</ul>';
  }

  function libHTML() {
    const l = c.lib;
    if (l.status === 'loading') return '<p class="ss-empty" role="status">Chargement…</p>';
    if (l.status === 'error') return '<p class="ss-empty" role="alert">Bibliothèque indisponible. <button type="button" class="ss-link" data-ss-act="lib-retry">Réessayer</button></p>';
    const shown = l.items.filter((x) => x.tmdbId != null);
    if (!shown.length) {
      const f = friend();
      return '<p class="ss-empty">' + esc(f ? shortName(f) : 'Cet ami') + ' n’a rien partagé pour l’instant.</p>';
    }
    return '<div class="ss-lib-grid">' + shown.map(libTileHTML).join('') + '</div>';
  }

  function notesHTML() {
    const n = c.profile && c.profile.stats ? c.profile.stats.notes : null;
    return '<p class="ss-empty">' + (n != null ? esc(String(n)) + ' note' + (n > 1 ? 's' : '') + ' posée' + (n > 1 ? 's' : '') + ' sur la timeline des titres. ' : '') +
      'Ses notes apparaissent pendant la lecture, au moment du film où il les a posées.</p>';
  }

  function cardHTML(f) {
    const p = c.profile && c.profile !== 'error' ? c.profile : null;
    const pid = esc(f.pid);
    const bio = p && p.bio ? '<p class="ss-c-bio">« ' + esc(p.bio) + ' »</p>' : '';
    const cs = customStatusText(f.customStatus || (p && p.customStatus));
    const bits = [];
    if (p && p.friendSince) bits.push(sinceText(p.friendSince));
    if (p && p.commonTitles) bits.push(p.commonTitles + ' titre' + (p.commonTitles > 1 ? 's' : '') + ' en commun');
    if (!bits.length && f.household) bits.push('Profil de ce compte');
    const libCount = c.lib.status === 'ok' ? c.lib.items.filter((x) => x.tmdbId != null).length : null;
    const notesCount = p && p.stats ? p.stats.notes : null;
    const counts = { recent: '', lib: libCount != null ? ' · ' + libCount : '', notes: notesCount != null ? ' · ' + notesCount : '' };
    const tabs = '<div role="tablist" class="ss-c-tabs" aria-label="Contenu de la fiche">' + TABS.map(([id, label]) =>
      '<button type="button" role="tab" id="ss-ct-' + id + '" class="ss-c-tab" aria-selected="' + (c.tab === id) + '" tabindex="' + (c.tab === id ? '0' : '-1') +
      '" data-ss-act="c-tab" data-tab="' + id + '" data-fk="c-tab:' + id + '">' + label + esc(counts[id]) + '</button>').join('') + '</div>';
    const body = c.tab === 'lib' ? libHTML() : c.tab === 'notes' ? notesHTML() : recentHTML();
    return '<div class="ss-c-banner" data-banner><span class="ss-c-banner-t">' + (p && p.banner ? 'Bannière : ' + esc(p.banner.title) : '') + '</span></div>' +
      '<div class="ss-c-idrow">' + avatarHTML(f, 'ss-av-xl', f.status) + '<p class="ss-c-since">' + esc(bits.join(' · ')) + '</p></div>' +
      '<div class="ss-c-id"><h3 class="ss-c-name">' + nameHTML(f) + '</h3>' +
      (f.nickname ? '<p class="ss-c-real">' + esc(nameOf(f)) + '</p>' : '') +
      (cs ? '<p class="ss-c-cs">' + esc(cs) + '</p>' : '') + bio + '</div>' +
      nowHTML(f) +
      '<div class="ss-c-actions"><button type="button" class="ss-btn2 ss-sec" data-ss-act="message" data-pid="' + pid + '" data-fk="message:' + pid + '">' + SI.chat + 'Message</button>' +
      '<button type="button" class="ss-btn2 ss-sec" data-ss-act="c-share" data-pid="' + pid + '" data-fk="c-share">' + SI.share + 'Envoyer un titre</button>' +
      '<button type="button" class="ss-more" data-ss-act="c-menu" data-fk="c-menu" aria-label="Plus d’actions" aria-haspopup="menu" aria-expanded="' + c.menu + '">' + SI.more + '</button>' +
      (c.menu ? menuHTML(f) : '') + '</div>' +
      favsHTML(p) + tabs + '<div class="ss-c-panel" role="tabpanel" aria-labelledby="ss-ct-' + c.tab + '">' + body + '</div>';
  }

  /** Clé de focus de l'élément actif, pour le retrouver après un nouveau rendu. */
  const focusKey = () => {
    const a = document.activeElement;
    return a && box.contains(a) ? a.getAttribute('data-fk') : null;
  };

  function paint() {
    const f = friend();
    if (!f) return false;
    const keep = focusKey();
    box.innerHTML = cardHTML(f);
    const p = c.profile && c.profile !== 'error' ? c.profile : null;
    if (p && p.banner && p.banner.backdrop) {
      const url = IMG('w780', p.banner.backdrop);
      const el = box.querySelector('[data-banner]');
      if (el && BACKDROP_OK.test(url)) el.style.backgroundImage = 'linear-gradient(0deg, rgba(23,21,31,.55), rgba(23,21,31,0)), url("' + url + '")';
    }
    if (c.tab === 'lib') observeTiles(box);
    if (keep) {
      const el = Array.from(box.querySelectorAll('[data-fk]')).find((x) => x.getAttribute('data-fk') === keep);
      if (el) el.focus({ preventScroll: true });
    }
    return true;
  }

  // ---------- Chargement ----------

  function load(pid) {
    const seq = ++c.seq;
    const ok = () => seq === c.seq && c.pid === pid;
    c.lib = { status: 'loading', items: [] };
    c.hist = { status: 'loading', items: [] };
    c.profile = null;
    Promise.resolve().then(() => getFriendProfile(pid)).then(
      (p) => { if (ok()) { c.profile = p; paint(); } },
      () => { if (ok()) { c.profile = 'error'; paint(); } },
    );
    Promise.resolve().then(() => getFriendLibrary(pid)).then(
      (res) => { if (ok()) { c.lib = { status: 'ok', items: (res && res.items) || [] }; paint(); } },
      () => { if (ok()) { c.lib = { status: 'error', items: [] }; paint(); } },
    );
    Promise.resolve().then(() => getFriendHistory(pid, 20)).then(
      (res) => { if (ok()) { c.hist = { status: 'ok', items: (res && res.items) || [] }; paint(); } },
      (err) => { if (ok()) { c.hist = { status: err instanceof UserApiError && err.code === 'hidden' ? 'hidden' : 'error', items: [] }; paint(); } },
    );
  }

  // ---------- Dialogues (surnom, retrait, blocage) ----------

  function closeDialog(refocus = true) {
    const d = c.dialog;
    if (!d) return;
    d.el.remove();
    c.dialog = null;
    if (refocus && d.opener && d.opener.isConnected) d.opener.focus({ preventScroll: true });
  }

  function openDialog(kind, f, inner) {
    closeDialog(false);
    const el = document.createElement('div');
    el.className = 'ss-dlg-bk';
    el.innerHTML = '<form class="ss-dlg" role="alertdialog" aria-modal="true" aria-labelledby="ss-dlg-t" data-ss-form="' + kind + '">' + inner + '</form>';
    root.append(el);
    c.dialog = { el, kind, pid: f.pid, opener: document.activeElement };
    const first = el.querySelector('input,textarea,button[type="submit"]');
    if (first) first.focus({ preventScroll: true });
  }

  const dlgBtns = (ok, danger, extra = '') => '<div class="ss-dlg-acts"><button type="button" class="ss-btn2 ss-sec" data-ss-act="dlg-cancel">Annuler</button>' + extra +
    '<button type="submit" class="ss-btn2 ' + (danger ? 'ss-danger' : 'ss-pri') + '" data-ss-act="dlg-ok">' + ok + '</button></div>';

  function askNickname(f) {
    openDialog('nick', f, '<h3 class="ss-dlg-t" id="ss-dlg-t">Surnom privé</h3><p class="ss-hint">Seul toi le vois. Il remplace le nom de ' + esc(f.handle.name) + ' dans ta liste.</p>' +
      '<label class="ss-sr" for="ss-dlg-nick">Surnom</label><input class="ss-input" id="ss-dlg-nick" name="nickname" maxlength="32" autocomplete="off" value="' + esc(f.nickname || '') + '">' +
      dlgBtns('Enregistrer', false, f.nickname ? '<button type="button" class="ss-btn2 ss-sec" data-ss-act="dlg-clear">Effacer</button>' : ''));
  }

  function askRemove(f) {
    openDialog('remove', f, '<h3 class="ss-dlg-t" id="ss-dlg-t">Retirer ' + esc(shortName(f)) + ' de tes amis ?</h3><p class="ss-hint">Vous ne verrez plus ce que l’autre regarde. Tu peux le redemander en ami plus tard.</p>' +
      dlgBtns('Retirer', true));
  }

  function askBlock(f) {
    openDialog('block', f, '<h3 class="ss-dlg-t" id="ss-dlg-t">Bloquer et signaler ' + esc(shortName(f)) + ' ?</h3>' +
      '<p class="ss-hint">Vous ne serez plus amis et ne pourrez plus vous écrire ni vous voir. Le signalement est transmis au propriétaire du serveur.</p>' +
      '<fieldset class="ss-fs"><legend class="ss-sr">Motif</legend>' + REASONS.map(([v, l], i) =>
        '<label class="ss-radio"><input type="radio" name="reason" value="' + v + '"' + (i === 0 ? ' checked' : '') + '> ' + l + '</label>').join('') + '</fieldset>' +
      '<label class="ss-sr" for="ss-dlg-det">Détails</label><textarea class="ss-input" id="ss-dlg-det" name="details" rows="3" maxlength="500" placeholder="Détails (facultatif)"></textarea>' +
      dlgBtns('Bloquer et signaler', true));
  }

  /** Validation d'un dialogue (submit du formulaire data-ss-form). */
  async function submit(form) {
    const d = c.dialog;
    if (!d || !d.el.contains(form)) return false;
    const f = deps.findFriend(d.pid);
    if (!f) { closeDialog(false); return true; }
    const data = new FormData(form);
    const kind = d.kind;
    closeDialog(false);
    if (kind === 'nick') {
      const v = String(data.get('nickname') || '').trim();
      await act(() => store.saveRelation(f.pid, { nickname: v || null }), v ? 'Surnom enregistré' : 'Surnom effacé');
    } else if (kind === 'remove') {
      await act(() => store.removeFriend(f.pid), shortName(f) + ' a été retiré.');
    } else if (kind === 'block') {
      const reason = String(data.get('reason') || 'other');
      const details = String(data.get('details') || '').trim();
      await act(async () => {
        await store.report({ pid: f.pid, reason, ...(details ? { details } : {}) });
        await store.block(f.pid);
      }, shortName(f) + ' est bloqué et signalé.');
    }
    return true;
  }

  // ---------- Actions ----------

  async function relation(f, patch, ok) {
    c.menu = false;
    paint();
    await act(() => store.saveRelation(f.pid, patch), ok);
  }

  /** Traite une action `data-ss-act` ; renvoie true si elle appartient à la fiche. */
  function handle(actName, el) {
    const f = friend();
    switch (actName) {
      case 'c-menu':
        c.menu = !c.menu;
        paint();
        if (c.menu) {
          const first = box.querySelector('.ss-menu .ss-mi');
          if (first) first.focus({ preventScroll: true });
        }
        return true;
      case 'c-tab':
        c.tab = el.dataset.tab;
        paint();
        return true;
      case 'c-join':
        if (f) {
          act(() => store.requestJoin(f.pid), 'Demande envoyée à ' + shortName(f));
        }
        return true;
      case 'c-share':
        if (f) openShareDialog({ media: null, to: [f.pid] });
        return true;
      case 'm-party':
        c.menu = false;
        paint();
        if (f) inviteToParty(f.pid);
        return true;
      case 'm-library':
        c.menu = false;
        paint();
        if (f) deps.openLibrary(f.pid);
        return true;
      case 'm-nick': c.menu = false; paint(); if (f) askNickname(f); return true;
      case 'm-fav': if (f) relation(f, { favorite: !f.favorite }, f.favorite ? 'Retiré des favoris' : shortName(f) + ' est en favori'); return true;
      case 'm-mute': if (f) relation(f, { muted: !f.muted }, f.muted ? 'Notifications réactivées' : 'Notifications coupées'); return true;
      case 'm-hide': if (f) relation(f, { hideActivity: !f.hideActivity }, f.hideActivity ? 'Activité affichée' : 'Activité masquée'); return true;
      case 'm-remove': c.menu = false; paint(); if (f) askRemove(f); return true;
      case 'm-block': c.menu = false; paint(); if (f) askBlock(f); return true;
      case 'dlg-cancel': closeDialog(); return true;
      case 'dlg-clear': {
        const d = c.dialog;
        const g = d && deps.findFriend(d.pid);
        closeDialog(false);
        if (g) act(() => store.saveRelation(g.pid, { nickname: null }), 'Surnom effacé');
        return true;
      }
      case 'dlg-ok': return true; // le formulaire part via submit()
      case 'lib-play': {
        const req = requestOf(el.dataset.key);
        if (req) playDirect(req, el);
        return true;
      }
      case 'lib-save': {
        const it = state.byKey.get(el.dataset.key);
        if (it) {
          userStore.addToLibrary({ id: it.id, type: it.type, title: it.name, poster: it.posterPath || '', year: it.year || '' });
          el.disabled = true;
          el.textContent = 'Ajouté';
          deps.toast('Ajouté à ta bibliothèque');
        }
        return true;
      }
      case 'lib-retry': if (c.pid) load(c.pid); paint(); return true;
      default: return false;
    }
  }

  return {
    get pid() { return c.pid; },
    get menuOpen() { return c.menu; },
    get dialogOpen() { return !!c.dialog; },
    open(pid) {
      closeDialog(false);
      c.pid = pid;
      c.tab = 'recent';
      c.menu = false;
      load(pid);
      paint();
    },
    close() {
      closeDialog(false);
      c.pid = null;
      c.menu = false;
      c.seq++;
    },
    repaint: paint,
    handle,
    submit,
    closeMenu(refocus = true) {
      if (!c.menu) return false;
      c.menu = false;
      paint();
      if (refocus) {
        const b = box.querySelector('[data-ss-act="c-menu"]');
        if (b) b.focus({ preventScroll: true });
      }
      return true;
    },
    closeDialog,
    /** Texte de suivi de la lecture, exporté pour l'affichage compact. */
    watchLine,
  };
}
