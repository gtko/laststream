/* Réglages > Lecture > Stockage (ODY-204) : espace utilisé, limite d'espace, Wi-Fi seulement, qualité et langue mémorisées,
 * stockage persistant (web) et suppression de tous les téléchargements. Les gestes sont délégués sur #detail (page Réglages). */
import { getDownloads, getSpace, persistStorage, platformAvailability } from '../downloads/service';
import { getDownloadSettings, LIMIT_CHOICES, setDownloadSettings } from '../downloads/settings';
import { formatBytes, gauge } from '../downloads/viewModel';
import { LANG_CHOICES } from '../data/langPrefs';
import { isAndroidApp } from '../data/config';
import { isShellEnvironment } from '../player/shell';
import { DL_ICON, openSheet } from './downloadBtn.js';
import { detailEl, toast } from './dom.js';
import { card, fieldRow, rowHTML, switchRow } from './settings-ui.js';
import { esc } from './util.js';

const QUALITIES = [['', 'Recommandée'], ['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']];
const limitLabel = (b) => (b == null ? 'Sans limite' : formatBytes(b));
const isWeb = () => !isAndroidApp() && !isShellEnvironment();

let wantFocus = false;
/** « Réglages de stockage » (écran Téléchargements) : la carte est amenée à l'écran à l'ouverture des réglages. */
export const focusStorageSettings = () => { wantFocus = true; };

/** Carte « Stockage » du panneau Lecture ; vide si l'appareil ne télécharge pas. */
export function downloadsStorageCard() {
  const av = platformAvailability();
  if (!av.ok) return card('Stockage', '<p class="set-hint">' + esc(av.reason) + '</p>', { attrs: 'id="set-dl" tabindex="-1"' });
  const s = getDownloadSettings();
  const seg = '<div class="dl-seg" role="group" aria-label="Limite d’espace" data-nav>' + LIMIT_CHOICES.map((b, i) =>
    '<button type="button" data-dl-limit="' + i + '" aria-pressed="' + (s.limitBytes === b) + '">' + esc(limitLabel(b)) + '</button>').join('') + '</div>';
  const langs = [['', 'Selon mes réglages audio']].concat(LANG_CHOICES);
  const curLang = (s.langs && s.langs[0]) || '';
  queueMicrotask(fillSpace);
  return card('Stockage',
    '<div class="set-row is-stack" data-nav><div class="set-row-t"><span class="set-row-l">Espace utilisé</span><span class="set-row-d" data-dl-set-space>…</span></div>' +
    '<div class="set-row-c"><div class="dl-bar dl-bar-lg" role="progressbar" aria-label="Espace utilisé" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-dl-set-bar><i style="width:0%"></i></div></div></div>' +
    rowHTML('Limite d’espace', 'Au-delà, les téléchargements s’arrêtent. Avertissement à 90 %.', () => seg, { stack: true }) +
    switchRow('Télécharger en Wi-Fi seulement', 'Pas de téléchargement sur une connexion mobile.', s.wifiOnly, 'data-set-pref="dl-wifi"') +
    fieldRow('Qualité par défaut', 'Utilisée pour les prochains téléchargements.', (id) => '<select class="set-input" id="' + id + '" data-dl-pref="quality">' +
      QUALITIES.map(([v, l]) => '<option value="' + v + '"' + ((s.quality || '') === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>') +
    fieldRow('Langue par défaut', 'Langue audio cherchée en priorité.', (id) => '<select class="set-input" id="' + id + '" data-dl-pref="langs">' +
      langs.map(([v, l]) => '<option value="' + esc(v) + '"' + (curLang === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>') +
    rowHTML('Choix au premier téléchargement', 'Affiche à nouveau le choix de qualité et de langues.', () => '<button type="button" class="btn btn-ghost btn-sm" data-dl-ask>Redemander</button>') +
    (isWeb() ? rowHTML('Stockage persistant', 'Évite que le navigateur efface les vidéos quand l’espace manque. Safari et iOS peuvent supprimer les fichiers après 7 jours sans visite.',
      () => '<button type="button" class="btn btn-ghost btn-sm" data-dl-persist>Activer</button>') : '') +
    rowHTML('Tous les téléchargements', '', () => '<button type="button" class="btn btn-sm dl-btn-d" data-dl-purge>' + DL_ICON.trash + '<span>Tout supprimer</span></button>'),
    { attrs: 'id="set-dl" tabindex="-1"', desc: 'Téléchargements hors ligne de cet appareil.' });
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
  if (!s) { t.textContent = 'Aucun téléchargement pour l’instant.'; return; }
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
}

detailEl.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target.closest('[data-dl-limit], [data-dl-ask], [data-dl-persist], [data-dl-purge]') : null;
  if (!t || !t.closest('#set-dl')) return;
  e.preventDefault();
  if (t.dataset.dlLimit != null) {
    const b = LIMIT_CHOICES[Number(t.dataset.dlLimit)];
    setDownloadSettings({ limitBytes: b });
    t.parentElement.querySelectorAll('[data-dl-limit]').forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
    toast('Limite d’espace : ' + limitLabel(b));
    void fillSpace();
  } else if (t.hasAttribute('data-dl-ask')) {
    setDownloadSettings({ asked: false });
    toast('Le choix sera proposé au prochain téléchargement');
  } else if (t.hasAttribute('data-dl-persist')) {
    toast((await persistStorage()) ? 'Stockage persistant activé' : 'Le navigateur a refusé le stockage persistant');
  } else {
    openSheet({
      title: 'Supprimer tous les téléchargements ?',
      cls: 'is-center',
      opener: t,
      render: (body, close) => {
        body.innerHTML = '<p class="dl-sheet-p">Tous les fichiers téléchargés sur cet appareil seront effacés.</p><div class="dl-sheet-acts">' +
          '<button type="button" class="btn dl-btn-d" data-dl-yes>Tout supprimer</button><button type="button" class="btn btn-ghost" data-dl-close>Annuler</button></div>';
        body.querySelector('[data-dl-yes]').addEventListener('click', async () => {
          close();
          const m = await getDownloads();
          if (m) await Promise.all(m.list().map((it) => m.remove(it.id).catch(() => undefined)));
          toast('Téléchargements supprimés');
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
