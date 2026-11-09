/* Espace Plateforme : clés des services (TMDB, MDBList, TheTVDB, OpenRouter…), partagées par tous les comptes. Le serveur ne
 * renvoie jamais une clé : seulement son état (présente, quatre derniers caractères, origine). Une clé enregistrée ici passe
 * avant la variable du serveur, qui passe avant la clé saisie dans un compte. Écritures sous élévation (mot de passe). */
import * as api from '../../data/adminApi';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { modelComboHTML } from '../model-combobox.js';
import { fieldRow } from '../settings-ui.js';
import { esc } from '../util.js';
import { admCard, attempt, badge, loaded, sectionHead } from './common.js';
import '../../styles/admin-platform.css';
import { loadInto } from './view-state.js';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const MODEL = 'openrouterModel';

/** Champs par groupe : [champ, libellé, description]. Le modèle OpenRouter a son propre sélecteur. */
const SERVICE_GROUPS = [
  ['Catalogue et fiches', 'Catalogues, fiches, notes et visuels.', [
    ['tmdbToken', 'Jeton TMDB (lecture v4)', 'Requis pour les catalogues, les fiches et les recommandations.'],
    ['tmdbApiKey', 'Clé API TMDB (v3)', 'Facultative.'],
    ['mdblistApiKey', 'Clé MDBList', 'Notes IMDb, Rotten Tomatoes, Metacritic, Letterboxd.'],
    ['fanartApiKey', 'Clé Fanart.tv', 'Logos et visuels. Facultative.'],
  ]],
  ['Séries', 'Saisons et prochain épisode.', [
    ['tvdbApiKey', 'Clé TheTVDB', 'Clé v4 personnelle, ou clé legacy de 32 caractères hexadécimaux.'],
    ['tvdbPin', 'PIN d’abonné TheTVDB', 'Seulement avec une clé v4 personnelle.'],
  ]],
  ['Recommandations IA', 'Recommandations et textes sur les personnes (facturés par OpenRouter).', [
    ['openrouterApiKey', 'Clé OpenRouter', ''],
    [MODEL, 'Modèle OpenRouter', 'Utilisé pour tous les comptes.'],
  ]],
  ['Repères de saut', 'Intro, récapitulatif et générique. Facultatives : sans clé, les repères se lisent quand même.', [
    ['introdbApiKey', 'Clé IntroDB', 'Avec une clé, les propositions de repères sont aussi envoyées à IntroDB.'],
    ['skipdbApiKey', 'Clé SkipDB', 'Avec une clé, les propositions de repères sont aussi envoyées à SkipDB.'],
    ['animeskipClientId', 'Client ID Anime Skip', 'Repères des séries d’animation.'],
  ]],
];

const SOURCE_LABEL = { db: 'Administration', env: 'Variable du serveur' };

/** Texte du champ vide : ce qui est en place aujourd'hui. */
export function keyPlaceholder(st) {
  if (!st || !st.set) return 'Non définie';
  const tail = st.last4 ? ' (' + st.last4 + ')' : '';
  return st.source === 'env' ? 'Variable du serveur' + tail + ' : saisis une clé pour la remplacer' : 'Enregistrée' + tail;
}

function sourceBadge(st) {
  if (!st || !st.set) return badge('Non définie', '');
  return badge(SOURCE_LABEL[st.source] || st.source, st.source === 'db' ? 'ok' : '');
}

function keyRow(field, label, desc, st) {
  const clear = st && st.source === 'db'
    ? '<button type="button" class="btn btn-ghost btn-sm" data-adm-svc-clear="' + esc(field) + '" data-adm-focus="svc-clear:' + esc(field) + '">Effacer</button>'
    : '';
  return fieldRow(label, desc, (id) => '<div class="adm-svc-row">' +
    '<input class="set-input" id="' + id + '" type="password" name="svc.' + esc(field) + '" autocomplete="off" spellcheck="false" placeholder="' + esc(keyPlaceholder(st)) + '" data-adm-focus="svc:' + esc(field) + '">' +
    sourceBadge(st) + clear + '</div>', { stack: true });
}

function modelRow(label, desc, st) {
  return fieldRow(label, desc + (st && st.set ? '' : ' Non défini ici : chaque compte garde son modèle, sinon ' + DEFAULT_MODEL + '.'),
    (id) => modelComboHTML(id, (st && st.value) || DEFAULT_MODEL), { stack: true });
}

export function servicesHTML(S) {
  const importBtn = '<button type="button" class="btn btn-ghost btn-sm" data-adm-svc-import data-adm-focus="svc-import">Importer depuis mon compte</button>';
  return sectionHead('Clés des services', 'Clés partagées par tous les comptes. Elles ne quittent jamais le serveur.', importBtn) +
    loaded(S.serviceKeys, (r) => {
      const keys = r.services || {};
      return '<form id="adm-svc" class="set-form adm-settings" autocomplete="off">' +
        '<p class="adm-banner" role="note">Une clé enregistrée ici passe avant la variable du serveur, qui passe avant la clé saisie dans un compte. Laisse un champ vide pour garder la clé en place.</p>' +
        SERVICE_GROUPS.map(([title, desc, fields]) => admCard(title, fields.map(([f, l, d]) => (f === MODEL ? modelRow(l, d, keys[f]) : keyRow(f, l, d, keys[f]))).join(''), { desc })).join('') +
        '<p class="set-msg" id="adm-svc-msg" role="status"></p><div class="set-actions"><button type="submit" class="btn btn-primary">Enregistrer</button></div></form>';
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
  ctx.S.serviceKeys = { status: 'ready', error: '', value: { services } };
  ctx.paint();
}

async function save(ctx, root, form) {
  const say = (t) => { const m = root.querySelector('#adm-svc-msg'); if (m) m.textContent = t; };
  const cur = ctx.S.serviceKeys && ctx.S.serviceKeys.value ? ctx.S.serviceKeys.value.services : {};
  const patch = servicesPatch(form, cur);
  if (!Object.keys(patch).length) { say('Rien à enregistrer.'); return; }
  say('Enregistrement…');
  let res;
  if (await attempt(async () => { res = await api.putServiceKeys(patch); }, say)) {
    applyKeys(ctx, res.services);
    toast('Clés des services enregistrées');
  }
}

async function clearKey(ctx, field) {
  const label = SERVICE_GROUPS.flatMap((g) => g[2]).find(([f]) => f === field);
  if (!(await confirmDialog({ title: 'Effacer la clé', message: 'La clé <strong>' + esc(label ? label[1] : field) + '</strong> enregistrée dans l’administration sera effacée. La variable du serveur, puis la clé de chaque compte, prendront le relais.', confirmLabel: 'Effacer', danger: true }))) return;
  let res;
  if (await attempt(async () => { res = await api.putServiceKeys({ [field]: null }); }, toast)) {
    applyKeys(ctx, res.services);
    toast('Clé effacée');
  }
}

async function importKeys(ctx) {
  if (!(await confirmDialog({ title: 'Importer depuis mon compte', message: 'Les clés enregistrées dans les réglages de ton compte remplacent celles de l’administration, pour tous les comptes. Les clés absentes de ton compte restent telles quelles.', confirmLabel: 'Importer' }))) return;
  let res;
  if (!(await attempt(async () => { res = await api.importServiceKeys(); }, toast))) return;
  applyKeys(ctx, res.services);
  const n = (res.imported || []).length;
  toast(n ? n + (n > 1 ? ' clés importées' : ' clé importée') : 'Aucune clé à importer dans ton compte');
}

function bindServices(root, ctx) {
  const form = root.querySelector('#adm-svc');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); save(ctx, root, form); });
  root.querySelectorAll('[data-adm-svc-clear]').forEach((b) => b.addEventListener('click', () => clearKey(ctx, b.dataset.admSvcClear)));
  const imp = root.querySelector('[data-adm-svc-import]');
  if (imp) imp.addEventListener('click', () => importKeys(ctx));
}

export const servicesSections = [
  {
    id: 'services', group: 'platform', label: 'Clés des services', icon: 'lock', render: servicesHTML, bind: bindServices,
    load: (ctx, quiet) => loadInto(ctx, 'serviceKeys', () => api.getServiceKeys(), quiet),
  },
];
