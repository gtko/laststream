/* Carte « Importer ma bibliothèque Stremio » (réglages > compte) : repliable, étapes, résultat, erreurs.
 * Les identifiants ne sont ni mémorisés ni journalisés ; seuls la date, le total et l'état replié le sont. */
import '../styles/stremio-import.css';
import { importFromStremio } from '../data/auth';
import { getConfig } from '../data/config';
import { UserApiError } from '../data/userApi';
import { errorText } from './auth-ui.js';
import { fieldRow } from './settings-ui.js';
import { detailEl, toast } from './dom.js';

const KEY = 'ls_stremio_import';
/** Cadence purement visuelle des deux premières étapes : le serveur ne renvoie aucune progression. */
const STEP_MS = [1500, 5000];
const STEPS = ['Connexion à Stremio', 'Lecture de la bibliothèque', 'Ajout au profil'];

const read = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
};
const write = (patch) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch })); } catch { /* stockage indisponible */ }
};

const plural = (n) => n + (n > 1 ? ' titres' : ' titre');
const dateFr = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Résumé d'en-tête : « Pas encore importée » ou « Déjà importé le … · N titres ». */
function summary() {
  const s = read();
  if (typeof s.at !== 'number') return 'Pas encore importée';
  return 'Déjà importé le ' + dateFr(s.at) + (typeof s.count === 'number' ? ' · ' + plural(s.count) : '');
}

const LOCK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const CHEV = '<svg class="si-chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/** Un import est en cours (survit à un re-rendu de la page ou à une navigation). */
let running = false;

/** HTML de la carte, repliée ou dépliée selon la dernière visite. */
export function stremioImportCard() {
  const open = read().open === true;
  const ro = running ? ' readonly' : '';
  const ign = ' data-1p-ignore data-lpignore="true" data-bwignore';
  const email = fieldRow('E-mail Stremio', '', (id) => '<input class="set-input" id="' + id + '" type="email" inputmode="email" name="email" required autocomplete="off" autocapitalize="none" spellcheck="false"' + ign + ro + '>', { stack: true });
  const pwd = fieldRow('Mot de passe Stremio', '', (id) => '<span class="si-pwd"><input class="set-input" id="' + id + '" type="password" name="password" required autocomplete="new-password"' + ign + ro + '>' +
    '<button type="button" class="si-eye" data-si-eye aria-label="Afficher le mot de passe" aria-pressed="false"' + (running ? ' disabled' : '') + '>' + EYE + '</button></span>', { stack: true });
  return '<div class="set-card si-card" id="si-card" data-phase="' + (running ? 'running' : 'form') + '" data-open="' + open + '">' +
    '<h3 class="si-h"><button type="button" class="si-toggle" id="si-toggle" data-si-toggle aria-expanded="' + open + '" aria-controls="si-body">' +
    '<span class="si-t">Importer ma bibliothèque Stremio</span><span class="si-sum" id="si-sum">' + summary() + '</span>' + CHEV + '</button></h3>' +
    '<div class="si-body" id="si-body"' + (open ? '' : ' inert') + '><div class="si-body-in">' +
    '<div class="si-priv"><span class="si-lock">' + LOCK + '</span><div><p class="si-priv-t">Tes identifiants restent entre toi et ton serveur</p><ul>' +
    '<li>Envoyés à ton serveur lastAddon seulement.</li><li>Utilisés une seule fois, pour cet import.</li><li>Oubliés dès que l’import est terminé.</li></ul></div></div>' +
    '<div class="si-alert" id="si-alert" role="alert" hidden></div>' +
    '<form id="set-stremio" class="set-form si-form" autocomplete="off" novalidate aria-busy="' + running + '">' + email + pwd +
    '<div class="si-steps-w" id="si-steps-w"' + (running ? '' : ' hidden') + '><ol class="si-steps" id="si-steps" aria-live="polite">' +
    STEPS.map((s, i) => '<li data-state="' + (i === 0 ? 'active' : 'pending') + '">' + s + '<span class="sr-only">' + (i === 0 ? ' : en cours' : '') + '</span></li>').join('') + '</ol>' +
    '<div class="si-bar" role="progressbar" aria-label="Import en cours" aria-valuetext="En cours, durée inconnue"><i></i></div></div>' +
    '<p class="set-msg" id="set-st-msg" role="status"></p>' +
    '<div class="set-actions si-actions"><button type="submit" class="btn btn-primary si-submit" id="si-submit"' + (running ? ' disabled' : '') + '>' + (running ? 'Import en cours…' : 'Importer') + '</button>' +
    '<button type="button" class="btn btn-ghost si-retry" id="si-retry" data-si-retry hidden>Réessayer</button></div></form>' +
    '<div class="si-result" id="si-result" hidden><p class="si-result-t" id="si-result-t" tabindex="-1"></p>' +
    '<div class="set-actions si-actions"><a class="btn btn-primary" href="#/library" data-go data-libnav>Voir ma bibliothèque</a>' +
    '<button type="button" class="btn btn-ghost" data-si-again>Ré-importer</button></div></div>' +
    '</div></div></div>';
}

/** Type d'échec : identifiants refusés par Stremio, serveur injoignable, ou autre. */
function importFailure(err) {
  if (err instanceof UserApiError && err.code === 'stremio_login_failed') return { kind: 'credentials', text: errorText(err) };
  if (err instanceof UserApiError && err.code === 'network') return { kind: 'network', text: 'Le serveur lastAddon est injoignable. Rien n’a été ajouté : vérifie ta connexion puis réessaie.' };
  return { kind: 'other', text: errorText(err) };
}

const card = () => detailEl.querySelector('#si-card');
const $ = (sel, c = card()) => (c ? c.querySelector(sel) : null);
let timers = [];
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

function setOpen(open) {
  const c = card();
  if (!c) return;
  c.dataset.open = String(open);
  $('#si-toggle', c).setAttribute('aria-expanded', String(open));
  const body = $('#si-body', c);
  if (open) {
    body.removeAttribute('inert');
  } else {
    if (body.contains(document.activeElement)) $('#si-toggle', c).focus();
    body.setAttribute('inert', '');
  }
  write({ open });
}

function setPhase(phase, c) {
  c.dataset.phase = phase;
  const busy = phase === 'running';
  const f = $('#set-stremio', c);
  f.hidden = phase === 'done';
  $('#si-result', c).hidden = phase !== 'done';
  $('#si-steps-w', c).hidden = !busy;
  f.setAttribute('aria-busy', String(busy));
  for (const i of f.querySelectorAll('input')) i.readOnly = busy;
  $('[data-si-eye]', c).disabled = busy;
  const btn = $('#si-submit', c);
  btn.disabled = busy;
  btn.textContent = busy ? 'Import en cours…' : 'Importer';
  btn.hidden = phase === 'error-network';
  $('#si-retry', c).hidden = phase !== 'error-network';
  if (busy) $('#set-st-msg', c).textContent = '';
}

/** `invalid` : noms des champs à marquer aria-invalid ; le premier reçoit le focus. */
function showError(failure, c, invalid) {
  const al = $('#si-alert', c);
  al.textContent = failure.text;
  al.hidden = false;
  al.dataset.kind = failure.kind;
  const f = $('#set-stremio', c);
  const bad = failure.kind === 'credentials' ? (invalid || ['email', 'password']) : [];
  for (const i of f.querySelectorAll('input')) {
    if (bad.includes(i.name)) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
  }
  setPhase(failure.kind === 'network' ? 'error-network' : 'error', c);
  if (bad.length) f.elements[bad[0]].focus();
}

function clearError(c) {
  const al = $('#si-alert', c);
  al.hidden = true;
  al.textContent = '';
  for (const i of $('#set-stremio', c).querySelectorAll('input')) i.removeAttribute('aria-invalid');
}

function setStep(li, state) {
  li.dataset.state = state;
  const sr = li.querySelector('.sr-only');
  if (sr) sr.textContent = state === 'done' ? ' : terminé' : state === 'active' ? ' : en cours' : '';
}

function startSteps(c) {
  const items = Array.from($('#si-steps', c).children);
  items.forEach((li, i) => setStep(li, i === 0 ? 'active' : 'pending'));
  const adv = (i) => {
    if (i >= STEP_MS.length) return;
    timers.push(setTimeout(() => {
      setStep(items[i], 'done');
      setStep(items[i + 1], 'active');
      adv(i + 1);
    }, STEP_MS[i]));
  };
  adv(0);
}

/** Nombre de titres réellement renvoyé par le serveur, sinon null. */
const countOf = (res) => (res && typeof res === 'object' ? ['imported', 'added', 'count', 'library'].map((k) => res[k]).find((v) => typeof v === 'number') ?? null : null);

async function submit(form) {
  const c = card();
  const f = form.elements;
  const email = f.email.value.trim();
  if (!email || !f.password.value) {
    const empty = ['email', 'password'].filter((n) => !(n === 'email' ? email : f.password.value));
    showError({ kind: 'credentials', text: 'Renseigne l’e-mail et le mot de passe de ton compte Stremio.' }, c, empty);
    return;
  }
  clearError(c);
  clearTimers();
  running = true;
  f.password.type = 'password';
  const eye = $('[data-si-eye]', c);
  eye.setAttribute('aria-pressed', 'false');
  eye.setAttribute('aria-label', 'Afficher le mot de passe');
  setPhase('running', c);
  startSteps(c);
  try {
    const res = await importFromStremio(email, f.password.value, getConfig());
    clearTimers();
    const n = countOf(res);
    write({ at: Date.now(), count: n != null ? n : read().count });
    f.password.value = '';
    toast('Bibliothèque Stremio importée');
    if (!c.isConnected) return;
    for (const li of $('#si-steps', c).children) setStep(li, 'done');
    f.email.value = '';
    $('#si-sum', c).textContent = summary();
    $('#si-result-t', c).textContent = n != null ? plural(n) + (n > 1 ? ' ajoutés' : ' ajouté') + ' à ce profil.' : 'Import terminé.';
    setPhase('done', c);
    $('#si-result-t', c).focus();
  } catch (err) {
    clearTimers();
    const failure = importFailure(err);
    if (c.isConnected) showError(failure, c); else { f.password.value = ''; toast(failure.text); }
  } finally {
    running = false;
    // Carte re-rendue pendant l'import : la nouvelle carte, rendue « en cours », redevient un formulaire.
    const cur = card();
    if (cur && cur !== c) {
      setPhase('form', cur);
      $('#si-sum', cur).textContent = summary();
    }
  }
}

detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const c = card();
  if (!t || !c || !c.contains(t)) return;
  if (t.closest('[data-si-toggle]')) {
    setOpen(c.dataset.open !== 'true');
  } else if (t.closest('[data-si-eye]')) {
    if (running) return;
    const b = t.closest('[data-si-eye]');
    const input = $('[name=password]', c);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
  } else if (t.closest('[data-si-retry]')) {
    $('#set-stremio', c).requestSubmit();
  } else if (t.closest('[data-si-again]')) {
    clearError(c);
    setPhase('form', c);
    $('#set-stremio', c).elements.email.focus();
  }
});

detailEl.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'set-stremio') {
    e.preventDefault();
    if (!running && card()) submit(e.target);
  }
});
