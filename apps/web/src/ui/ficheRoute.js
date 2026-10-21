/* Adresse d'une fiche, avec ou sans épisode visé : #/tv/<id> ou #/tv/<id>/s<saison>e<épisode>. */

const FICHE = /^#\/(movie|tv)\/(\d{1,9})(?:\/s(\d{1,3})e(\d{1,4}))?$/;

/** Route d'une fiche : { type, id } et, pour une série avec épisode visé, { season, episode }. Null si ce n'est pas une fiche. */
export function parseFicheHash(h) {
  const r = FICHE.exec(h || '');
  if (!r) return null;
  const out = { type: r[1], id: r[2] };
  if (r[1] === 'tv' && r[3] != null) {
    out.season = Number(r[3]);
    out.episode = Number(r[4]);
  }
  return out;
}

/** Adresse d'une fiche ; la saison et l'épisode ne sont ajoutés que pour une série et s'ils sont valides. */
export function ficheHash(type, id, ep) {
  const base = '#/' + type + '/' + id;
  const s = ep && Number(ep.season);
  const e = ep && Number(ep.episode);
  return type === 'tv' && Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > 0 ? base + '/s' + s + 'e' + e : base;
}
