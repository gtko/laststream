/* Port du prototype (voir tools/port-prototype.mjs). */
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { IMG } from './constants.js';
import { detailEl } from './dom.js';
import { state } from './state.js';
import { esc } from './util.js';

// ---------- Où regarder (TMDB / JustWatch, France) ----------
const providerPromises = new Map();
export function fetchProviders(type, id) {
  const key = type + ':' + id;
  if (!providerPromises.has(key)) {
    const p = tmdb(type + '/' + id + '/watch/providers').then((j) => {
      const fr = (j && j.results && j.results[getRegion().code]) || {};
      const map = (list) => (list || []).slice().sort((a, b) => (a.display_priority || 99) - (b.display_priority || 99))
        .filter((x) => x.logo_path).map((x) => ({ name: x.provider_name, logo: IMG('w92', x.logo_path) }));
      return {
        link: fr.link || '',
        flatrate: map(fr.flatrate),
        free: map((fr.free || []).concat(fr.ads || [])),
        rent: map(fr.rent),
        buy: map(fr.buy),
      };
    });
    p.catch(() => providerPromises.delete(key));
    providerPromises.set(key, p);
  }
  return providerPromises.get(key);
}

export function providersHTML(pr) {
  const groups = [['flatrate', 'Disponible sur :', 6], ['free', 'Gratuit', 4], ['rent', 'Location', 4], ['buy', 'Achat', 4]];
  const seen = new Set();
  const parts = [];
  groups.forEach(([k, label, max]) => {
    const list = pr[k].filter((x) => !seen.has(x.name)).slice(0, max);
    list.forEach((x) => seen.add(x.name));
    if (!list.length) return;
    parts.push('<div class="prov-g"><span class="prov-l">' + label + '</span><span class="prov-logos">' + list.map((x) =>
      '<img src="' + esc(x.logo) + '" alt="' + esc(x.name) + '" title="' + esc(x.name) + '" width="36" height="36" loading="lazy" decoding="async">').join('') + '</span></div>');
  });
  if (!parts.length) return '<p class="prov-none">Pas disponible en streaming ' + getRegion().where + '</p>';
  const inner = parts.join('');
  return pr.link
    ? '<a class="prov" href="' + esc(pr.link) + '" target="_blank" rel="noopener noreferrer" aria-label="Où regarder ' + getRegion().where + ' (ouvre TMDB / JustWatch dans un nouvel onglet)">' + inner + '</a>'
    : '<div class="prov">' + inner + '</div>';
}

export async function fillProviders(m, token) {
  const slot = detailEl.querySelector('#f-prov');
  if (!slot) return;
  try {
    const pr = await fetchProviders(m.type, m.id);
    if (token !== state.token) return;
    slot.innerHTML = providersHTML(pr);
  } catch (_) { /* section masquée */ }
}
