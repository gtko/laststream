/* Réglages > Sources : catalogues d’un addon (ODY-252). L’interrupteur « Afficher les catalogues de cet addon » (désactivé par défaut)
 * inscrit l’addon dans le registre local (src/data/addonCatalog.ts) ; « Rangée à l’accueil » en fait une rangée d’accueil.
 * Le bloc n’apparaît que si le manifest déclare au moins un catalogue affichable. Aucune adresse d’addon n’est affichée ni journalisée. */
import { catalogDisplay, addonKeyOf, pruneAddonCatalogs, readAddonCatalogs, setAddonCatalog } from '../data/addonCatalog';
import { isDemo } from '../data/demo';
import { esc } from './util.js';

/** Avertissement permanent : une clé de débrideur dans l’adresse serait appelée depuis cet appareil. */
const WARNING = 'N’ajoute jamais ta clé de débrideur dans l’adresse d’un addon : elle serait appelée depuis cet appareil.';

/** Vrai si le manifest lu déclare au moins un catalogue affichable (accueil ou recherche, pas masqué). */
function hasShowable(manifestCatalogs) {
  return !!manifestCatalogs && Array.isArray(manifestCatalogs.catalogs) && manifestCatalogs.catalogs.some((c) => catalogDisplay(c) !== 'hidden');
}

/** Clé du registre pour une adresse de manifest (vide si invalide). */
const keyOf = (manifestUrl) => (manifestUrl ? addonKeyOf(manifestUrl) : '');

/** Entrée du registre pour un addon, à partir du manifest lu. */
function entryOf(manifestUrl, info, home) {
  const m = info.manifestCatalogs;
  return {
    manifestUrl,
    name: info.name || 'Addon',
    logo: info.logo || undefined,
    home,
    catalogs: m.catalogs,
    idPrefixes: m.idPrefixes,
    types: m.types,
    resources: m.resources,
    at: Date.now(),
  };
}

/** Entrée du registre pour un addon, ou undefined si l’addon n’est pas activé. */
function storedEntry(manifestUrl) {
  const key = keyOf(manifestUrl);
  return key ? readAddonCatalogs()[key] : undefined;
}

/** Bloc des catalogues, dans l’édition de la carte d’un addon. Vide et masqué si le manifest n’a aucun catalogue affichable. */
export function catalogBoxHTML(manifestUrl, info) {
  if (!manifestUrl || !info || !hasShowable(info.manifestCatalogs)) return '<div class="src-cats" hidden></div>';
  const entry = storedEntry(manifestUrl);
  const on = !!entry;
  return '<div class="src-cats">' +
    '<div class="set-row" data-nav><div class="set-row-t"><span class="set-row-l">Afficher les catalogues de cet addon</span>' +
    '<span class="set-row-d">Ses catalogues sont lus depuis cet appareil et s’affichent dans l’app.</span></div>' +
    '<div class="set-row-c"><button type="button" class="set-switch" role="switch" data-addon-cat aria-label="Afficher les catalogues de cet addon"' +
    ' aria-checked="' + (on ? 'true' : 'false') + '"' + (isDemo() ? ' disabled' : '') + '><span class="set-switch-k"></span></button></div></div>' +
    '<div class="src-cats-home"' + (on ? '' : ' hidden') + '><label class="src-toggle"><input type="checkbox" data-addon-cat-home' +
    (entry && entry.home ? ' checked' : '') + '> <span>Rangée à l’accueil</span></label>' +
    '<span class="set-hint">Une rangée par catalogue sur l’accueil.</span></div>' +
    '<p class="set-hint src-cats-warn">' + esc(WARNING) + '</p></div>';
}

/** Clic sur l’interrupteur : inscrit ou retire l’addon du registre, puis met le bloc à jour sur place (le focus reste sur l’interrupteur). */
export function toggleCatalogs(button, manifestUrl, info) {
  if (button.disabled || !manifestUrl) return;
  const on = button.getAttribute('aria-checked') !== 'true';
  if (!isDemo()) {
    if (!on) setAddonCatalog(keyOf(manifestUrl), null);
    else if (hasShowable(info && info.manifestCatalogs)) setAddonCatalog(keyOf(manifestUrl), entryOf(manifestUrl, info, false));
  }
  // L’affichage reprend ce qui est réellement enregistré (un stockage plein ne doit pas afficher « activé »).
  const stored = storedEntry(manifestUrl);
  button.setAttribute('aria-checked', stored ? 'true' : 'false');
  const box = button.closest('.src-cats');
  const row = box && box.querySelector('.src-cats-home');
  if (!row) return;
  row.hidden = !stored;
  const home = row.querySelector('[data-addon-cat-home]');
  if (home) home.checked = !!(stored && stored.home);
}

/** Case « Rangée à l’accueil » : enregistre home dans l’entrée existante. */
export function setCatalogHome(checkbox, manifestUrl) {
  const prev = storedEntry(manifestUrl);
  if (!prev || isDemo()) {
    checkbox.checked = false;
    return;
  }
  setAddonCatalog(keyOf(manifestUrl), { ...prev, home: checkbox.checked });
}

/** Relecture du manifest : une entrée existante reprend catalogues, nom et logo, et garde son choix « accueil ». Sans catalogue
 * affichable, elle est retirée. Pas de manifest lu (échec, repli sur le test serveur) : rien ne change. */
export function refreshCatalogs(manifestUrl, info) {
  if (!info || !info.manifestCatalogs || isDemo()) return;
  const prev = storedEntry(manifestUrl);
  if (!prev) return;
  setAddonCatalog(keyOf(manifestUrl), hasShowable(info.manifestCatalogs) ? entryOf(manifestUrl, info, prev.home) : null);
}

/** À l’enregistrement : retire du registre les addons absents des sources enregistrées (supprimés, ou adresse changée). */
export function pruneCatalogsFor(sources) {
  if (!Array.isArray(sources) || isDemo()) return;
  pruneAddonCatalogs(sources.filter((s) => s && typeof s.url === 'string' && s.url).map((s) => addonKeyOf(s.url)));
}
