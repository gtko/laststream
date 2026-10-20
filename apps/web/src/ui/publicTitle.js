/* Social v3 (lot F4) : page publique d'un lien de partage (#/t/<code>, ou /t/<code> servi par le Worker), sans session :
 * la fiche recommandée, le mot de l'ami, « Ouvrir dans Laststream » et, si le lien porte une invitation, « Créer un compte avec
 * l'invitation » (inscription existante, ?invite=<code>). Jamais la position ni la bibliothèque de l'ami, sauf « ce moment ». */
import { getShareLink } from '../data/socialV3Api';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { state } from './state.js';
import { h, posterSrc, avatarEl } from './socialConvDom.js';
import * as M from './shareModel.js';

let token = 0;

function errorText(e) {
  if (e && e.status === 404) return 'Ce lien n’existe pas ou n’est plus valide.';
  if (e && e.status === 429) return 'Trop de demandes pour le moment : réessaie dans une minute.';
  if (e && (e.status === 0 || e.code === 'network')) return 'Serveur injoignable pour le moment.';
  return 'Ce lien ne peut pas s’afficher pour le moment.';
}

/** Adresse de base de l'application (sans le chemin /t/<code>). */
function appBase() {
  return location.origin + location.pathname.replace(/\/t\/[^/]*\/?$/, '/');
}

/** Ouvre la fiche dans l'application : rechargement pour repartir de la connexion normale (session et profil). */
export function openInApp(view) {
  const target = appBase() + M.ficheHash(view.type, view.tmdbId);
  try { history.replaceState(null, '', target); } catch { /* adresse inchangée */ }
  location.reload();
}

function card(view) {
  const art = h('article', 'pt-card', null, { 'aria-labelledby': 'pt-title' });
  const p = h('div', 'pt-poster');
  const src = posterSrc(view.poster);
  if (src) {
    const img = h('img', null, null, { alt: '', loading: 'eager' });
    img.src = src;
    img.addEventListener('error', () => { img.remove(); p.textContent = view.title; });
    p.append(img);
  } else {
    p.textContent = view.title;
  }
  const col = h('div', 'pt-col');
  const who = h('p', 'pt-who');
  who.append(avatarEl({ name: view.from.handle.name, avatarColor: view.from.avatarColor }, 28));
  who.append(h('span', null, view.from.handle.name + ' te recommande'));
  col.append(who);
  col.append(h('p', 'pt-kind', view.type === 'series' ? 'Série' : 'Film'));
  col.append(h('h1', 'pt-title', view.title, { id: 'pt-title', tabindex: '-1' }));
  const at = M.momentNote(view);
  if (at) col.append(h('p', 'pt-at', at));
  if (view.note) col.append(h('blockquote', 'pt-note', view.note));
  const btns = h('div', 'pt-btns');
  const open = h('button', 'btn btn-primary', 'Ouvrir dans Laststream', { type: 'button' });
  open.addEventListener('click', () => openInApp(view));
  btns.append(open);
  if (view.inviteCode) {
    const join = h('a', 'btn btn-ghost', 'Créer un compte avec l’invitation', { href: M.signupUrl(appBase(), view.inviteCode) });
    btns.append(join);
    col.append(btns, h('p', 'pt-hint', 'L’invitation ne sert qu’une fois : ' + view.from.handle.name + ' devient ton ami automatiquement.'));
  } else {
    col.append(btns);
  }
  art.append(p, col);
  return art;
}

export function showShareLink(code) {
  teardownFiche();
  state.kind = 'sharelink';
  const my = ++token;
  document.title = 'Recommandation · Laststream';
  detailEl.innerHTML = '';
  const page = h('div', 'pt-page');
  const brand = h('div', 'pt-brand');
  brand.append(h('span', 'pt-logo', 'Laststream'));
  const body = h('main', 'pt-body', null, { id: 'pt-body' });
  page.append(brand, body);
  detailEl.append(page);

  const load = () => {
    body.textContent = '';
    body.append(h('p', 'row-msg', 'Chargement de la recommandation…', { role: 'status' }));
    getShareLink(code).then((view) => {
      if (my !== token) return;
      body.textContent = '';
      body.append(card(view));
      document.title = view.title + ' · Laststream';
      const t = body.querySelector('#pt-title');
      if (t) t.focus({ preventScroll: true });
    }).catch((e) => {
      if (my !== token) return;
      body.textContent = '';
      const msg = h('div', 'pt-err', null, { role: 'alert' });
      msg.append(h('p', null, errorText(e)));
      if (!e || e.status !== 404) {
        const retry = h('button', 'btn btn-primary', 'Réessayer', { type: 'button' });
        retry.addEventListener('click', load);
        msg.append(retry);
      }
      body.append(msg);
    });
  };
  load();
}
