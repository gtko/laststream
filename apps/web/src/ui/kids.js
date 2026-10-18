/* Accueil et navigation du profil enfant : rangées TMDB (certification + genres jeunesse), héros sûr, pages « Tout voir ». */
import { kidMaxAge, kidSection } from '../data/auth';
import { kidAllows } from '../data/kid';
import { getRegion } from '../data/prefs';
import { makeCtx, rowById } from '../data/rows';
import { userStore } from '../data/userStore';
import { getDetail } from './catalog.js';
import { heroA } from './hero.js';
import { resolveRow } from './registry.js';
import { avatarStyle, continueSection, initialOf } from './home.js';
import { brand } from './fragments.js';
import { ICON } from './icons.js';
import { esc } from './util.js';

/** Héros : premier titre jeunesse autorisé qui a une bande-annonce. */
async function pickKidHero(pool) {
  const cands = pool.filter((it, i) => it.backdropPath && pool.findIndex((x) => x.key === it.key) === i).slice(0, 10);
  const details = await Promise.all(cands.map((it) => getDetail(it)));
  const i = cands.findIndex((_, n) => details[n] && kidAllows(details[n].cert, kidMaxAge()) && details[n].trailer);
  return i >= 0 ? cands[i] : null;
}

export async function loadKidsHome() {
  const ctx = makeCtx(getRegion().code, kidMaxAge());
  const ids = ['famille', 'dessins', 'nouveautes'].filter((id) => kidSection(rowById(id).section));
  const settled = await Promise.allSettled(ids.map((id) => resolveRow(rowById(id), 1, ctx)));
  if (ids.length && settled.every((s) => s.status === 'rejected')) throw new Error('catalogue indisponible');
  const pool = [];
  settled.forEach((s) => { if (s.status === 'fulfilled' && s.value) s.value.items.slice(0, 4).forEach((it) => pool.push(it)); });
  const hero = await pickKidHero(pool);
  return { kids: true, hero, rows: {} };
}

// ---------- Vue ----------
export function headerKids() {
  const name = userStore.currentProfile().name;
  const links = [['dessins', 'Dessins animés'], ['famille', 'Films'], ['jeunesse-series', 'Séries']].filter(([id]) => kidSection(id === 'jeunesse-series' ? 'series' : id))
    .map(([id, label]) => '<a href="#' + id + '" data-scroll="' + id + '">' + label + '</a>').join('');
  return '<header class="topbar">' + brand() + '<nav class="nav" aria-label="Principale">' +
    '<a href="#/" data-noop class="is-current" aria-current="page">Accueil</a>' + links +
    (kidSection('tv') ? '<a href="#/tv-live" data-tvlive>TV jeunesse</a>' : '') +
    '<a href="#/library" data-libnav>Mes favoris</a></nav>' +
    '<div class="top-actions"><button type="button" class="icon-btn" data-search aria-label="Rechercher">' + ICON.search + '</button>' +
    '<button type="button" class="avatar" data-settings' + avatarStyle() + ' aria-label="Profil ' + esc(name) + ', changer de profil">' + esc(initialOf()) + '</button></div></header>';
}

export function viewKids(d) {
  const name = userStore.currentProfile().name;
  return '<main id="main" class="page-a page-kids">' + headerKids() + heroA(d.hero, 'Pour toi, ' + name) +
    '<div class="rows"><h1 class="kid-hello">Salut ' + esc(name) + ' !</h1>' +
    '<div id="cont-slot">' + continueSection() + '</div>' + '<div id="lib-slot"></div>' +
    '<div id="reg-slot"></div><div id="live-slot"></div></div></main>';
}
