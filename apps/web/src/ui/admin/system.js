/* Espace Système : réglages du serveur et maintenance (enregistrement après confirmation), annonces (à venir), journal d’audit (filtre, pagination). */
import * as api from '../../data/adminApi';
import { fmtDateTime } from '../../data/adminModel';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { fieldRow, switchRow } from '../settings-ui.js';
import { esc } from '../util.js';
import { admCard, attempt, badge, bindPager, empty, loaded, pager, sectionHead, soonPage, table } from './common.js';

// ---------- Réglages du serveur ----------
export function settingsHTML(S) {
  return sectionHead('Réglages et maintenance', 'Ces réglages s’appliquent à tout le serveur et à tous les comptes.') +
    loaded(S.settings, (s) =>
      '<form id="adm-settings" class="set-form adm-settings" autocomplete="off">' +
      '<p class="adm-banner is-warn" role="note"><strong>Attention.</strong> Fermer les inscriptions bloque les nouveaux comptes (les liens ne sont pas consommés). Activer la maintenance fait répondre « 503 » à tout le monde sauf toi : tous les utilisateurs perdent l’accès tant qu’elle est active.</p>' +
      admCard('Inscriptions', fieldRow('Quota par défaut', 'Nombre de liens d’invitation donné aux nouveaux comptes (0 à 100). Les comptes existants gardent le leur.', (id) => '<input class="set-input set-input-sm" id="' + id + '" type="number" name="quota" min="0" max="100" value="' + esc(s.inviteDefaultQuota) + '" required>') +
        switchRow('Inscriptions par invitation ouvertes', 'Désactivé : les liens d’invitation sont refusés.', !!s.invitesOpen, 'name="invitesOpen"')) +
      admCard('Mode maintenance', switchRow('Activer la maintenance', 'Le serveur répond 503 à tous sauf à l’administration. Exige ton mot de passe.', !!s.maintenance.enabled, 'name="maintenance"') +
        fieldRow('Message affiché', 'Montré aux utilisateurs pendant la maintenance.', (id) => '<textarea class="set-input adm-textarea" id="' + id + '" name="message" rows="3" maxlength="300">' + esc(s.maintenance.message || '') + '</textarea>', { stack: true }),
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

// ---------- Journal d’audit ----------
function detailText(d) {
  if (d == null || d === '') return '—';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch (_) { return '—'; }
}

export function auditHTML(S) {
  const filter = '<form class="adm-toolbar" data-adm-auditform data-nav><label class="adm-field adm-grow"><span class="sr-only">Filtrer par action</span><input class="set-input" name="action" value="' + esc(S.auditAction) + '" placeholder="Filtrer par action (ex. elevate.failed)" autocomplete="off" autocapitalize="none"></label><button type="submit" class="btn btn-ghost btn-sm">Filtrer</button></form>';
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
    id: 'settings', group: 'system', label: 'Réglages et maintenance', icon: 'sliders', render: settingsHTML, bind: bindSettings,
    load: (ctx, quiet) => ctx.fetch('settings', () => api.getSettings(), quiet),
  },
  { id: 'announcements', group: 'system', label: 'Annonces', icon: 'megaphone', render: () => soonPage('Annonces', 'Messages affichés aux utilisateurs, avec début et fin.') },
  {
    id: 'audit', group: 'system', label: 'Journal d’audit', icon: 'scroll', render: auditHTML, bind: bindAudit,
    load: (ctx, quiet) => ctx.fetch('audit', () => api.listAudit({ limit: 50, before: ctx.S.auditPager.cursor, action: ctx.S.auditAction || undefined }), quiet),
  },
];
