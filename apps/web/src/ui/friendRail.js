/* Rail d'amis permanent de l'accueil (bureau) : avatars des amis et du foyer groupés en train de regarder / en ligne / hors ligne, pastille de présence,
 * bouton d'ajout. Un clic ouvre la barre des amis (la fiche de l'ami pour un avatar). Suit la présence en direct par l'abonnement
 * au store social (aucune requête en plus). Tout texte venant du serveur passe par esc(). */
import { getState, subscribe } from '../data/socialStore';
import { ensureSocial } from './socialHooks.js';
import { socialAvailable } from './socialButton.js';
import { SEEN_LABEL, avatarHTML, byName, shortName } from './socialFmt.js';
import { SI } from './socialIcons.js';
import { esc } from './util.js';

/** Avatars affichés au plus par groupe : le rail défile, mais reste léger. */
export const RAIL_MAX = 40;

const GROUPS = [['watching', 'En train de regarder'], ['online', 'En ligne'], ['offline', 'Hors ligne']];

/** Répartit les amis acceptés et les profils du foyer, rangés comme des amis : regarde, en ligne, hors ligne (un profil une seule fois). */
export function railGroups(s) {
  const out = { watching: [], online: [], offline: [] };
  const seen = new Set();
  [...s.friends, ...(s.household || [])].forEach((f) => {
    if (seen.has(f.pid)) return;
    seen.add(f.pid);
    out[f.watching ? 'watching' : f.status === 'offline' ? 'offline' : 'online'].push(f);
  });
  Object.values(out).forEach((l) => l.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || byName(a, b)));
  return out;
}

function itemHTML(f, group) {
  const state = group === 'watching' ? 'regarde ' + f.watching.title : (SEEN_LABEL[f.status] || '').toLowerCase();
  return '<li><button type="button" class="fr-item is-' + group + '" data-fr-pid="' + esc(f.pid) + '" title="' + esc(shortName(f)) + '"' +
    ' aria-label="' + esc(shortName(f) + (f.household ? ' (foyer)' : '') + (state ? ', ' + state : '')) + '">' +
    avatarHTML(f, 'fr-av', group === 'watching' ? 'watch' : f.status) + '</button></li>';
}

/** Contenu du rail : ajout, puis chaque groupe non vide séparé par un trait. */
export function railHTML(s) {
  const g = railGroups(s);
  const groups = GROUPS.filter(([id]) => g[id].length).map(([id, title]) =>
    '<hr class="fr-sep"><ul class="fr-group" role="group" aria-label="' + esc(title) + ' (' + g[id].length + ')">' +
    g[id].slice(0, RAIL_MAX).map((f) => itemHTML(f, id)).join('') + '</ul>').join('');
  return '<button type="button" class="fr-add" data-fr-add aria-label="Ajouter un ami">' + SI.addUser + '</button>' + groups;
}

/** Ouvre la barre des amis (Social chargé au besoin) : la fiche de l'ami `pid`, ou la liste avec le champ d'ajout. */
function openSidebar(pid) {
  void ensureSocial().then(() => import('./socialSidebar.js')).then((m) => {
    if (pid) { m.openFriendCard(pid); return; }
    m.openSidebar();
    const input = document.getElementById('ss-add-in');
    if (input) input.focus({ preventScroll: true });
  }).catch(() => undefined);
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-fr-pid], [data-fr-add]') : null;
  if (!t) return;
  openSidebar(t.dataset.frPid || '');
}

let watching = false;
/** Dernier contenu écrit dans chaque conteneur (rail du bureau, rangée d'avatars du mobile) : rien n'est réécrit s'il n'a pas changé. */
const written = new WeakMap();

function paintInto(el, html) {
  if (written.get(el) === html) return;
  const cur = document.activeElement;
  const focused = cur instanceof HTMLElement && el.contains(cur) ? cur : null;
  const pid = focused ? focused.dataset.frPid : undefined;
  written.set(el, html);
  // eslint-disable-next-line no-restricted-syntax -- noms, pid et titres échappés par esc (railHTML)
  el.innerHTML = html;
  if (!el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('click', onClick); }
  if (focused) { // le rail se redessine : le focus clavier reste sur le même ami (ou sur l'ajout)
    const same = Array.from(el.querySelectorAll('button')).find((b) => (pid ? b.dataset.frPid === pid : 'frAdd' in b.dataset));
    if (same) same.focus({ preventScroll: true });
  }
}

/** Redessine le rail (bureau) et la rangée d'avatars (mobile) affichés ; sans effet si rien n'a changé (l'avatar ne clignote pas à chaque message reçu). */
export function paintRail(s = getState()) {
  if (!watching) { watching = true; subscribe((next) => paintRail(next)); }
  const html = socialAvailable() ? railHTML(s) : '';
  ['friend-rail', 'friend-strip'].forEach((id) => { const el = document.getElementById(id); if (el) paintInto(el, html); });
}
