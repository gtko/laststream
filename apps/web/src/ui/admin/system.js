/* Espace Système : réglages du serveur et maintenance (enregistrement après confirmation), annonces (liste, formulaire, activation,
 * suppression), journal d’audit (filtre, pagination). */
import * as api from '../../data/adminApi';
import { fmtDateTime, toMs } from '../../data/adminModel';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { fieldRow, switchRow } from '../settings-ui.js';
import { esc } from '../util.js';
import { admCard, attempt, badge, bindPager, empty, loaded, pager, sectionHead, table } from './common.js';
import { loadInto } from './view-state.js';

// ---------- Réglages du serveur ----------
export function settingsHTML(S) {
  return sectionHead('Réglages et maintenance', 'Ces réglages s’appliquent à tout le serveur et à tous les comptes.') +
    loaded(S.settings, (s) =>
      '<form id="adm-settings" class="set-form adm-settings" autocomplete="off">' +
      '<p class="adm-banner is-warn" role="note"><strong>Attention.</strong> Fermer les inscriptions bloque les nouveaux comptes (les liens ne sont pas consommés). Activer la maintenance fait répondre « 503 » à tout le monde sauf toi : tous les utilisateurs perdent l’accès tant qu’elle est active.</p>' +
      admCard('Inscriptions', fieldRow('Quota par défaut', 'Nombre de liens d’invitation donné aux nouveaux comptes (0 à 100). Les comptes existants gardent le leur.', (id) => '<input class="set-input set-input-sm" id="' + id + '" type="number" name="quota" min="0" max="100" value="' + esc(s.inviteDefaultQuota) + '" required data-adm-focus="set:quota">') +
        switchRow('Inscriptions par invitation ouvertes', 'Désactivé : les liens d’invitation sont refusés.', !!s.invitesOpen, 'name="invitesOpen"')) +
      admCard('Mode maintenance', switchRow('Activer la maintenance', 'Le serveur répond 503 à tous sauf à l’administration. Exige ton mot de passe.', !!s.maintenance.enabled, 'name="maintenance"') +
        fieldRow('Message affiché', 'Montré aux utilisateurs pendant la maintenance.', (id) => '<textarea class="set-input adm-textarea" id="' + id + '" name="message" rows="3" maxlength="300" data-adm-focus="set:message">' + esc(s.maintenance.message || '') + '</textarea>', { stack: true }),
      { aside: s.maintenance.enabled ? badge('Maintenance active', 'warn') : '' }) +
      '<p class="set-msg" id="adm-settings-msg" role="status"></p><div class="set-actions"><button type="submit" class="btn btn-primary">Enregistrer</button></div></form>');
}

/** Enregistre les réglages modifiés ; les changements sensibles (fermeture des inscriptions, maintenance) demandent confirmation. */
async function saveSettings(ctx, root, f) {
  const say = (t) => { const m = root.querySelector('#adm-settings-msg'); if (m) m.textContent = t; };
  const old = ctx.S.settings.value;
  if (!old) return;
  const quota = Number(f.elements.quota.value);
  if (!Number.isInteger(quota) || quota < 0 || quota > 100) { say('Le quota par défaut va de 0 à 100.'); return; }
  const on = (n) => f.elements[n].getAttribute('aria-checked') === 'true';
  const patch = {};
  if (quota !== old.inviteDefaultQuota) patch.inviteDefaultQuota = quota;
  if (on('invitesOpen') !== !!old.invitesOpen) patch.invitesOpen = on('invitesOpen');
  const mEnabled = on('maintenance');
  const mMsg = f.elements.message.value.trim();
  if (mEnabled !== !!old.maintenance.enabled || mMsg !== (old.maintenance.message || '')) patch.maintenance = { enabled: mEnabled, message: mMsg };
  if (!Object.keys(patch).length) { say('Rien à enregistrer.'); return; }
  if (patch.invitesOpen === false && !(await confirmDialog({ title: 'Fermer les inscriptions', message: 'Les liens d’invitation seront refusés : personne ne pourra créer de compte tant que les inscriptions sont fermées.', confirmLabel: 'Fermer les inscriptions', danger: true }))) return;
  if (patch.maintenance && patch.maintenance.enabled && !old.maintenance.enabled && !(await confirmDialog({ title: 'Activer la maintenance', message: '<strong>Tout le serveur répondra « 503 »</strong> à tous les utilisateurs sauf à l’administration. Tu devras confirmer avec ton mot de passe.', confirmLabel: 'Activer la maintenance', danger: true }))) return;
  say('Enregistrement…');
  let res;
  if (await attempt(async () => { res = await api.putSettings(patch); }, say)) {
    ctx.S.settings = { status: 'ready', error: '', value: res && res.maintenance ? res : { ...old, ...patch, maintenance: { ...old.maintenance, ...(patch.maintenance || {}) } } };
    ctx.paint();
    say('Réglages enregistrés (' + fmtDateTime(Date.now()) + ').');
    toast('Réglages du serveur enregistrés');
  }
}

function bindSettings(root, ctx) {
  const form = root.querySelector('#adm-settings');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); saveSettings(ctx, root, form); });
}

// ---------- Annonces ----------
export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_MESSAGE_MAX = 500;
const LEVEL_LABEL = { info: 'Information', warning: 'Attention' };
const STATE_BADGE = { active: ['Active', 'ok'], planned: ['Planifiée', ''], expired: ['Expirée', ''], off: ['Désactivée', ''] };

/** État d'une annonce à l'instant `now` : désactivée (sans regarder les dates), planifiée, expirée ou active. */
export function announcementState(a, now = Date.now()) {
  if (!a.active) return 'off';
  const start = a.startsAt ? toMs(a.startsAt) : NaN;
  const end = a.endsAt ? toMs(a.endsAt) : NaN;
  if (Number.isFinite(start) && now < start) return 'planned';
  if (Number.isFinite(end) && now >= end) return 'expired';
  return 'active';
}

/** Fenêtre d'affichage en clair : « Sans limite », « Dès … », « Jusqu’au … » ou « … → … ». */
export function announcementWindow(a) {
  const s = a.startsAt ? fmtDateTime(a.startsAt) : null;
  const e = a.endsAt ? fmtDateTime(a.endsAt) : null;
  if (s && e) return s + ' → ' + e;
  if (s) return 'Dès ' + s;
  if (e) return 'Jusqu’au ' + e;
  return 'Sans limite';
}

/** Valeur d'un champ datetime-local (heure locale, sans fuseau) pour un instant ISO ; vide si absent. */
export function toLocalInput(iso) {
  const t = iso ? toMs(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** Instant ISO (UTC) d'une valeur datetime-local ; null si vide, undefined si invalide. */
export function fromLocalInput(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Contrôle du formulaire : `error` en français, ou `body` prêt pour l'API (titre et message rognés, dates en ISO ou null). */
export function announcementInput(raw) {
  const title = String(raw.title ?? '').trim();
  const message = String(raw.message ?? '').trim();
  const startsAt = fromLocalInput(raw.startsAt);
  const endsAt = fromLocalInput(raw.endsAt);
  let error = null;
  if (!title || title.length > ANNOUNCEMENT_TITLE_MAX) error = 'Le titre est requis (' + ANNOUNCEMENT_TITLE_MAX + ' caractères au plus).';
  else if (!message || message.length > ANNOUNCEMENT_MESSAGE_MAX) error = 'Le message est requis (' + ANNOUNCEMENT_MESSAGE_MAX + ' caractères au plus).';
  else if (!Object.hasOwn(LEVEL_LABEL, raw.level)) error = 'Choisis un niveau.';
  else if (startsAt === undefined || endsAt === undefined) error = 'Date invalide.';
  else if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) error = 'La fin doit être postérieure au début.';
  return { error, body: error ? null : { title, message, level: raw.level, startsAt, endsAt } };
}

const annList = (S) => (S.announcements && S.announcements.status === 'ready' && S.announcements.value && S.announcements.value.announcements) || [];

function formHTML(a) {
  const v = a || {};
  const levelOptions = Object.entries(LEVEL_LABEL).map(([k, l]) => '<option value="' + k + '"' + ((v.level || 'info') === k ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
  return admCard(a ? 'Modifier l’annonce' : 'Nouvelle annonce',
    '<form id="adm-ann-form" class="adm-form" data-ann-id="' + esc(a ? a.id : '') + '" novalidate>' +
    '<label class="adm-field"><span>Titre</span><input class="set-input" name="title" maxlength="' + ANNOUNCEMENT_TITLE_MAX + '" required autocomplete="off" value="' + esc(v.title || '') + '" data-adm-focus="ann:title"></label>' +
    '<label class="adm-field"><span>Message</span><textarea class="set-input adm-textarea" name="message" rows="3" maxlength="' + ANNOUNCEMENT_MESSAGE_MAX + '" required data-adm-focus="ann:message">' + esc(v.message || '') + '</textarea></label>' +
    '<label class="adm-field"><span>Niveau</span><select class="set-input" name="level" data-adm-focus="ann:level">' + levelOptions + '</select></label>' +
    '<div class="adm-ann-dates">' +
    '<label class="adm-field"><span>Début (facultatif)</span><input class="set-input" type="datetime-local" name="startsAt" value="' + esc(toLocalInput(v.startsAt)) + '" data-adm-focus="ann:startsAt"></label>' +
    '<label class="adm-field"><span>Fin (facultatif)</span><input class="set-input" type="datetime-local" name="endsAt" value="' + esc(toLocalInput(v.endsAt)) + '" data-adm-focus="ann:endsAt"></label>' +
    '</div>' +
    '<p class="adm-dim">Sans début, l’annonce part dès qu’elle est active. Sans fin, elle reste affichée.</p>' +
    '<p class="set-msg" id="adm-ann-msg" role="status"></p>' +
    '<div class="set-actions"><button type="submit" class="btn btn-primary">Enregistrer</button><button type="button" class="btn btn-ghost" data-adm-annclose>Annuler</button></div>' +
    '</form>', { desc: a ? 'Les changements s’appliquent dès l’enregistrement.' : 'Titre 80 caractères au plus, message 500 au plus.' });
}

export function announcementsHTML(S) {
  const list = annList(S);
  const editing = S.annEdit ? (S.annEdit === 'new' ? { id: '' } : list.find((a) => a.id === S.annEdit) || null) : null;
  const form = S.annEdit && (S.annEdit === 'new' || editing) ? formHTML(S.annEdit === 'new' ? null : editing) : '';
  return sectionHead('Annonces', 'Messages affichés aux utilisateurs dans l’application, avec début et fin facultatifs.',
    '<button type="button" class="btn btn-primary btn-sm" data-adm-annnew data-adm-focus="annnew">Nouvelle annonce</button>') +
    form +
    loaded(S.announcements, (r) => {
      const rows = (r.announcements || []).map((a) => {
        const st = STATE_BADGE[announcementState(a)];
        return { cells: [
          '<span class="adm-ann-t">' + esc(a.title) + '</span><span class="adm-dim adm-ann-m">' + esc(a.message) + '</span>',
          badge(LEVEL_LABEL[a.level] || a.level, a.level === 'warning' ? 'warn' : ''),
          esc(announcementWindow(a)),
          badge(st[0], st[1]),
          '<div class="adm-row-act">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-adm-annedit="' + esc(a.id) + '" data-adm-focus="edit:' + esc(a.id) + '">Modifier</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-adm-anntoggle="' + esc(a.id) + '" data-adm-focus="tog:' + esc(a.id) + '">' + (a.active ? 'Désactiver' : 'Activer') + '</button>' +
            '<button type="button" class="btn btn-danger btn-sm" data-adm-anndel="' + esc(a.id) + '" data-adm-focus="del:' + esc(a.id) + '">Supprimer</button>' +
          '</div>',
        ] };
      });
      return admCard('Annonces publiées', rows.length
        ? table('Annonces', ['Annonce', 'Niveau', 'Fenêtre', 'État', 'Actions'], rows, 'is-ann')
        : empty('Aucune annonce pour l’instant.'), { desc: 'Seules les annonces actives et dans leur fenêtre sont montrées aux utilisateurs.' });
    });
}

async function refreshAnnouncements(ctx) {
  await loadInto(ctx, 'announcements', () => api.listAnnouncements(), true);
}

async function saveAnnouncement(ctx, root, form) {
  const say = (t) => { const m = root.querySelector('#adm-ann-msg'); if (m) m.textContent = t; };
  const f = form.elements;
  const { error, body } = announcementInput({ title: f.title.value, message: f.message.value, level: f.level.value, startsAt: f.startsAt.value, endsAt: f.endsAt.value });
  if (error) { say(error); return; }
  const id = form.dataset.annId;
  say('Enregistrement…');
  if (!(await attempt(() => (id ? api.updateAnnouncement(id, body) : api.createAnnouncement(body)), say))) return;
  ctx.S.annEdit = null;
  if (ctx.isCurrent()) ctx.paint();
  toast('Annonce enregistrée');
  await refreshAnnouncements(ctx);
}

async function toggleAnnouncement(ctx, a) {
  if (await attempt(() => api.updateAnnouncement(a.id, { active: !a.active }), toast)) toast(a.active ? 'Annonce désactivée' : 'Annonce activée');
  await refreshAnnouncements(ctx);
}

async function removeAnnouncement(ctx, a) {
  const ok = await confirmDialog({ title: 'Supprimer l’annonce', message: 'L’annonce <strong>' + esc(a.title) + '</strong> ne sera plus affichée. Cette suppression est définitive.', confirmLabel: 'Supprimer', danger: true });
  if (!ok) return;
  if (await attempt(() => api.deleteAnnouncement(a.id), toast)) toast('Annonce supprimée');
  if (ctx.S.annEdit === a.id) ctx.S.annEdit = null;
  await refreshAnnouncements(ctx);
}

function bindAnnouncements(root, ctx) {
  const open = (value) => { ctx.S.annEdit = value; ctx.paint(); const first = root.querySelector('#adm-ann-form input[name="title"]'); if (first) first.focus(); };
  const byId = (id) => annList(ctx.S).find((a) => a.id === id);
  const bind = (sel, fn) => root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b.dataset)));
  bind('[data-adm-annnew]', () => open('new'));
  bind('[data-adm-annedit]', (d) => open(d.admAnnedit));
  bind('[data-adm-anntoggle]', (d) => { const a = byId(d.admAnntoggle); if (a) toggleAnnouncement(ctx, a); });
  bind('[data-adm-anndel]', (d) => { const a = byId(d.admAnndel); if (a) removeAnnouncement(ctx, a); });
  const cancel = root.querySelector('[data-adm-annclose]');
  if (cancel) cancel.addEventListener('click', () => { ctx.S.annEdit = null; ctx.paint(); });
  const form = root.querySelector('#adm-ann-form');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); saveAnnouncement(ctx, root, form); });
}

// ---------- Journal d’audit ----------
function detailText(d) {
  if (d == null || d === '') return '—';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch (_) { return '—'; }
}

export function auditHTML(S) {
  const filter = '<form class="adm-toolbar" data-adm-auditform data-nav><label class="adm-field adm-grow"><span class="sr-only">Filtrer par action</span><input class="set-input" name="action" value="' + esc(S.auditAction) + '" placeholder="Filtrer par action (ex. elevate.failed)" autocomplete="off" autocapitalize="none" data-adm-focus="audit:action"></label><button type="submit" class="btn btn-ghost btn-sm">Filtrer</button></form>';
  return sectionHead('Journal d’audit', 'Toutes les actions d’administration, y compris les ré-authentifications échouées. Jamais de mot de passe ni de jeton.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') + filter +
    loaded(S.audit, (r) => (!r.entries.length ? empty('Aucune entrée.') :
      table('Journal d’audit', ['Date', 'Acteur', 'Action', 'Cible', 'Détail'],
        r.entries.map((e) => ({ cells: [esc(fmtDateTime(e.at)), esc(e.actor), '<code>' + esc(e.action) + '</code>', esc(e.target || '—'), esc(detailText(e.detail))] })), 'is-audit') +
      pager('audit', S.auditPager.hasPrev, !!r.nextBefore)));
}

function bindAudit(root, ctx) {
  const form = root.querySelector('[data-adm-auditform]');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ctx.S.auditAction = form.elements.action.value.trim();
      ctx.S.auditPager.reset();
      ctx.refresh(false);
    });
  }
  bindPager(root, (which, dir) => {
    if (which !== 'audit') return;
    const data = ctx.S.audit.value;
    if (dir === 'next') { if (!ctx.S.auditPager.next(data && data.nextBefore)) return; } else if (!ctx.S.auditPager.prev()) return;
    ctx.refresh(false);
  });
}

export const systemSections = [
  {
    id: 'settings', group: 'system', label: 'Réglages', icon: 'sliders', render: settingsHTML, bind: bindSettings,
    load: (ctx, quiet) => ctx.fetch('settings', () => api.getSettings(), quiet),
  },
  {
    id: 'announcements', group: 'system', label: 'Annonces', icon: 'megaphone', render: announcementsHTML, bind: bindAnnouncements,
    load: (ctx, quiet) => loadInto(ctx, 'announcements', () => api.listAnnouncements(), quiet),
  },
  {
    id: 'audit', group: 'system', label: 'Journal d’audit', icon: 'scroll', render: auditHTML, bind: bindAudit,
    load: (ctx, quiet) => ctx.fetch('audit', () => api.listAudit({ limit: 50, before: ctx.S.auditPager.cursor, action: ctx.S.auditAction || undefined }), quiet),
  },
];
