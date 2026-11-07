/* Port du prototype (voir tools/port-prototype.mjs). */
import { certLabel } from './catalog.js';
import { esc, fmtNum } from './util.js';

// ---------- Notes : puces avec icône et couleur de chaque source (SVG/CSS en ligne) ----------
const NB = ' ';
const pct = (v) => Math.round(v) + NB + '%';
const SVG = (inner, cls) => '<svg class="ri ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
const RICON = {
  imdb: () => '<span class="rb rb-imdb" aria-hidden="true">IMDb</span>',
  tomato: (v) => (v >= 60
    ? SVG('<circle cx="12" cy="14" r="8.6" fill="#FA320A"/><path d="M12 7.2c-.9-2.3-3.1-3-4.9-2 1.2.2 2 .9 2.4 1.9-1.5-.5-3.1-.1-4 1 2.2.4 3.6.2 4.5-.6.5.9 1.1 1 2 1zM12 7.2c.9-2.3 3.1-3 4.9-2-1.2.2-2 .9-2.4 1.9 1.5-.5 3.1-.1 4 1-2.2.4-3.6.2-4.5-.6z" fill="#0AC855"/>')
    : SVG('<path fill="#0AC855" d="M12 2.5c1.6 0 2.1 2.1 3.3 2.8 1.5.8 4-.2 4.6 1.5.6 1.6-1.5 2.8-1.5 4.4s2.3 3.1 1.3 4.6c-1 1.5-3.5.3-4.6 1.4-1.1 1.1-.5 3.7-2.3 4.1-1.7.4-2.6-1.8-4.2-2.3-1.6-.5-4 .8-4.9-.8-.8-1.6 1.2-3.1 1.1-4.7-.1-1.6-2.3-2.7-1.5-4.2.8-1.5 3.2-.5 4.5-1.5 1.2-.9 1-3.4 3.2-4.3z"/>')),
  popcorn: (v) => (v >= 60
    ? SVG('<circle cx="8" cy="8.5" r="2.8" fill="#FFF1C9"/><circle cx="12" cy="6.5" r="3.2" fill="#FFE8A3"/><circle cx="16" cy="8.5" r="2.8" fill="#FFF1C9"/><path d="M5.5 10h13l-1.6 11.5H7.1z" fill="#FA320A"/><path d="M10 10l.5 11.5M14 10l-.5 11.5" stroke="#fff" stroke-width="1.3"/>')
    : SVG('<g transform="rotate(-32 12 14)"><path d="M5.5 10h13l-1.6 11.5H7.1z" fill="#0AC855"/><path d="M10 10l.5 11.5M14 10l-.5 11.5" stroke="#0c0b11" stroke-opacity=".35" stroke-width="1.3"/></g><circle cx="19" cy="18.5" r="1.6" fill="#B8F5CF"/><circle cx="16.5" cy="21" r="1.3" fill="#B8F5CF"/>')),
  letterboxd: () => SVG('<circle cx="6.5" cy="12" r="5.5" fill="#FF8000"/><circle cx="17.5" cy="12" r="5.5" fill="#40BCF4"/><circle cx="12" cy="12" r="5.5" fill="#00E054"/><path d="M12 7.6a5.5 5.5 0 0 1 0 8.8 5.5 5.5 0 0 1 0-8.8z" fill="#fff" fill-opacity=".92"/>', 'ri-wide'),
  tmdb: () => '<span class="rb rb-tmdb" aria-hidden="true">TMDB</span>',
  trakt: () => SVG('<circle cx="12" cy="12" r="10.5" fill="#ED1C24"/><path d="M7.2 12.2l3.1 3.1 6.5-6.5M10.3 15.3L7 12M12.9 8.4l-3 3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
};

function rateChip(label, icon, score) {
  return '<li class="rate" title="' + esc(label) + '"><span class="sr-only">' + esc(label) + ' : </span>' + icon +
    (score ? '<strong>' + score + '</strong>' : '') + '</li>';
}

export function ratingList(r, fallbackTmdb) {
  r = r || {};
  const out = [];
  if (r.imdb != null) out.push(rateChip('IMDb', RICON.imdb(), fmtNum(r.imdb, 1)));
  if (r.rottentomatoes != null) out.push(rateChip('Rotten Tomatoes, critiques' + (r.rottentomatoes >= 60 ? ' (frais)' : ' (pourri)'), RICON.tomato(r.rottentomatoes), pct(r.rottentomatoes)));
  if (r.rottentomatoes_audience != null) out.push(rateChip('Rotten Tomatoes, public', RICON.popcorn(r.rottentomatoes_audience), pct(r.rottentomatoes_audience)));
  if (r.metacritic != null) {
    const v = Math.round(r.metacritic);
    out.push(rateChip('Metacritic', '<span class="rb-mc ' + (v >= 61 ? 'mc-g' : v >= 40 ? 'mc-y' : 'mc-r') + '" aria-hidden="true">' + v + '</span>', ''));
  }
  if (r.letterboxd != null) out.push(rateChip('Letterboxd', RICON.letterboxd(), fmtNum(r.letterboxd, 1)));
  const tm = r.tmdb != null ? r.tmdb : fallbackTmdb;
  if (tm) out.push(rateChip('TMDB', RICON.tmdb(), pct(tm)));
  if (r.trakt != null) out.push(rateChip('Trakt', RICON.trakt(), pct(r.trakt)));
  return out.join('');
}

export function metaHTML(it, d) {
  const out = [];
  if (it.year) out.push('<li>' + esc(it.year) + '</li>');
  if (d.genres.length) out.push('<li>' + esc(d.genres.slice(0, 3).join(' · ')) + '</li>');
  if (d.runtime) out.push('<li>' + esc(d.runtime) + '</li>');
  if (d.cert) out.push('<li class="cert">' + esc(certLabel(d.cert)) + '</li>');
  return out.join('');
}
export function compactRates(r, fallback) {
  r = r || {};
  const out = [];
  if (r.imdb != null) out.push(rateChip('IMDb', RICON.imdb(), fmtNum(r.imdb, 1)));
  if (r.rottentomatoes != null) out.push(rateChip('Rotten Tomatoes', RICON.tomato(r.rottentomatoes), pct(r.rottentomatoes)));
  if (!out.length && fallback) out.push(rateChip('TMDB', RICON.tmdb(), pct(fallback)));
  return out.join('');
}
