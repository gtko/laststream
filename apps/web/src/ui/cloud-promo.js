/* Encart « Laststream en ligne » sur l'accueil d'un serveur auto-hébergé (LAST-1657). De temps en temps seulement, toujours
 * fermable, jamais sur le service en ligne (abonnés compris), jamais sur un profil enfant ni en démo.
 *
 * Rythme (localStorage, par appareil) : rien les 3 premiers jours, puis l'encart s'affiche une journée, et revient au plus tôt
 * 10 jours plus tard avec un autre visuel. La croix l'écarte 30 jours ; « Ne plus afficher » l'arrête pour de bon. Aucun compteur
 * n'est envoyé : tout reste sur l'appareil. */
import { auth, isKidProfile, isServerMode } from '../data/auth';
import { getBase, isAndroidApp, isOfficialBase } from '../data/config';
import { demoState } from '../demoBoot';
import { connectShell, isShellEnvironment, openExternal } from '../player/shell';
import { esc } from './util.js';
import famille from '../assets/cloud-promo/famille.webp';
import sansServeur from '../assets/cloud-promo/sans-serveur.webp';
import pcEteint from '../assets/cloud-promo/pc-eteint.webp';
import '../styles/cloud-promo.css';

export const PROMO_KEY = 'ls.cloudPromo';
const OFFER_URL = 'https://www.laststream.app/#tarif';
const DAY = 24 * 60 * 60 * 1000;
export const FIRST_DELAY = 3 * DAY;
export const GAP = 10 * DAY;
export const SNOOZE = 30 * DAY;

export const VARIANTS = [
  {
    id: 'famille', img: famille,
    title: 'Toute la famille, sans rien installer.',
    text: 'Chacun son profil, sa liste et sa progression, sur la télé, le téléphone ou la tablette. Un seul abonnement couvre tout le foyer.',
  },
  {
    id: 'sans-serveur', img: sansServeur,
    title: 'Zéro tracas : ni serveur, ni NAS.',
    text: 'Plus de mises à jour à surveiller, de sauvegardes à faire ou de ports à ouvrir. On s’occupe des serveurs, tu profites de tes séries.',
  },
  {
    id: 'pc-eteint', img: pcEteint,
    title: 'Ton PC peut enfin dormir.',
    text: 'Plus besoin de laisser un ordinateur allumé jour et nuit pour regarder depuis le canapé. Laststream en ligne tourne pour toi.',
  },
];

/** Jour local « AAAA-MM-JJ » : l'encart reste le même toute la journée où il apparaît. */
const dayOf = (now) => {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/**
 * Décide l'affichage (fonction pure). `st` : état mémorisé ou null. Renvoie le nouvel état et la variante à montrer (ou null).
 * Une journée d'affichage terminée repousse le prochain passage de GAP et fait tourner le visuel.
 */
export function decide(st, now) {
  const s = st && typeof st === 'object' && Number.isFinite(st.next)
    ? { first: st.first, next: st.next, day: typeof st.day === 'string' ? st.day : null, idx: Number(st.idx) || 0, off: st.off === true }
    : { first: now, next: now + FIRST_DELAY, day: null, idx: 0, off: false };
  if (s.off) return { st: s, variant: null };
  const today = dayOf(now);
  if (s.day && s.day !== today) { s.next = now + GAP; s.idx += 1; s.day = null; }
  if (now < s.next) return { st: s, variant: null };
  s.day = today;
  return { st: s, variant: VARIANTS[s.idx % VARIANTS.length] };
}

/** Croix : l'encart s'écarte 30 jours, le visuel suivant viendra ensuite. */
export const snooze = (st, now) => ({ ...st, next: now + SNOOZE, day: null, idx: (Number(st.idx) || 0) + 1 });
/** « Ne plus afficher » : définitif sur cet appareil. */
export const stop = (st) => ({ ...st, off: true, day: null });

function read(storage) {
  try {
    const raw = storage ? storage.getItem(PROMO_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
function write(storage, st) {
  try { storage.setItem(PROMO_KEY, JSON.stringify(st)); } catch (_) { /* stockage indisponible : rien n'est retenu */ }
}

/** Serveur auto-hébergé, compte connecté, profil adulte, hors démo. Le service en ligne (abonnés compris) n'a jamais l'encart. */
function promoEligible() {
  if (demoState.flags.on || !isServerMode() || isKidProfile()) return false;
  if (auth.community) return false; // abonnement actif sur ce serveur : c'est le service en ligne
  return !isOfficialBase(getBase());
}

function promoHTML(v) {
  return '<aside class="cpromo" aria-labelledby="cpromo-t" data-cpromo="' + esc(v.id) + '">' +
    '<div class="cpromo-art"><img src="' + esc(v.img) + '" alt="" width="960" height="536" loading="lazy" decoding="async"></div>' +
    '<div class="cpromo-body">' +
      '<p class="cpromo-k">Laststream en ligne <span class="cpromo-tag">suggestion</span></p>' +
      '<h2 class="cpromo-title" id="cpromo-t">' + esc(v.title) + '</h2>' +
      '<p class="cpromo-text">' + esc(v.text) + '</p>' +
      '<ul class="cpromo-pts"><li>24 € par an, soit 2 € par mois</li><li>Tout le foyer</li><li>Résiliable quand tu veux</li></ul>' +
      '<div class="cpromo-actions">' +
        '<a class="btn btn-primary cpromo-go" href="' + OFFER_URL + '" target="_blank" rel="noopener" data-cpromo-go>Découvrir l’offre</a>' +
        '<button type="button" class="cpromo-never" data-cpromo-never>Ne plus afficher</button>' +
      '</div>' +
      '<p class="cpromo-note">Ton serveur continue de fonctionner comme aujourd’hui.</p>' +
    '</div>' +
    '<button type="button" class="cpromo-close" aria-label="Fermer la suggestion" data-cpromo-close>' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
    '</button></aside>';
}

/** Ouvre l'offre hors de l'app : navigateur du système dans les apps (Android, Tauri, coque), nouvel onglet sinon. */
function openOffer(e) {
  if (isAndroidApp()) { e.preventDefault(); window.open(OFFER_URL, '_system'); return; }
  if (!('__TAURI_INTERNALS__' in window) && isShellEnvironment()) {
    e.preventDefault();
    connectShell().then((t) => { if (t) openExternal(t, OFFER_URL); else window.open(OFFER_URL, '_blank', 'noopener'); }, () => window.open(OFFER_URL, '_blank', 'noopener'));
  }
}

/**
 * Remplit `#promo-slot` de l'accueil si c'est le moment. `deps` : horloge, stockage et éligibilité substituables en test.
 * Sans emplacement, sans éligibilité ou hors période : le slot reste vide.
 */
export function renderCloudPromo(deps = {}) {
  const slot = (deps.document || document).getElementById('promo-slot');
  if (!slot) return;
  const storage = deps.storage === undefined ? globalThis.localStorage : deps.storage;
  const now = deps.now ? deps.now() : Date.now();
  const eligible = deps.eligible ? deps.eligible() : promoEligible();
  if (!eligible) { slot.innerHTML = ''; return; }
  const { st, variant } = decide(read(storage), now);
  write(storage, st);
  if (!variant) { slot.innerHTML = ''; return; }
  // eslint-disable-next-line no-restricted-syntax -- gabarit local, textes constants échappés par esc
  slot.innerHTML = promoHTML(variant);
  const close = (next) => { write(storage, next); slot.innerHTML = ''; };
  slot.querySelector('[data-cpromo-close]').addEventListener('click', () => close(snooze(st, deps.now ? deps.now() : Date.now())));
  slot.querySelector('[data-cpromo-never]').addEventListener('click', () => close(stop(st)));
  slot.querySelector('[data-cpromo-go]').addEventListener('click', openOffer);
}
