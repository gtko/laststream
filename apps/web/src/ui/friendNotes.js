/* Notes d'un ami (ODY-221) : liste des notes posées sur la timeline des titres (affiche, titre avec saison et épisode,
 * « à 3:32 · il y a 2 h », émoji ou texte), un clic ouvre le titre à cette position, et Modifier / Supprimer sur ses propres
 * notes (édition inline, confirmation en alertdialog, mise à jour optimiste puis retour à l'état serveur en cas d'erreur).
 * Le module possède son état et ses écouteurs : `bind(host)` le monte dans un conteneur (la fiche d'un ami, ou Mon profil
 * social), `load(pid)` charge la première page. Les titres et affiches viennent de fetchServerMeta (4 requêtes au plus en
 * même temps, une par titre). Tout texte venu du serveur passe par esc(). */
import { fetchServerMeta } from '../data/lt';
import { deleteNote, getFriendNotes, updateNote } from '../data/socialV2Api';
import { UserApiError } from '../data/userApi';
import { playAt } from '../data/watchWith';
import { ago, clock, episodeCode, posterBox, socialErrorMessage } from './socialFmt.js';
import { launchPlayback } from './socialHooks.js';
import { esc } from './util.js';

const PAGE = 30;
const TEXT_MAX = 140;
const META_PARALLEL = 4;
const HIDDEN_TEXT = 'Note masquée (Anti-spoiler) : tu n’as pas encore vu ce passage.';

const keyOf = (m) => m.type + ':' + m.tmdbId;

/** « emoji » si le texte est un seul pictogramme, sinon « text » (le serveur tranche en dernier). */
function kindOf(body, fallback) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return fallback;
  const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(body));
  return parts.length === 1 && /\p{Extended_Pictographic}/u.test(body) ? 'emoji' : 'text';
}

function editError(err) {
  if (err instanceof UserApiError && err.code === 'invalid_body') return 'Note invalide : 1 à ' + TEXT_MAX + ' caractères, ou un seul emoji.';
  if (err instanceof UserApiError && err.code === 'note_not_found') return 'Cette note n’existe plus.';
  return socialErrorMessage(err);
}

/** `opts` : toast(msg), myPid() (pid du profil actif), onDeleted() (une note de moins). */
export function createFriendNotes(opts) {
  const toast = opts.toast || (() => undefined);
  const myPid = opts.myPid || (() => '');
  let host = null;
  let seq = 0;
  let s = freshState();

  function freshState() {
    return { pid: null, status: 'idle', items: [], more: false, moreBusy: false, meta: new Map(), editing: null, confirm: null };
  }

  const find = (id) => s.items.find((n) => n.id === id);

  // Les titres arrivent un par un : un seul rendu par image pour tout le lot (annulé si l'état a changé entre-temps).
  let paintTimer = 0;
  function schedulePaint() {
    if (paintTimer) return;
    const mine = seq;
    const run = () => {
      paintTimer = 0;
      // Pas de rendu pendant une édition : le champ garderait son curseur ; le titre apparaît à la fermeture.
      if (mine === seq && !s.editing) render();
    };
    paintTimer = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 0);
  }

  // ---------- Rendu ----------

  function metaOf(n) {
    return s.meta.get(keyOf(n.media)) || { title: 'Titre #' + n.media.tmdbId, poster: null };
  }

  function whenText(n) {
    const a = ago(n.createdAt);
    return 'à ' + clock(n.pos) + (a ? ' · ' + (a === 'à l’instant' ? a : 'il y a ' + a) : '');
  }

  function bodyHTML(n) {
    if (n.hidden) return '<span class="ss-note-body is-hidden">' + esc(HIDDEN_TEXT) + '</span>';
    if (n.kind === 'emoji') return '<span class="ss-note-body is-emoji">' + esc(n.body) + '</span>';
    return '<span class="ss-note-body">« ' + esc(n.body) + ' »</span>';
  }

  function editHTML(n, e) {
    const id = esc(n.id);
    return '<form class="ss-note-edit" data-fn-form="edit" data-id="' + id + '">' +
      '<label class="ss-sr" for="ss-ne-' + id + '">Modifier la note</label>' +
      '<input class="ss-input" id="ss-ne-' + id + '" name="body" maxlength="' + TEXT_MAX + '" autocomplete="off" data-fk="ne-input" value="' + esc(e.value) + '"' +
      (e.err ? ' aria-invalid="true" aria-describedby="ss-nerr-' + id + '"' : '') + '>' +
      (e.err ? '<p class="ss-note-err" id="ss-nerr-' + id + '" role="alert">' + esc(e.err) + '</p>' : '') +
      '<div class="ss-dlg-acts"><button type="button" class="ss-btn2 ss-sec" data-fn="edit-cancel" data-fk="ne-cancel">Annuler</button>' +
      '<button type="submit" class="ss-btn2 ss-pri" data-fk="ne-save">Enregistrer</button></div></form>';
  }

  function noteHTML(n) {
    const m = metaOf(n);
    const code = episodeCode(n.media);
    const title = m.title + (code ? ' · ' + code : '');
    const id = esc(n.id);
    const editing = s.editing && s.editing.id === n.id ? s.editing : null;
    const text = '<span class="ss-note-t"><span class="ss-note-title">' + esc(title) + '</span>' +
      '<span class="ss-note-meta">' + esc(whenText(n)) + '</span>' + (editing ? '' : bodyHTML(n)) + '</span>';
    const poster = posterBox(m.poster, m.title, 'ss-poster-n');
    const first = n.hidden || editing
      ? '<div class="ss-note-row">' + poster + text + '</div>'
      : '<button type="button" class="ss-note-open" data-fn="open" data-id="' + id + '" data-fk="no:' + id + '" aria-label="' +
        esc('Ouvrir ' + title + ' à ' + clock(n.pos)) + '">' + poster + text + '<span class="ss-note-go" aria-hidden="true">Ouvrir ›</span></button>';
    let more = '';
    if (editing) more = editHTML(n, editing);
    else if (n.author.pid === myPid() && !n.hidden) {
      more = '<div class="ss-note-acts"><button type="button" class="ss-btn2 ss-sec" data-fn="edit" data-id="' + id + '" data-fk="ne:' + id + '" aria-label="' +
        esc('Modifier la note sur ' + title) + '">Modifier</button>' +
        '<button type="button" class="ss-btn2 ss-sec" data-fn="ask-delete" data-id="' + id + '" data-fk="nd:' + id + '" aria-label="' +
        esc('Supprimer la note sur ' + title) + '">Supprimer</button></div>';
    }
    return '<li class="ss-note">' + first + more + '</li>';
  }

  function confirmHTML() {
    const n = s.confirm ? find(s.confirm) : null;
    if (!n) return '';
    return '<div class="ss-dlg-bk"><div class="ss-dlg" role="alertdialog" aria-modal="true" aria-labelledby="ss-nd-t" aria-describedby="ss-nd-d">' +
      '<h3 class="ss-dlg-t" id="ss-nd-t">Supprimer cette note ?</h3>' +
      '<p class="ss-hint" id="ss-nd-d">' + (n.kind === 'emoji' ? esc(n.body) : '« ' + esc(n.body) + ' »') + ' disparaîtra de la timeline pour tes amis.</p>' +
      '<div class="ss-dlg-acts"><button type="button" class="ss-btn2 ss-sec" data-fn="delete-cancel" data-fk="nd-cancel">Annuler</button>' +
      '<button type="button" class="ss-btn2 ss-danger" data-fn="delete-ok" data-fk="nd-ok">Supprimer</button></div></div></div>';
  }

  function html() {
    if (s.status === 'loading' || s.status === 'idle') return '<p class="ss-empty" role="status">Chargement…</p>';
    if (s.status === 'error') return '<p class="ss-empty" role="alert">Notes indisponibles. <button type="button" class="ss-link" data-fn="retry" data-fk="n-retry">Réessayer</button></p>';
    if (s.status === 'hidden') return '<p class="ss-empty">Son historique n’est pas partagé.</p>';
    if (!s.items.length) return '<p class="ss-empty">' + (s.pid === myPid() ? 'Tu n’as posé aucune note pour l’instant.' : 'Aucune note pour l’instant.') + '</p>';
    return '<ul class="ss-nlist">' + s.items.map(noteHTML).join('') + '</ul>' +
      (s.more ? '<button type="button" class="ss-btn2 ss-sec ss-notes-more" data-fn="more" data-fk="n-more"' + (s.moreBusy ? ' disabled' : '') + '>' +
        (s.moreBusy ? 'Chargement…' : 'Voir plus') + '</button>' : '') + confirmHTML();
  }

  /** `focusFk` : élément à focaliser après le rendu (sinon celui qui l'était, retrouvé par data-fk). */
  function render(focusFk) {
    if (!host) return;
    const a = document.activeElement;
    const keep = focusFk || (a && host.contains(a) ? a.getAttribute('data-fk') : null);
    const caret = a && a.matches && a.matches('input') && host.contains(a) ? [a.selectionStart, a.selectionEnd] : null;
    host.innerHTML = '<div class="ss-notes">' + html() + '</div>';
    if (!keep) return;
    const el = Array.from(host.querySelectorAll('[data-fk]')).find((x) => x.getAttribute('data-fk') === keep);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (caret && el.setSelectionRange && !focusFk) el.setSelectionRange(caret[0], caret[1]);
  }

  // ---------- Chargement ----------

  async function resolveTitles(list, mine) {
    const todo = [];
    for (const n of list) {
      const k = keyOf(n.media);
      if (!s.meta.has(k) && !todo.some((x) => keyOf(x) === k)) todo.push(n.media);
    }
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const m = todo[i++];
        let entry;
        try {
          const r = await fetchServerMeta(m.type, m.tmdbId);
          entry = { title: r.title || 'Titre #' + m.tmdbId, poster: r.poster || null };
        } catch {
          entry = { title: 'Titre #' + m.tmdbId, poster: null };
        }
        if (mine !== seq) return;
        s.meta.set(keyOf(m), entry);
        schedulePaint();
      }
    };
    await Promise.all(Array.from({ length: Math.min(META_PARALLEL, todo.length) }, worker));
  }

  function load(pid) {
    const mine = ++seq;
    s = freshState();
    s.pid = pid;
    s.status = 'loading';
    render();
    return fetchPage(mine, undefined).then((res) => {
      if (mine !== seq) return;
      if (res.error) {
        s.status = res.error instanceof UserApiError && res.error.status === 403 && res.error.code === 'hidden' ? 'hidden' : 'error';
        render();
        return;
      }
      s.status = 'ok';
      s.items = res.notes;
      s.more = res.notes.length >= PAGE;
      render();
      return resolveTitles(res.notes, mine);
    });
  }

  function fetchPage(mine, before) {
    return Promise.resolve().then(() => getFriendNotes(s.pid, { limit: PAGE, before })).then(
      (r) => ({ notes: (r && Array.isArray(r.notes) ? r.notes : []).filter((n) => n && n.media && n.author) }),
      (error) => ({ error }),
    );
  }

  async function loadMore() {
    if (s.moreBusy || !s.items.length) return;
    const mine = seq;
    s.moreBusy = true;
    render();
    const res = await fetchPage(mine, s.items[s.items.length - 1].createdAt);
    if (mine !== seq) return;
    s.moreBusy = false;
    if (res.error) {
      toast(socialErrorMessage(res.error));
      render();
      return;
    }
    const have = new Set(s.items.map((n) => n.id));
    const fresh = res.notes.filter((n) => !have.has(n.id));
    s.items = s.items.concat(fresh);
    s.more = res.notes.length >= PAGE && fresh.length > 0;
    render();
    await resolveTitles(fresh, mine);
  }

  // ---------- Actions ----------

  async function saveEdit(id, value) {
    const n = find(id);
    const e = s.editing;
    if (!n || !e || e.id !== id) return;
    const body = value.trim();
    if (!body) {
      s.editing = { id, value, err: 'Écris une note (' + TEXT_MAX + ' caractères au maximum).' };
      render('ne-input');
      return;
    }
    if (body === n.body) {
      s.editing = null;
      render('ne:' + id);
      return;
    }
    const mine = seq;
    const prev = { kind: n.kind, body: n.body };
    const kind = kindOf(body, n.kind);
    n.kind = kind;
    n.body = body;
    s.editing = null;
    render('ne:' + id);
    try {
      const r = await updateNote(id, { kind, body });
      if (mine !== seq) return;
      const cur = find(id);
      if (cur && r && r.note) { cur.kind = r.note.kind; cur.body = r.note.body; }
      render();
      toast('Note modifiée');
    } catch (err) {
      if (mine !== seq) return;
      const cur = find(id);
      if (!cur) return;
      cur.kind = prev.kind;
      cur.body = prev.body;
      s.editing = { id, value: body, err: editError(err) };
      render('ne-input');
    }
  }

  async function removeNote(id) {
    const idx = s.items.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const mine = seq;
    const [gone] = s.items.splice(idx, 1);
    s.confirm = null;
    render();
    try {
      await deleteNote(id);
    } catch (err) {
      if (mine !== seq) return;
      if (!(err instanceof UserApiError && err.status === 404)) {
        s.items.splice(Math.min(idx, s.items.length), 0, gone);
        render('nd:' + id);
        toast(socialErrorMessage(err));
        return;
      }
    }
    if (mine !== seq) return;
    toast('Note supprimée');
    if (opts.onDeleted) opts.onDeleted();
  }

  function openNote(id, opener) {
    const n = find(id);
    if (!n || n.hidden) return;
    const m = metaOf(n);
    playAt({ launch: launchPlayback, toast }, { type: n.media.type, tmdbId: n.media.tmdbId, title: m.title, season: n.media.season, episode: n.media.episode }, n.pos, opener);
  }

  function onClick(e) {
    const t = e.target instanceof Element ? e.target.closest('[data-fn]') : null;
    if (!t || !host.contains(t)) return;
    const id = t.dataset.id;
    switch (t.dataset.fn) {
      case 'open': openNote(id, t); break;
      case 'edit': {
        const n = find(id);
        if (n) { s.editing = { id, value: n.body, err: '' }; render('ne-input'); }
        break;
      }
      case 'edit-cancel': {
        const was = s.editing && s.editing.id;
        s.editing = null;
        render(was ? 'ne:' + was : undefined);
        break;
      }
      case 'ask-delete': s.confirm = id; render('nd-cancel'); break;
      case 'delete-cancel': { const was = s.confirm; s.confirm = null; render(was ? 'nd:' + was : undefined); break; }
      case 'delete-ok': if (s.confirm) void removeNote(s.confirm); break;
      case 'more': void loadMore(); break;
      case 'retry': if (s.pid) void load(s.pid); break;
      default: break;
    }
  }

  function onSubmit(e) {
    const f = e.target;
    if (!(f instanceof HTMLFormElement) || f.dataset.fnForm !== 'edit') return;
    e.preventDefault();
    const input = f.querySelector('input[name="body"]');
    void saveEdit(f.dataset.id, input ? input.value : '');
  }

  function onInput(e) {
    if (s.editing && e.target instanceof HTMLInputElement && e.target.name === 'body') s.editing.value = e.target.value;
  }

  /** Tab / Maj+Tab restent dans la confirmation (aria-modal) : le focus boucle entre Annuler et Supprimer. */
  function trapTab(e) {
    const dlg = host.querySelector('.ss-dlg');
    if (!dlg) return;
    const items = Array.from(dlg.querySelectorAll('button:not([disabled])'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement;
    if (!dlg.contains(a)) { e.preventDefault(); first.focus(); } else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }

  /** Échap ferme la confirmation ou l'édition (sans fermer la barre latérale qui écoute plus haut). */
  function onKey(e) {
    if (e.key === 'Tab' && s.confirm) { trapTab(e); return; }
    if (e.key !== 'Escape' || (!s.confirm && !s.editing)) return;
    e.preventDefault();
    e.stopPropagation();
    if (s.confirm) { const was = s.confirm; s.confirm = null; render('nd:' + was); } else { const was = s.editing.id; s.editing = null; render('ne:' + was); }
  }

  function unbind() {
    if (!host) return;
    host.removeEventListener('click', onClick);
    host.removeEventListener('submit', onSubmit);
    host.removeEventListener('input', onInput);
    host.removeEventListener('keydown', onKey);
  }

  return {
    /** Monte la liste dans `el` (rendu immédiat de l'état courant) ; un nouveau conteneur remplace le précédent. */
    bind(el) {
      unbind();
      host = el || null;
      if (!host) return;
      host.addEventListener('click', onClick);
      host.addEventListener('submit', onSubmit);
      host.addEventListener('input', onInput);
      host.addEventListener('keydown', onKey);
      render();
    },
    /** Charge la première page des notes de `pid` (soi-même autorisé). */
    load,
    /** Abandonne tout chargement ou action en cours et vide l'état. */
    reset() {
      seq++;
      s = freshState();
      unbind();
      host = null;
    },
    get loaded() { return s.status !== 'idle'; },
  };
}
