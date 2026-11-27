/* Espace Plateforme : clés des services (TMDB, MDBList, TheTVDB, OpenRouter…), partagées par tous les comptes. Le serveur ne
 * renvoie jamais une clé : seulement son état (présente, quatre derniers caractères, origine). Une clé enregistrée ici passe
 * avant la variable du serveur, qui passe avant la clé saisie dans un compte. Écritures sous élévation (mot de passe). */
import * as api from '../../data/adminApi';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { modelComboHTML } from '../model-combobox.js';
import { fieldRow } from '../settings-ui.js';
import { esc } from '../util.js';
import { admCard, adminErr, attempt, badge, loaded, sectionHead } from './common.js';
import '../../styles/admin-platform.css';
import { loadInto } from './view-state.js';
import { t as tr } from '../../i18n';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const MODEL = 'openrouterModel';

/** Champs par groupe : [champ, libellé, description]. Le modèle OpenRouter a son propre sélecteur. */
const SERVICE_GROUPS = [
  [tr('Catalogue et fiches'), tr('Catalogues, fiches, notes et visuels.'), [
    ['tmdbToken', tr('Jeton TMDB (lecture v4)'), tr('Requis pour les catalogues, les fiches et les recommandations.')],
    ['tmdbApiKey', tr('Clé API TMDB (v3)'), tr('Facultative.')],
    ['mdblistApiKey', tr('Clé MDBList'), tr('Notes IMDb, Rotten Tomatoes, Metacritic, Letterboxd.')],
    ['fanartApiKey', tr('Clé Fanart.tv'), tr('Logos et visuels. Facultative.')],
  ]],
  [tr('Séries'), tr('Saisons et prochain épisode.'), [
    ['tvdbApiKey', tr('Clé TheTVDB'), tr('Clé v4 personnelle, ou clé legacy de 32 caractères hexadécimaux.')],
    ['tvdbPin', tr('PIN d’abonné TheTVDB'), tr('Seulement avec une clé v4 personnelle.')],
  ]],
  [tr('Recommandations IA'), tr('Recommandations et textes sur les personnes (facturés par OpenRouter).'), [
    ['openrouterApiKey', tr('Clé OpenRouter'), ''],
    [MODEL, tr('Modèle OpenRouter'), tr('Utilisé pour tous les comptes.')],
  ]],
  [tr('Repères de saut'), tr('Intro, récapitulatif et générique. Facultatives : sans clé, les repères se lisent quand même.'), [
    ['introdbApiKey', tr('Clé IntroDB'), tr('Avec une clé, les propositions de repères sont aussi envoyées à IntroDB.')],
    ['skipdbApiKey', tr('Clé SkipDB'), tr('Avec une clé, les propositions de repères sont aussi envoyées à SkipDB.')],
    ['animeskipClientId', tr('Client ID Anime Skip'), tr('Repères des séries d’animation.')],
  ]],
];

const SOURCE_LABEL = { db: tr('Administration'), env: tr('Variable du serveur') };

/**
 * Fournisseur testé depuis la ligne d'une clé (POST /admin/providers/:id/test), avec les clés effectives du serveur. Les autres
 * champs (PIN, repères de saut) n'ont pas de test : le PIN est testé avec la clé TheTVDB.
 */
const TEST_OF = { tmdbToken: 'tmdb', mdblistApiKey: 'mdblist', fanartApiKey: 'fanart', tvdbApiKey: 'tvdb', openrouterApiKey: 'openrouter' };
/** Champs dont la présence rend le fournisseur testable (TMDB : jeton v4 ou clé v3). */
const TEST_NEEDS = { tmdb: ['tmdbToken', 'tmdbApiKey'], mdblist: ['mdblistApiKey'], fanart: ['fanartApiKey'], tvdb: ['tvdbApiKey'], openrouter: ['openrouterApiKey'] };
const TEST_ERROR = { rejected: tr('clé refusée'), http: tr('erreur HTTP'), timeout: tr('délai dépassé'), network: tr('réseau injoignable') };

/** Le fournisseur a-t-il une clé en place (administration ou variable du serveur) ? */
export const testable = (provider, keys) => (TEST_NEEDS[provider] || []).some((f) => keys[f] && keys[f].set);

/** Résultat d'un test, en texte : en cours, réussi (latence), échec (statut, raison) ou erreur de l'appel. */
export function testNoteHTML(t) {
  if (!t) return '';
  if (t.state === 'running') return '<span class="adm-spin" aria-hidden="true"></span><span>' + tr('Test en cours…') + '</span>';
  if (t.state === 'error') return '<span class="adm-test-r is-bad">' + esc(t.error) + '</span>';
  const r = t.result || {};
  const ms = Number.isFinite(r.latencyMs) ? Math.round(r.latencyMs) + ' ms' : '';
  if (r.ok) return '<span class="adm-test-r is-ok">' + tr('Clé valide') + (ms ? ' · ' + ms : '') + '</span>';
  const why = [r.status != null ? 'HTTP ' + r.status : '', TEST_ERROR[r.error] || r.error || ''].filter(Boolean).join(' · ');
  return '<span class="adm-test-r is-bad">' + tr('Échec') + (why ? ' · ' + esc(why) : '') + (ms ? ' · ' + ms : '') + '</span>';
}

/** Texte du champ vide : ce qui est en place aujourd'hui. */
export function keyPlaceholder(st) {
  if (!st || !st.set) return tr('Non définie');
  const tail = st.last4 ? ' (' + st.last4 + ')' : '';
  return st.source === 'env' ? tr('Variable du serveur{tail} : saisis une clé pour la remplacer', { tail }) : tr('Enregistrée') + tail;
}

function sourceBadge(st) {
  if (!st || !st.set) return badge(tr('Non définie'), '');
  return badge(SOURCE_LABEL[st.source] || st.source, st.source === 'db' ? 'ok' : '');
}

function testButton(provider, keys, t) {
  const on = testable(provider, keys);
  return '<button type="button" class="btn btn-ghost btn-sm" data-adm-svc-test="' + esc(provider) + '" data-adm-focus="svc-test:' + esc(provider) + '"' +
    (t && t.state === 'running' ? ' aria-busy="true" disabled' : '') + (on ? '' : ' disabled title="' + tr('Aucune clé à tester') + '"') + '>' + tr('Tester') + '</button>';
}

function keyRow(field, label, desc, keys, tests) {
  const st = keys[field];
  const clear = st && st.source === 'db'
    ? '<button type="button" class="btn btn-ghost btn-sm" data-adm-svc-clear="' + esc(field) + '" data-adm-focus="svc-clear:' + esc(field) + '">' + tr('Effacer') + '</button>'
    : '';
  const provider = TEST_OF[field];
  const t = provider ? tests[provider] : null;
  return fieldRow(label, desc, (id) => '<div class="adm-svc-row">' +
    '<input class="set-input" id="' + id + '" type="password" name="svc.' + esc(field) + '" autocomplete="off" spellcheck="false" placeholder="' + esc(keyPlaceholder(st)) + '" data-adm-focus="svc:' + esc(field) + '">' +
    sourceBadge(st) + (provider || clear ? '<span class="adm-svc-acts">' + (provider ? testButton(provider, keys, t) : '') + clear + '</span>' : '') +
    (provider ? '<p class="adm-test adm-svc-test" role="status">' + testNoteHTML(t) + '</p>' : '') + '</div>', { stack: true });
}

function modelRow(label, desc, st) {
  return fieldRow(label, desc + (st && st.set ? '' : ' ' + tr('Non défini ici : chaque compte garde son modèle, sinon {DEFAULT_MODEL}.', { DEFAULT_MODEL })),
    (id) => modelComboHTML(id, (st && st.value) || DEFAULT_MODEL), { stack: true });
}

export function servicesHTML(S) {
  const importBtn = '<button type="button" class="btn btn-ghost btn-sm" data-adm-svc-import data-adm-focus="svc-import">' + tr('Importer depuis mon compte') + '</button>';
  return sectionHead(tr('Clés des services'), tr('Clés partagées par tous les comptes. Elles ne quittent jamais le serveur.'), importBtn) +
    loaded(S.serviceKeys, (r) => {
      const keys = r.services || {};
      const tests = S.svcTests || {};
      return '<form id="adm-svc" class="set-form adm-settings adm-svc" autocomplete="off">' +
        '<p class="adm-banner" role="note">' + tr('Une clé enregistrée ici passe avant la variable du serveur, qui passe avant la clé saisie dans un compte. Laisse un champ vide pour garder la clé en place.') + '</p>' +
        SERVICE_GROUPS.map(([title, desc, fields]) => admCard(title, fields.map(([f, l, d]) => (f === MODEL ? modelRow(l, d, keys[f]) : keyRow(f, l, d, keys, tests))).join(''), { desc })).join('') +
        '<p class="set-msg" id="adm-svc-msg" role="status"></p><div class="set-actions"><button type="submit" class="btn btn-primary">' + tr('Enregistrer') + '</button></div></form>';
    });
}

/** Modification à envoyer : champs saisis (non vides) et modèle changé. Vide : rien à enregistrer. */
export function servicesPatch(form, keys) {
  const patch = {};
  for (const [, , fields] of SERVICE_GROUPS) {
    for (const [f] of fields) {
      const input = form.elements['svc.' + f];
      const v = input ? String(input.value || '').trim() : '';
      if (!v) continue;
      // Modèle : envoyé seulement s'il diffère de celui affiché (en place, sinon celui par défaut).
      if (f !== MODEL || v !== ((keys[f] && keys[f].value) || DEFAULT_MODEL)) patch[f] = v;
    }
  }
  return patch;
}

function applyKeys(ctx, services) {
  ctx.S.svcTests = {}; // les clés ont changé : les résultats de test précédents ne valent plus
  ctx.S.serviceKeys = { status: 'ready', error: '', value: { services } };
  ctx.paint();
}

async function save(ctx, root, form) {
  const say = (t) => { const m = root.querySelector('#adm-svc-msg'); if (m) m.textContent = t; };
  const cur = ctx.S.serviceKeys && ctx.S.serviceKeys.value ? ctx.S.serviceKeys.value.services : {};
  const patch = servicesPatch(form, cur);
  if (!Object.keys(patch).length) { say(tr('Rien à enregistrer.')); return; }
  say(tr('Enregistrement…'));
  let res;
  if (await attempt(async () => { res = await api.putServiceKeys(patch); }, say)) {
    applyKeys(ctx, res.services);
    toast(tr('Clés des services enregistrées'));
  }
}

async function clearKey(ctx, field) {
  const label = SERVICE_GROUPS.flatMap((g) => g[2]).find(([f]) => f === field);
  if (!(await confirmDialog({ title: tr('Effacer la clé'), message: tr('La clé <strong>{v}</strong> enregistrée dans l’administration sera effacée. La variable du serveur, puis la clé de chaque compte, prendront le relais.', { v: esc(label ? label[1] : field) }), confirmLabel: tr('Effacer'), danger: true }))) return;
  let res;
  if (await attempt(async () => { res = await api.putServiceKeys({ [field]: null }); }, toast)) {
    applyKeys(ctx, res.services);
    toast(tr('Clé effacée'));
  }
}

async function importKeys(ctx) {
  if (!(await confirmDialog({ title: tr('Importer depuis mon compte'), message: tr('Les clés enregistrées dans les réglages de ton compte remplacent celles de l’administration, pour tous les comptes. Les clés absentes de ton compte restent telles quelles.'), confirmLabel: tr('Importer') }))) return;
  let res;
  if (!(await attempt(async () => { res = await api.importServiceKeys(); }, toast))) return;
  applyKeys(ctx, res.services);
  const n = (res.imported || []).length;
  toast(n ? n + (n > 1 ? ' ' + tr('clés importées') : ' ' + tr('clé importée')) : tr('Aucune clé à importer dans ton compte'));
}

/** Teste un fournisseur avec la clé en place sur le serveur (pas la saisie non enregistrée). Élévation demandée au besoin. */
export async function testService(ctx, provider, runner = api.testProvider) {
  const tests = ctx.S.svcTests || (ctx.S.svcTests = {});
  const repaint = () => { if (ctx.isCurrent()) ctx.paint(); };
  tests[provider] = { state: 'running' };
  repaint();
  try {
    tests[provider] = { state: 'done', result: await runner(provider) };
  } catch (err) {
    tests[provider] = { state: 'error', error: adminErr(err) };
  }
  repaint();
}

function bindServices(root, ctx) {
  root.querySelectorAll('[data-adm-svc-test]').forEach((b) => b.addEventListener('click', () => testService(ctx, b.dataset.admSvcTest)));
  const form = root.querySelector('#adm-svc');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); save(ctx, root, form); });
  root.querySelectorAll('[data-adm-svc-clear]').forEach((b) => b.addEventListener('click', () => clearKey(ctx, b.dataset.admSvcClear)));
  const imp = root.querySelector('[data-adm-svc-import]');
  if (imp) imp.addEventListener('click', () => importKeys(ctx));
}

export const servicesSections = [
  {
    id: 'services', group: 'platform', label: tr('Clés des services'), icon: 'lock', render: servicesHTML, bind: bindServices,
    load: (ctx, quiet) => loadInto(ctx, 'serviceKeys', () => api.getServiceKeys(), quiet),
  },
];
