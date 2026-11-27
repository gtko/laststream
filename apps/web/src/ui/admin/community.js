/* Espace Communauté : watch parties (salons actifs, fermeture forcée) et modération (messages de salon signalés). */
import * as api from '../../data/adminApi';
import { fmtAgo, fmtInt } from '../../data/adminModel';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { esc } from '../util.js';
import { attempt, badge, empty, loaded, sectionHead, table } from './common.js';
import { t } from '../../i18n';

// ---------- Watch parties ----------
function partiesHTML(S) {
  return sectionHead(t('Watch parties'), t('Salons ouverts en ce moment, privés compris.'), '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>' + t('Actualiser') + '</button>') +
    loaded(S.rooms, (r) => (!r.rooms.length ? empty(t('Aucun salon actif.')) :
      table(t('Salons actifs'), [t('Titre'), t('Hôte'), { label: t('Participants'), num: true }, t('Visibilité'), t('Ouvert'), t('Action')],
        r.rooms.map((x) => ({ cells: [esc(x.title || x.id), esc(x.host), fmtInt(x.participants) + (x.maxParticipants ? ' / ' + fmtInt(x.maxParticipants) : ''),
          x.visibility === 'public' ? badge(t('Public'), 'ok') : badge(t('Privé')), esc(fmtAgo(x.createdAt)),
          '<button type="button" class="btn btn-danger btn-sm" data-adm-closeroom="' + esc(x.id) + '" data-title="' + esc(x.title || x.id) + '">' + t('Fermer') + '</button>'] })))));
}

async function closeRoom(ctx, id, title) {
  if (!(await confirmDialog({ title: t('Fermer le salon'), message: t('Le salon <strong>{title}</strong> sera fermé de force : tous les participants seront déconnectés.', { title: esc(title) }), confirmLabel: t('Fermer le salon'), danger: true }))) return;
  if (await attempt(() => api.closeRoom(id), toast)) { toast(t('Salon fermé')); ctx.refresh(true); }
}

function bindParties(root, ctx) {
  root.querySelectorAll('[data-adm-closeroom]').forEach((b) => b.addEventListener('click', () => closeRoom(ctx, b.dataset.admCloseroom, b.dataset.title)));
}

// ---------- Modération ----------
const REPORT_TABS = [['open', t('À traiter')], ['deleted', t('Supprimés')], ['suspended', t('Auteur suspendu')], ['ignored', t('Ignorés')]];

function moderationHTML(S) {
  const tabs = '<div class="pills" role="group" aria-label="' + t('Statut des signalements') + '" data-nav>' + REPORT_TABS.map(([v, l]) =>
    '<button type="button" class="pill" data-adm-repstatus="' + v + '" data-adm-focus="rep:' + v + '" aria-pressed="' + (S.repStatus === v) + '">' + l + '</button>').join('') + '</div>';
  return sectionHead(t('Modération'), t('Messages de salon signalés par les participants.'), '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>' + t('Actualiser') + '</button>') + tabs +
    loaded(S.reports, (r) => (!r.reports.length ? empty(t('Aucun signalement dans cette liste.')) :
      '<ul class="adm-reports">' + r.reports.map((x) => '<li class="adm-report" data-nav><div class="adm-report-h"><strong>' + esc(x.against || t('auteur inconnu')) + '</strong> ' +
        '<span class="adm-dim">' + t('signalé par {v} ·', { v: esc(x.by || '?') }) + ' ' + esc(fmtAgo(x.at)) + (x.reason ? ' ' + t('· motif : {reason}', { reason: esc(x.reason) }) : '') + '</span></div>' +
        '<blockquote class="adm-quote">' + (x.text ? esc(x.text) : t('<em>Message indisponible</em>')) + '</blockquote>' +
        '<p class="adm-dim">' + t('Salon <code>{roomId}</code> · message <code>{messageId}</code>', { roomId: esc(x.roomId), messageId: esc(x.messageId) }) + '</p>' +
        (x.status === 'open' ? '<div class="adm-actions"><button type="button" class="btn btn-ghost btn-sm" data-adm-rep="' + esc(x.id) + ':delete">' + t('Supprimer le message') + '</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-adm-rep="' + esc(x.id) + ':suspend" data-who="' + esc(x.against) + '">' + t('Suspendre l’auteur') + '</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-adm-rep="' + esc(x.id) + ':ignore">' + t('Ignorer') + '</button></div>' : '<p>' + badge(x.status) + '</p>') + '</li>').join('') + '</ul>'));
}

async function reportAction(ctx, id, action, who) {
  if (action === 'delete' && !(await confirmDialog({ title: t('Supprimer le message'), message: t('Le message signalé sera retiré du salon pour tous les participants.'), confirmLabel: t('Supprimer'), danger: true }))) return;
  if (action === 'suspend' && !(await confirmDialog({ title: t('Suspendre l’auteur'), message: t('Le compte <strong>{v}</strong> sera suspendu : connexion refusée et sessions révoquées.', { v: esc(who || t('de l’auteur')) }), confirmLabel: t('Suspendre'), danger: true }))) return;
  const ok = await attempt(() => api.reportAction(id, action), toast);
  if (ok) toast(action === 'delete' ? t('Message supprimé') : action === 'suspend' ? t('Auteur suspendu') : t('Signalement ignoré'));
  if (ok || ctx.S.reports.status === 'ready') ctx.refresh(true);
}

function bindModeration(root, ctx) {
  root.querySelectorAll('[data-adm-repstatus]').forEach((b) => b.addEventListener('click', () => {
    ctx.S.repStatus = b.dataset.admRepstatus;
    ctx.refresh(false);
  }));
  root.querySelectorAll('[data-adm-rep]').forEach((b) => b.addEventListener('click', () => {
    const [id, action] = b.dataset.admRep.split(':');
    reportAction(ctx, id, action, b.dataset.who);
  }));
}

export const communitySections = [
  {
    id: 'parties', group: 'community', label: t('Watch parties'), icon: 'party', render: partiesHTML, bind: bindParties,
    load: (ctx, quiet) => ctx.fetch('rooms', () => api.listRooms(), quiet),
  },
  {
    id: 'moderation', group: 'community', label: t('Modération'), icon: 'flag', render: moderationHTML, bind: bindModeration,
    load: (ctx, quiet) => ctx.fetch('reports', () => api.listReports(ctx.S.repStatus), quiet),
  },
];
