/* Suivre un film, une série ou une personne (indépendant de la bibliothèque). */
import { runOnce, TOGGLE_COOLDOWN_MS } from './busy.js';
import { esc } from './util.js';
import { userStore } from '../data/userStore';
import { toast } from './dom.js';
import { ICON } from './icons.js';
import { registerCtxItems, state } from './state.js';

/** Métadonnées d'une clé `movie:1` / `tv:2` / `person:3` : élément connu, fiche ouverte, ou attributs du bouton. */
function followMeta(key, btn) {
  const [type, idStr] = key.split(':');
  const id = Number(idStr);
  if (type === 'person') {
    return { type, id, title: (btn && btn.dataset.fname) || '', poster: (btn && btn.dataset.fphoto) || '' };
  }
  const m = state.model && state.model.key === key ? state.model : null;
  if (m) return { type, id, title: m.name, poster: m.posterPath || '' };
  const it = state.byKey.get(key);
  return { type, id, title: it ? it.name : '', poster: it ? it.posterPath || '' : '' };
}

/** Bouton « Suivre » : rond (icône) ou avec libellé selon la classe. */
export function followBtn(key, cls, extra, offLabel) {
  const on = userStore.isFollowing(key);
  return '<button type="button" class="' + cls + (on ? ' is-on' : '') + '" data-follow="' + key + '" aria-pressed="' + on + '"' + (extra || '') +
    (offLabel ? ' data-off-label="' + esc(offLabel) + '"' : '') + ' data-tip="' + (on ? 'Suivi' : 'Suivre') + '" aria-label="' + (on ? 'Suivi (ne plus suivre)' : 'Suivre') + '">' + (on ? ICON.bellOn : ICON.bell) +
    (/(^|\s)btn(\s|$)/.test(cls) ? '<span class="f-follow-label">' + (on ? 'Suivi' : offLabel || 'Suivre') + '</span>' : '') + '</button>';
}

function refreshFollowUI() {
  document.querySelectorAll('[data-follow]').forEach((b) => {
    const on = userStore.isFollowing(b.dataset.follow);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.dataset.tip = on ? 'Suivi' : 'Suivre';
    b.setAttribute('aria-label', on ? 'Suivi (ne plus suivre)' : 'Suivre');
    const off = b.dataset.offLabel;
    const label = b.classList.contains('btn') || off ? '<span class="f-follow-label">' + (on ? 'Suivi' : off || 'Suivre') + '</span>' : '';
    b.innerHTML = (on ? ICON.bellOn : ICON.bell) + label;
  });
}

/** Bascule le suivi : affichage immédiat, annulé si le serveur refuse. */
async function toggleFollow(key, btn) {
  const meta = followMeta(key, btn);
  const on = !userStore.isFollowing(key);
  const pending = userStore.setFollow(meta, on);
  refreshFollowUI();
  toast(on ? (meta.type === 'person' ? 'Tu suis ' + meta.title : 'Suivi : tu seras prévenu des nouveautés') : 'Tu ne suis plus ce titre');
  const ok = await pending;
  if (!ok) {
    refreshFollowUI();
    toast('Enregistrement impossible : modification annulée');
  }
  return ok;
}

document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-follow]') : null;
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  runOnce('follow:' + b.dataset.follow, () => toggleFollow(b.dataset.follow, b), { el: b, cooldown: TOGGLE_COOLDOWN_MS });
}, true);

// Menu contextuel : titres et personnes.
registerCtxItems((t) => {
  if (t.kind !== 'title' && t.kind !== 'show' && t.kind !== 'person') return [];
  const key = t.kind === 'person' ? 'person:' + t.id : t.key;
  const on = userStore.isFollowing(key);
  return [{ id: 'follow', label: on ? 'Ne plus suivre' : 'Suivre', icon: on ? ICON.bellOn : ICON.bell, run: () => toggleFollow(key, t.el) }];
});
