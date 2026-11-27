/* Réglages > Lecture > Stockage (ODY-204) : espace utilisé, limite d'espace, Wi-Fi seulement, qualité et langue mémorisées,
 * stockage persistant (web) et suppression de tous les téléchargements. Les gestes sont délégués sur #detail (page Réglages). */
import { getDownloads, getSpace, persistStorage, platformAvailability } from '../downloads/service';
import { getDeleteAfterWatch, getDownloadSettings, LIMIT_CHOICES, setDeleteAfterWatch, setDownloadSettings } from '../downloads/settings';
import { formatBytes, gauge } from '../downloads/viewModel';
import { LANG_CHOICES } from '../data/langPrefs';
import { isAndroidApp } from '../data/config';
import { isShellEnvironment } from '../player/shell';
import { DL_ICON, openSheet } from './downloadBtn.js';
import { detailEl, toast } from './dom.js';
import { card, fieldRow, rowHTML, switchRow } from './settings-ui.js';
import { esc } from './util.js';
import { t as tr } from '../i18n';

const QUALITIES = [['', tr('Recommandée')], ['2160p', '4K'], ['1440p', '2K'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']];
const limitLabel = (b) => (b == null ? tr('Sans limite') : formatBytes(b));
const isWeb = () => !isAndroidApp() && !isShellEnvironment();

let wantFocus = false;
/** « Réglages de stockage » (écran Téléchargements) : la carte est amenée à l'écran à l'ouverture des réglages. */
export const focusStorageSettings = () => { wantFocus = true; };

/** Carte « Stockage » du panneau Lecture ; vide si l'appareil ne télécharge pas. */
export function downloadsStorageCard() {
  const av = platformAvailability();
  if (!av.ok) return card(tr('Stockage'), '<p class="set-hint">' + esc(av.reason) + '</p>', { attrs: 'id="set-dl" tabindex="-1"' });
  const s = getDownloadSettings();
  const seg = '<div class="dl-seg" role="group" aria-label="' + tr('Limite d’espace') + '" data-nav>' + LIMIT_CHOICES.map((b, i) =>
    '<button type="button" data-dl-limit="' + i + '" aria-pressed="' + (s.limitBytes === b) + '">' + esc(limitLabel(b)) + '</button>').join('') + '</div>';
  const langs = [['', tr('Selon mes réglages audio')]].concat(LANG_CHOICES);
  const curLang = (s.langs && s.langs[0]) || '';
  queueMicrotask(fillSpace);
  return card(tr('Stockage'),
    '<div class="set-row is-stack" data-nav><div class="set-row-t"><span class="set-row-l">' + tr('Espace utilisé') + '</span><span class="set-row-d" data-dl-set-space>…</span></div>' +
    '<div class="set-row-c"><div class="dl-bar dl-bar-lg" role="progressbar" aria-label="' + tr('Espace utilisé') + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-dl-set-bar><i style="width:0%"></i></div></div></div>' +
    rowHTML(tr('Limite d’espace'), tr('Au-delà, les téléchargements s’arrêtent. Avertissement à 90 %.'), () => seg, { stack: true }) +
    switchRow(tr('Télécharger en Wi-Fi seulement'), tr('Pas de téléchargement sur une connexion mobile.'), s.wifiOnly, 'data-set-pref="dl-wifi"') +
    switchRow(tr('Supprimer après visionnage'), tr('Libère l’espace dès qu’un titre est terminé.'), getDeleteAfterWatch(), 'data-set-pref="dl-after"') +
    fieldRow(tr('Qualité par défaut'), tr('Utilisée pour les prochains téléchargements.'), (id) => '<select class="set-input" id="' + id + '" data-dl-pref="quality">' +
      QUALITIES.map(([v, l]) => '<option value="' + v + '"' + ((s.quality || '') === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>') +
    fieldRow(tr('Langue par défaut'), tr('Langue audio cherchée en priorité.'), (id) => '<select class="set-input" id="' + id + '" data-dl-pref="langs">' +
      langs.map(([v, l]) => '<option value="' + esc(v) + '"' + (curLang === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>') +
    rowHTML(tr('Choix au premier téléchargement'), tr('Affiche à nouveau le choix de qualité et de langues.'), () => '<button type="button" class="btn btn-ghost btn-sm" data-dl-ask>' + tr('Redemander') + '</button>') +
    (isWeb() ? rowHTML(tr('Stockage persistant'), tr('Évite que le navigateur efface les vidéos quand l’espace manque. Safari et iOS peuvent supprimer les fichiers après 7 jours sans visite.'),
      () => '<button type="button" class="btn btn-ghost btn-sm" data-dl-persist>' + tr('Activer') + '</button>') : '') +
    rowHTML(tr('Tous les téléchargements'), '', () => '<button type="button" class="btn btn-sm dl-btn-d" data-dl-purge>' + DL_ICON.trash + '<span>' + tr('Tout supprimer') + '</span></button>'),
    { attrs: 'id="set-dl" tabindex="-1"', desc: tr('Téléchargements hors ligne de cet appareil.') });
}

async function fillSpace() {
  const box = detailEl.querySelector('#set-dl');
  if (!box) return;
  if (wantFocus) {
    wantFocus = false;
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'start' });
    box.focus({ preventScroll: true });
  }
  const s = await getSpace();
  const t = box.querySelector('[data-dl-set-space]');
  const bar = box.querySelector('[data-dl-set-bar]');
  if (!t || !bar) return;
  if (!s) { t.textContent = tr('Aucun téléchargement pour l’instant.'); return; }
  const g = gauge(s);
  t.textContent = g.label;
  bar.setAttribute('aria-valuenow', String(g.percent));
  bar.firstElementChild.style.width = g.percent + '%';
  bar.classList.toggle('is-warn', g.level === 'warn');
  bar.classList.toggle('is-full', g.level === 'full');
}

/** Interrupteurs de la carte (settings.js les bascule puis appelle ceci). */
export function applyDownloadToggle(pref, on) {
  if (pref === 'dl-wifi') setDownloadSettings({ wifiOnly: on });
  else if (pref === 'dl-after') setDeleteAfterWatch(on);
}

detailEl.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target.closest('[data-dl-limit], [data-dl-ask], [data-dl-persist], [data-dl-purge]') : null;
  if (!t || !t.closest('#set-dl')) return;
  e.preventDefault();
  if (t.dataset.dlLimit != null) {
    const b = LIMIT_CHOICES[Number(t.dataset.dlLimit)];
    setDownloadSettings({ limitBytes: b });
    t.parentElement.querySelectorAll('[data-dl-limit]').forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
    toast(tr('Limite d’espace : {b}', { b: limitLabel(b) }));
    void fillSpace();
  } else if (t.hasAttribute('data-dl-ask')) {
    setDownloadSettings({ asked: false });
    toast(tr('Le choix sera proposé au prochain téléchargement'));
  } else if (t.hasAttribute('data-dl-persist')) {
    toast((await persistStorage()) ? tr('Stockage persistant activé') : tr('Le navigateur a refusé le stockage persistant'));
  } else {
    openSheet({
      title: tr('Supprimer tous les téléchargements ?'),
      cls: 'is-center',
      opener: t,
      render: (body, close) => {
        body.innerHTML = '<p class="dl-sheet-p">' + tr('Tous les fichiers téléchargés sur cet appareil seront effacés.') + '</p><div class="dl-sheet-acts">' +
          '<button type="button" class="btn dl-btn-d" data-dl-yes>' + tr('Tout supprimer') + '</button><button type="button" class="btn btn-ghost" data-dl-close>' + tr('Annuler') + '</button></div>';
        body.querySelector('[data-dl-yes]').addEventListener('click', async () => {
          close();
          const m = await getDownloads();
          if (m) await Promise.all(m.list().map((it) => m.remove(it.id).catch(() => undefined)));
          toast(tr('Téléchargements supprimés'));
          void fillSpace();
        });
      },
    });
  }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLSelectElement) || !t.dataset.dlPref) return;
  if (t.dataset.dlPref === 'quality') setDownloadSettings({ quality: t.value || undefined });
  else setDownloadSettings({ langs: t.value ? [t.value] : [] });
});
