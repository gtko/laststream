/* Rapport d'import (réussis, ignorés, échoués et pourquoi) et journal de l'import des addons, pour la carte de migration.
 * HTML seulement : les actions (copier, télécharger) sont branchées par migration.js. Aucune adresse d'addon n'est affichée. */
import { ACTION_LABEL } from '../data/migration/types';
import { esc } from './util.js';

const n = (v, one, many) => v + ' ' + (v > 1 ? many : one);

/** Résumé chiffré et détail des éléments ignorés ou échoués, regroupés par raison. */
export function reportHTML(rep) {
  const parts = Object.entries(rep.byAction).filter(([, v]) => v > 0).map(([k, v]) => esc(ACTION_LABEL[k]) + ' : ' + v);
  const groups = new Map();
  for (const p of rep.problems) {
    const k = p.status + '|' + (p.reason || 'Raison inconnue');
    if (!groups.has(k)) groups.set(k, { status: p.status, reason: p.reason || 'Raison inconnue', titles: [] });
    groups.get(k).titles.push(p.title);
  }
  const detail = [...groups.values()].sort((a, b) => (a.status === b.status ? b.titles.length - a.titles.length : a.status === 'failed' ? -1 : 1)).map((g) =>
    '<li class="mg-pb" data-status="' + g.status + '"><p class="mg-pb-r"><span class="mg-tag" data-status="' + g.status + '">' + (g.status === 'failed' ? 'Échec' : 'Ignoré') + '</span>' +
    esc(g.reason) + ' <span class="mg-pb-n">(' + g.titles.length + ')</span></p><p class="mg-pb-t">' + g.titles.slice(0, 40).map(esc).join(' · ') +
    (g.titles.length > 40 ? ' · et ' + (g.titles.length - 40) + ' autres' : '') + '</p></li>').join('');
  return '<div class="mg-stats" role="list">' +
    '<p class="mg-stat" role="listitem" data-k="ok"><b>' + rep.ok + '</b><span>' + (rep.ok > 1 ? 'réussis' : 'réussi') + '</span></p>' +
    '<p class="mg-stat" role="listitem" data-k="skipped"><b>' + rep.skipped + '</b><span>' + (rep.skipped > 1 ? 'ignorés' : 'ignoré') + '</span></p>' +
    '<p class="mg-stat" role="listitem" data-k="failed"><b>' + rep.failed + '</b><span>' + (rep.failed > 1 ? 'échoués' : 'échoué') + '</span></p></div>' +
    (parts.length ? '<p class="set-hint">' + parts.join(' · ') + '</p>' : '') +
    (detail ? '<details class="mg-details"' + (rep.failed ? ' open' : '') + '><summary>Pourquoi ' + n(rep.problems.length, 'élément n’a', 'éléments n’ont') + ' pas été importé' + (rep.problems.length > 1 ? 's' : '') + '</summary><ul class="mg-pbs">' + detail + '</ul></details>' : '');
}

const OUTCOME = { added: 'Ajouté', ignored: 'Ignoré', failed: 'Échec' };

/** Journal de l'import des addons : une ligne par addon, issue et raison en clair. */
export function addonLogHTML(log) {
  if (!log || !log.length) return '';
  const added = log.filter((l) => l.outcome === 'added').length;
  return '<section class="mg-alog" aria-labelledby="mg-alog-t"><h4 class="mg-sub" id="mg-alog-t">Journal des addons · ' + n(added, 'ajouté', 'ajoutés') + ' sur ' + log.length + '</h4><ul class="mg-alog-l">' +
    log.map((l) => '<li><span class="mg-tag" data-status="' + (l.outcome === 'added' ? 'ok' : l.outcome === 'failed' ? 'failed' : 'skipped') + '">' + OUTCOME[l.outcome] + '</span>' +
      '<span class="mg-alog-n">' + esc(l.name) + '</span><span class="mg-alog-r">' + esc(l.reason) + '</span></li>').join('') + '</ul></section>';
}

/** Addons importés sur cet appareil : affichage à l'accueil et retrait. */
export function importedAddonsHTML(entries) {
  if (!entries.length) return '';
  return '<section class="mg-imp" aria-labelledby="mg-imp-t"><h4 class="mg-sub" id="mg-imp-t">Addons importés sur cet appareil</h4><ul class="mg-imp-l">' +
    entries.map(([key, e]) => '<li><span class="mg-alog-n">' + esc(e.name) + '</span>' +
      '<label class="mg-chk"><input type="checkbox" data-mg-addon-home="' + esc(key) + '"' + (e.home ? ' checked' : '') + '> Rangée à l’accueil</label>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-mg-addon-remove="' + esc(key) + '">Retirer</button></li>').join('') + '</ul></section>';
}
