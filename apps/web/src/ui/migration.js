/* Carte « Importer depuis une autre app » (Réglages > Compte) : Stremio (compte ou fichier d'export), Nuvio, Simkl, Plex.
 * Étapes : choix de la source, avertissement (Stremio), lecture sur l'appareil, aperçu avec choix de ce qui est importé
 * (jamais « tout » en silence), import élément par élément avec reprise après coupure, rapport détaillé. L'import des addons
 * est une étape séparée, désactivée par défaut et absente des versions de store ; ses adresses restent sur l'appareil.
 * Les identifiants Stremio vont de l'appareil à Stremio seulement ; le jeton Plex reste en mémoire. Rien n'est journalisé. */
import '../styles/migration.css';
import { refreshRemote } from '../data/auth';
import { emitDataEvent } from '../data/events';
import { setAddonCatalog, readAddonCatalogs } from '../data/addonCatalog';
import { addonImportAvailable, importAddons, importedAddons } from '../data/migration/addons';
import { parseNuvioBackup } from '../data/migration/nuvio';
import { checkPlexPin, createPlexPin, listPlexServers, PlexError, readPlexHistory } from '../data/migration/plex';
import { createResolver, createVideoLister } from '../data/migration/resolve';
import { clearJob, createJob, loadJob, reportOf, reportText, runJob } from '../data/migration/runner';
import { parseSimklExport } from '../data/migration/simkl';
import { activeSink } from '../data/migration/sink';
import { parseStremioExport, readStremioAccount, StremioError } from '../data/migration/stremio';
import { SOURCE_LABEL } from '../data/migration/types';
import { userStore } from '../data/userStore';
import { addonLogHTML, importedAddonsHTML, reportHTML } from './migrationReport.js';
import { fieldRow } from './settings-ui.js';
import { detailEl, toast } from './dom.js';
import { esc } from './util.js';

const OPEN_KEY = 'ls_migration_open';
/** Page publique du programme bêta des migrants (site laststream.app). */
export const BETA_URL = 'https://laststream.app/beta-migrants/';
const PLEX_POLL_MS = 2000;
const PLEX_WAIT_MS = 5 * 60_000;

const SOURCES = [
  { id: 'stremio', label: 'Compte Stremio', hint: 'Bibliothèque, vus et progression, lus depuis cet appareil.' },
  { id: 'stremio-file', label: 'Fichier d’export Stremio', hint: 'Sans connexion : le fichier est lu sur cet appareil.' },
  { id: 'nuvio', label: 'Sauvegarde Nuvio', hint: 'Bibliothèque et positions de lecture.' },
  { id: 'simkl', label: 'Export Simkl', hint: 'Films, séries et animes (JSON ou CSV).' },
  { id: 'plex', label: 'Serveur Plex', hint: 'Titres vus et leurs dates, après ton autorisation.' },
];

/** Catégories de l'aperçu, cochées par défaut. */
const CATS = [
  { id: 'library', label: 'Bibliothèque', test: (i) => i.action === 'library' },
  { id: 'watchlist', label: 'Liste « À voir »', test: (i) => i.action === 'list' && i.list === 'watchlist' },
  { id: 'favorites', label: 'Favoris', test: (i) => i.action === 'list' && i.list === 'favorites' },
  { id: 'watched', label: 'Vus', test: (i) => i.action === 'watched' },
  { id: 'progress', label: 'Progression de lecture', test: (i) => i.action === 'progress' },
];

/** État de la carte : survit aux re-rendus de la page Réglages et aux navigations. */
const ui = {
  phase: 'choose',
  source: '',
  error: '',
  step: '',
  bundle: null,
  cats: new Set(CATS.map((c) => c.id)),
  addonsOn: false,
  addonsPicked: new Set(),
  readAddons: false,
  job: null,
  addonLog: null,
  plex: null,
  abort: null,
  busy: false,
};

const profileId = () => { try { return userStore.currentProfile().id || 'local'; } catch { return 'local'; } };
const isOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const card = () => detailEl.querySelector('#mg-card');

function restoreJob() {
  if (ui.job || ui.busy) return;
  const j = loadJob(profileId());
  if (!j) return;
  ui.job = j;
  if (j.status !== 'done') { j.status = 'paused'; j.pausedReason = j.pausedReason || 'Import interrompu : il reprendra là où il s’est arrêté.'; }
}

function summary() {
  restoreJob();
  const j = ui.job;
  if (ui.busy) return 'Import en cours…';
  if (j && j.status === 'paused') return 'Import ' + SOURCE_LABEL[j.source] + ' en pause';
  if (j && j.finishedAt) return 'Dernier import : ' + SOURCE_LABEL[j.source] + ', le ' + new Date(j.finishedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return 'Stremio, Nuvio, Simkl, Plex';
}

const CHEV = '<svg class="si-chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

const note = (title, lines) => '<div class="si-priv"><span class="si-lock">' + LOCK + '</span><div><p class="si-priv-t">' + esc(title) + '</p><ul>' + lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div></div>';
const alertHTML = () => '<div class="si-alert" id="mg-alert" role="alert"' + (ui.error ? '' : ' hidden') + '>' + esc(ui.error) + '</div>';
const back = (label = 'Retour') => '<button type="button" class="btn btn-ghost" data-mg-back>' + esc(label) + '</button>';

// ---------- Écrans ----------

function chooseHTML() {
  const j = ui.job;
  const resume = j && j.status === 'paused'
    ? '<div class="mg-resume"><p><b>Import ' + esc(SOURCE_LABEL[j.source]) + ' en pause</b> · ' + reportOf(j).done + '/' + j.items.length + '. ' + esc(j.pausedReason || '') + '</p>' +
      '<div class="si-actions"><button type="button" class="btn btn-primary" data-mg-resume>Reprendre</button><button type="button" class="btn btn-ghost" data-mg-drop>Abandonner</button></div></div>'
    : j && j.status === 'done' ? '<p class="set-hint"><button type="button" class="mg-link" data-mg-last>Voir le rapport du dernier import</button></p>' : '';
  return resume + '<p class="set-hint">Choisis d’où viennent tes données. Tu vois ce qui sera importé avant que rien ne change.</p>' +
    '<ul class="mg-srcs">' + SOURCES.map((s) => '<li><button type="button" class="mg-src" data-mg-src="' + s.id + '"><span class="mg-src-t">' + esc(s.label) + '</span><span class="mg-src-d">' + esc(s.hint) + '</span></button></li>').join('') + '</ul>' +
    importedAddonsHTML(addonImportAvailable() ? importedAddons() : []) +
    '<p class="set-hint mg-beta">Tu arrives de Stremio ? <a href="' + BETA_URL + '" target="_blank" rel="noopener">Programme bêta des migrants</a> : tes retours et nos corrections, publiés et datés.</p>';
}

/** Avertissement avant la saisie des identifiants Stremio (lecture seule, rien n'est modifié sur le compte). */
function warnHTML() {
  return '<div class="mg-warn" role="note"><p class="mg-warn-t">Avant de continuer</p>' +
    '<p>L’import <strong>lit</strong> ta bibliothèque Stremio. Il ne modifie jamais ton compte Stremio : aucun titre, addon, réglage ni historique n’y est changé ou supprimé, et tu peux continuer à utiliser Stremio comme avant.</p>' +
    '<p>Ton e-mail et ton mot de passe partent directement de cet appareil vers Stremio. Ni Laststream ni ton serveur ne les reçoivent ; ils ne sont pas enregistrés. La session ouverte pour la lecture est fermée aussitôt.</p></div>' +
    '<div class="si-actions"><button type="button" class="btn btn-primary" data-mg-ack>J’ai compris, continuer</button>' + back() + '</div>';
}

function stremioFormHTML() {
  const ign = ' data-1p-ignore data-lpignore="true" data-bwignore';
  const email = fieldRow('E-mail Stremio', '', (id) => '<input class="set-input" id="' + id + '" type="email" inputmode="email" name="email" required autocomplete="off" autocapitalize="none" spellcheck="false"' + ign + '>', { stack: true });
  const pwd = fieldRow('Mot de passe Stremio', '', (id) => '<input class="set-input" id="' + id + '" type="password" name="password" required autocomplete="new-password"' + ign + '>', { stack: true });
  const addons = addonImportAvailable()
    ? '<label class="mg-chk"><input type="checkbox" name="addons"' + (ui.readAddons ? ' checked' : '') + '> Lire aussi la liste de mes addons (étape séparée, facultative)</label>' : '';
  return note('Lecture seule, depuis cet appareil', ['Identifiants envoyés à Stremio seulement, jamais à Laststream.', 'Rien n’est modifié sur ton compte Stremio.', 'Oubliés dès la lecture terminée.']) + alertHTML() +
    '<form id="mg-stremio" class="set-form si-form" autocomplete="off" novalidate>' + email + pwd + addons +
    '<div class="si-actions"><button type="submit" class="btn btn-primary">Lire ma bibliothèque</button>' + back() + '</div></form>';
}

function fileHTML() {
  const what = { 'stremio-file': ['fichier d’export Stremio', '.json,application/json'], nuvio: ['fichier de sauvegarde Nuvio', '.json,application/json'], simkl: ['fichier d’export Simkl', '.json,.csv,application/json,text/csv'] }[ui.source];
  return note('Le fichier reste sur cet appareil', ['Il est lu ici, sans aucun envoi réseau.', 'Seuls les titres que tu choisis ensuite sont ajoutés à ton profil.']) + alertHTML() +
    '<form id="mg-file" class="set-form" novalidate>' + fieldRow('Ton ' + what[0], '', (id) => '<input class="set-input" id="' + id + '" type="file" name="file" accept="' + what[1] + '" required>', { stack: true }) +
    '<div class="si-actions"><button type="submit" class="btn btn-primary">Lire le fichier</button>' + back() + '</div></form>';
}

function plexHTML() {
  const p = ui.plex || {};
  if (p.servers) {
    return note('Autorisation Plex donnée', ['Le jeton reste en mémoire le temps de l’import.', 'Seul l’historique de visionnage est lu.']) + alertHTML() +
      '<form id="mg-plex" class="set-form" novalidate><fieldset class="mg-fs"><legend class="set-row-l">Serveur à lire</legend>' +
      p.servers.map((s, i) => '<label class="mg-chk"><input type="radio" name="server" value="' + i + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(s.name) + (s.owned ? '' : ' (partagé)') + '</label>').join('') +
      '</fieldset><div class="si-actions"><button type="submit" class="btn btn-primary">Lire l’historique</button>' + back() + '</div></form>';
  }
  return note('Autorisation sur Plex', ['La page Plex s’ouvre : connecte-toi et autorise Laststream.', 'Laststream lit les titres vus et leurs dates, rien d’autre.', 'Ton mot de passe Plex n’est jamais saisi ici.']) + alertHTML() +
    (p.waiting ? '<p class="set-hint" role="status">En attente de ton autorisation sur la page Plex… <a href="' + esc(p.authUrl) + '" target="_blank" rel="noopener">Rouvrir la page</a></p>' : '') +
    '<div class="si-actions"><button type="button" class="btn btn-primary" data-mg-plex-auth' + (p.waiting ? ' disabled' : '') + '>Autoriser sur Plex</button>' + back() + '</div>';
}

function readingHTML() {
  return '<div class="si-steps-w"><p class="mg-step" role="status" aria-live="polite">' + esc(ui.step || 'Lecture…') + '</p><div class="si-bar" role="progressbar" aria-label="Lecture en cours" aria-valuetext="En cours"><i></i></div></div>';
}

function previewHTML() {
  const b = ui.bundle;
  const usable = b.items.filter((i) => !i.skipReason);
  const pre = b.items.length - usable.length;
  const rows = CATS.map((c) => {
    const count = usable.filter(c.test).length;
    if (!count) return '';
    return '<label class="mg-chk mg-cat"><input type="checkbox" data-mg-cat="' + c.id + '"' + (ui.cats.has(c.id) ? ' checked' : '') + '> <span>' + esc(c.label) + '</span><b>' + count + '</b></label>';
  }).join('');
  const anime = usable.some((i) => i.anime) ? '<p class="set-hint">Les animes gardent leur catégorie : filtre « Anime » dans ta bibliothèque.</p>' : '';
  const notes = b.notes.map((x) => '<p class="set-hint">' + esc(x) + '</p>').join('');
  const total = selectedItems().filter((i) => !i.skipReason).length;
  return '<p class="mg-lead">' + esc(SOURCE_LABEL[b.source]) + ' : voici ce qui peut être importé sur ce profil. Décoche ce que tu ne veux pas.</p>' + notes +
    (rows ? '<fieldset class="mg-fs"><legend class="sr-only">Contenu à importer</legend>' + rows + '</fieldset>' : '<p class="set-hint">Rien à importer dans cette source.</p>') +
    (pre ? '<p class="set-hint">' + pre + (pre > 1 ? ' éléments seront ignorés' : ' élément sera ignoré') + ' (sans équivalent dans Laststream) : le rapport dira pourquoi.</p>' : '') + anime +
    addonsStepHTML() + alertHTML() +
    '<div class="si-actions"><button type="button" class="btn btn-primary" data-mg-run' + (total || (ui.addonsOn && ui.addonsPicked.size) ? '' : ' disabled') + '>' +
    (total ? 'Importer ' + total + (total > 1 ? ' éléments' : ' élément') : 'Importer les addons') + '</button>' + back('Annuler') + '</div>';
}

/** Étape séparée des addons : désactivée par défaut, aucun addon coché d'avance, rien de recommandé. */
function addonsStepHTML() {
  const list = ui.bundle.addons;
  if (!list.length || !addonImportAvailable()) return '';
  const items = ui.addonsOn ? '<ul class="mg-addons">' + list.map((a) => '<li><label class="mg-chk"><input type="checkbox" data-mg-addon="' + esc(a.manifestUrl) + '"' +
    (ui.addonsPicked.has(a.manifestUrl) ? ' checked' : '') + (a.official ? ' disabled' : '') + '> ' + esc(a.name) + (a.official ? ' <span class="mg-off">(officiel, déjà couvert)</span>' : '') + '</label></li>').join('') + '</ul>' +
    '<p class="set-hint">Les adresses des addons, qui peuvent contenir des clés, restent sur cet appareil. Laststream ne vérifie ni ne recommande aucun addon : tu choisis.</p>' : '';
  return '<fieldset class="mg-fs mg-addon-step"><legend class="set-row-l">Addons (étape facultative)</legend>' +
    '<label class="mg-chk"><input type="checkbox" data-mg-addons-on' + (ui.addonsOn ? ' checked' : '') + '> Importer aussi des addons (' + list.length + ' trouvé' + (list.length > 1 ? 's' : '') + ')</label>' + items + '</fieldset>';
}

function runningHTML() {
  const j = ui.job;
  const rep = reportOf(j);
  const pct = j.items.length ? Math.round((rep.done / j.items.length) * 100) : 100;
  const paused = j.status === 'paused';
  return '<div class="si-steps-w"><p class="mg-step" role="status" aria-live="polite">' + (paused ? esc(j.pausedReason || 'Import en pause.') : 'Import en cours : ' + rep.done + ' sur ' + j.items.length) + '</p>' +
    '<div class="mg-bar" role="progressbar" aria-label="Import" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
    '<p class="set-hint">' + rep.ok + ' réussis · ' + rep.skipped + ' ignorés · ' + rep.failed + ' échoués</p></div>' +
    '<div class="si-actions">' + (paused
      ? '<button type="button" class="btn btn-primary" data-mg-resume>Reprendre</button><button type="button" class="btn btn-ghost" data-mg-drop>Abandonner</button>'
      : '<button type="button" class="btn btn-ghost" data-mg-pause>Mettre en pause</button>') + '</div>';
}

function reportScreenHTML() {
  const rep = reportOf(ui.job);
  return '<p class="mg-lead" id="mg-done" tabindex="-1">Import ' + esc(SOURCE_LABEL[ui.job.source]) + ' terminé.</p>' + reportHTML(rep) + addonLogHTML(ui.addonLog) +
    '<div class="si-actions"><a class="btn btn-primary" href="#/library" data-go data-libnav>Voir ma bibliothèque</a>' +
    '<button type="button" class="btn btn-ghost" data-mg-copy>Copier le rapport</button><button type="button" class="btn btn-ghost" data-mg-dl>Télécharger</button>' +
    '<button type="button" class="btn btn-ghost" data-mg-new>Nouvel import</button></div>';
}

function bodyHTML() {
  switch (ui.phase) {
    case 'warn': return warnHTML();
    case 'stremio': return stremioFormHTML();
    case 'file': return fileHTML();
    case 'plex': return plexHTML();
    case 'reading': return readingHTML();
    case 'preview': return previewHTML();
    case 'running': return runningHTML();
    case 'report': return reportScreenHTML();
    default: return chooseHTML();
  }
}

/** HTML de la carte (repliée ou dépliée selon la dernière visite ; dépliée si un import est en cours). */
export function migrationCard() {
  restoreJob();
  const open = isOpen() || ui.busy;
  return '<div class="set-card si-card mg-card" id="mg-card" data-open="' + open + '">' +
    '<h3 class="si-h"><button type="button" class="si-toggle" data-mg-toggle aria-expanded="' + open + '" aria-controls="mg-body">' +
    '<span class="si-t">Importer depuis une autre app</span><span class="si-sum" id="mg-sum">' + esc(summary()) + '</span>' + CHEV + '</button></h3>' +
    '<div class="si-body" id="mg-body"' + (open ? '' : ' inert') + '><div class="si-body-in" id="mg-in" data-phase="' + ui.phase + '">' + bodyHTML() + '</div></div></div>';
}

function paint(focusSel) {
  const c = card();
  if (!c) return;
  const inner = c.querySelector('#mg-in');
  inner.dataset.phase = ui.phase;
  // eslint-disable-next-line no-restricted-syntax -- titres, noms d'addons et raisons échappés par esc dans chaque gabarit
  inner.innerHTML = bodyHTML();
  c.querySelector('#mg-sum').textContent = summary();
  const f = focusSel && inner.querySelector(focusSel);
  if (f) f.focus();
}

function go(phase, focusSel) {
  ui.phase = phase;
  ui.error = '';
  paint(focusSel);
}

function fail(text) {
  ui.error = text;
  paint();
}

function setOpen(open) {
  const c = card();
  if (!c) return;
  c.dataset.open = String(open);
  c.querySelector('[data-mg-toggle]').setAttribute('aria-expanded', String(open));
  const body = c.querySelector('#mg-body');
  if (open) body.removeAttribute('inert');
  else {
    if (body.contains(document.activeElement)) c.querySelector('[data-mg-toggle]').focus();
    body.setAttribute('inert', '');
  }
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* stockage indisponible */ }
}

// ---------- Lecture des sources ----------

function showPreview(bundle) {
  ui.bundle = bundle;
  ui.cats = new Set(CATS.map((c) => c.id));
  ui.addonsOn = false;
  ui.addonsPicked = new Set();
  go('preview', '.mg-lead');
}

const selectedItems = () => (ui.bundle ? ui.bundle.items.filter((i) => i.skipReason || CATS.some((c) => ui.cats.has(c.id) && c.test(i))) : []);

async function readStremio(form) {
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;
  if (!email || !password) { fail('Renseigne l’e-mail et le mot de passe de ton compte Stremio.'); return; }
  ui.readAddons = !!(form.elements.addons && form.elements.addons.checked);
  form.elements.password.value = '';
  ui.step = 'Connexion à Stremio…';
  go('reading');
  try {
    const bundle = await readStremioAccount(email, password, {
      addons: ui.readAddons,
      onStep: (s) => { ui.step = { login: 'Connexion à Stremio…', library: 'Lecture de la bibliothèque…', addons: 'Lecture de la liste des addons…' }[s]; paint(); },
    });
    showPreview(bundle);
  } catch (err) {
    ui.phase = 'stremio';
    fail(err instanceof StremioError ? err.message : 'Lecture impossible : ' + (err && err.message ? err.message : 'erreur inconnue') + '.');
  }
}

async function readFile(form) {
  const file = form.elements.file.files && form.elements.file.files[0];
  if (!file) { fail('Choisis un fichier.'); return; }
  if (file.size > 50 * 1024 * 1024) { fail('Fichier trop volumineux (plus de 50 Mo).'); return; }
  ui.step = 'Lecture du fichier…';
  go('reading');
  try {
    const text = await file.text();
    let bundle;
    if (ui.source === 'simkl') bundle = parseSimklExport(text);
    else {
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('Ce fichier n’est pas un JSON lisible.'); }
      bundle = ui.source === 'nuvio' ? parseNuvioBackup(json) : parseStremioExport(json);
    }
    showPreview(bundle);
  } catch (err) {
    ui.phase = 'file';
    fail(err && err.message ? err.message : 'Fichier illisible.');
  }
}

async function plexAuthorize() {
  try {
    const pin = await createPlexPin();
    ui.plex = { pin, authUrl: pin.authUrl, waiting: true };
    window.open(pin.authUrl, '_blank', 'noopener');
    paint();
    const until = Date.now() + PLEX_WAIT_MS;
    let token = null;
    while (!token && Date.now() < until && ui.phase === 'plex' && ui.plex && ui.plex.pin === pin) {
      await new Promise((r) => setTimeout(r, PLEX_POLL_MS));
      token = await checkPlexPin(pin.id).catch((e) => { if (e instanceof PlexError && e.kind === 'expired') throw e; return null; });
    }
    if (!ui.plex || ui.plex.pin !== pin || ui.phase !== 'plex') return;
    if (!token) { ui.plex = null; fail('Autorisation non reçue. Réessaie quand la page Plex est ouverte.'); return; }
    const servers = await listPlexServers(token);
    if (!servers.length) { ui.plex = null; fail('Aucun serveur Plex trouvé sur ce compte.'); return; }
    ui.plex = { token, servers };
    paint('input[name=server]');
  } catch (err) {
    ui.plex = null;
    fail(err instanceof PlexError ? err.message : 'Autorisation Plex impossible.');
  }
}

async function readPlex(form) {
  const p = ui.plex;
  const server = p && p.servers[Number(form.elements.server.value) || 0];
  if (!server) return;
  ui.step = 'Lecture de l’historique de « ' + server.name + ' »…';
  go('reading');
  try {
    const bundle = await readPlexHistory(server, p.token, { onProgress: (d, t) => { ui.step = 'Identification des titres : ' + d + ' sur ' + t; paint(); } });
    ui.plex = null; // jeton oublié dès la lecture terminée
    showPreview(bundle);
  } catch (err) {
    ui.phase = 'plex';
    fail(err instanceof PlexError ? err.message : 'Lecture de l’historique impossible.');
  }
}

// ---------- Import ----------

let resumeOnline = null;

async function execute(job) {
  if (ui.busy) return;
  ui.busy = true;
  ui.job = job;
  ui.phase = 'running';
  ui.abort = new AbortController();
  paint();
  let last = 0;
  try {
    const sink = await activeSink();
    await runJob(job, {
      sink, resolve: createResolver(), videos: createVideoLister(), signal: ui.abort.signal,
      onProgress: () => { const now = Date.now(); if (now - last > 150) { last = now; paint(); } },
    });
  } catch (err) {
    job.status = 'paused';
    job.pausedReason = 'Import interrompu (' + (err && err.message ? err.message : 'erreur inconnue') + ') : il reprendra là où il s’est arrêté.';
  } finally {
    ui.busy = false;
    ui.abort = null;
  }
  if (job.status === 'paused') {
    paint();
    // Retour du réseau : reprise automatique, une seule fois par pause.
    if (!resumeOnline) {
      resumeOnline = () => { resumeOnline = null; if (ui.job === job && job.status === 'paused') void execute(job); };
      window.addEventListener('online', resumeOnline, { once: true });
    }
    return;
  }
  if (ui.bundle && ui.addonsOn && ui.addonsPicked.size) {
    ui.addonLog = await importAddons(ui.bundle.addons, ui.addonsPicked);
  }
  await refreshRemote().catch(() => undefined);
  emitDataEvent({ kind: 'library' });
  emitDataEvent({ kind: 'watched' });
  toast('Import ' + SOURCE_LABEL[job.source] + ' terminé');
  ui.bundle = null;
  go('report', '#mg-done');
}

function startImport() {
  const items = selectedItems();
  if (!items.some((i) => !i.skipReason) && !(ui.addonsOn && ui.addonsPicked.size)) return;
  void execute(createJob({ source: ui.bundle.source, items }, profileId()));
}

function download(text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = 'laststream-import-' + new Date().toISOString().slice(0, 10) + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Évènements ----------

detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const c = card();
  if (!t || !c || !c.contains(t)) return;
  const src = t.closest('[data-mg-src]');
  if (t.closest('[data-mg-toggle]')) setOpen(c.dataset.open !== 'true');
  else if (src) {
    ui.source = src.dataset.mgSrc;
    ui.plex = null;
    go(ui.source === 'stremio' ? 'warn' : ui.source === 'plex' ? 'plex' : 'file', ui.source === 'stremio' ? '[data-mg-ack]' : 'input, [data-mg-plex-auth]');
  } else if (t.closest('[data-mg-ack]')) go('stremio', 'input[name=email]');
  else if (t.closest('[data-mg-back]')) { ui.bundle = null; ui.plex = null; go('choose', '[data-mg-src]'); } else if (t.closest('[data-mg-plex-auth]')) void plexAuthorize();
  else if (t.closest('[data-mg-run]')) startImport();
  else if (t.closest('[data-mg-pause]')) { if (ui.abort) ui.abort.abort(); } else if (t.closest('[data-mg-resume]')) { if (ui.job) void execute(ui.job); } else if (t.closest('[data-mg-drop]')) {
    clearJob(profileId());
    ui.job = null;
    go('choose');
  } else if (t.closest('[data-mg-last]')) { ui.addonLog = null; go('report', '#mg-done'); } else if (t.closest('[data-mg-new]')) go('choose', '[data-mg-src]');
  else if (t.closest('[data-mg-copy]')) {
    const text = reportText(reportOf(ui.job), ui.job.finishedAt);
    navigator.clipboard?.writeText(text).then(() => toast('Rapport copié'), () => download(text));
  } else if (t.closest('[data-mg-dl]')) download(reportText(reportOf(ui.job), ui.job.finishedAt));
  else if (t.closest('[data-mg-addon-remove]')) {
    setAddonCatalog(t.closest('[data-mg-addon-remove]').dataset.mgAddonRemove, null);
    paint();
  }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target instanceof HTMLInputElement ? e.target : null;
  const c = card();
  if (!t || !c || !c.contains(t)) return;
  if (t.dataset.mgCat) { if (t.checked) ui.cats.add(t.dataset.mgCat); else ui.cats.delete(t.dataset.mgCat); paint('[data-mg-cat="' + t.dataset.mgCat + '"]'); } else if (t.hasAttribute('data-mg-addons-on')) { ui.addonsOn = t.checked; paint('[data-mg-addons-on]'); } else if (t.dataset.mgAddon) {
    if (t.checked) ui.addonsPicked.add(t.dataset.mgAddon); else ui.addonsPicked.delete(t.dataset.mgAddon);
    const run = c.querySelector('[data-mg-run]');
    if (run) run.disabled = !(selectedItems().some((i) => !i.skipReason) || ui.addonsPicked.size);
  } else if (t.dataset.mgAddonHome) {
    const key = t.dataset.mgAddonHome;
    const prev = readAddonCatalogs()[key];
    if (prev) setAddonCatalog(key, { ...prev, home: t.checked });
  }
});

detailEl.addEventListener('submit', (e) => {
  const f = e.target;
  if (!f || !card() || !card().contains(f)) return;
  e.preventDefault();
  if (f.id === 'mg-stremio') void readStremio(f);
  else if (f.id === 'mg-file') void readFile(f);
  else if (f.id === 'mg-plex') void readPlex(f);
});
