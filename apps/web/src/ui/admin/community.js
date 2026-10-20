/* Espace Communauté : watch parties (salons actifs, fermeture forcée) et modération (messages de salon signalés). */
import * as api from '../../data/adminApi';
import { fmtAgo, fmtInt } from '../../data/adminModel';
import { confirmDialog } from '../admin-dialog.js';
import { toast } from '../dom.js';
import { esc } from '../util.js';
import { attempt, badge, empty, loaded, sectionHead, table } from './common.js';

// ---------- Watch parties ----------
export function partiesHTML(S) {
  return sectionHead('Watch parties', 'Salons ouverts en ce moment, privés compris.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') +
    loaded(S.rooms, (r) => (!r.rooms.length ? empty('Aucun salon actif.') :
      table('Salons actifs', ['Titre', 'Hôte', { label: 'Participants', num: true }, 'Visibilité', 'Ouvert', 'Action'],
        r.rooms.map((x) => ({ cells: [esc(x.title || x.id), esc(x.host), fmtInt(x.participants) + (x.maxParticipants ? ' / ' + fmtInt(x.maxParticipants) : ''),
          x.visibility === 'public' ? badge('Public', 'ok') : badge('Privé'), esc(fmtAgo(x.createdAt)),
          '<button type="button" class="btn btn-danger btn-sm" data-adm-closeroom="' + esc(x.id) + '" data-title="' + esc(x.title || x.id) + '">Fermer</button>'] })))));
}

async function closeRoom(ctx, id, title) {
  if (!(await confirmDialog({ title: 'Fermer le salon', message: 'Le salon <strong>' + esc(title) + '</strong> sera fermé de force : tous les participants seront déconnectés.', confirmLabel: 'Fermer le salon', danger: true }))) return;
  if (await attempt(() => api.closeRoom(id), toast)) { toast('Salon fermé'); ctx.refresh(true); }
}

function bindParties(root, ctx) {
  root.querySelectorAll('[data-adm-closeroom]').forEach((b) => b.addEventListener('click', () => closeRoom(ctx, b.dataset.admCloseroom, b.dataset.title)));
}

// ---------- Modération ----------
const REPORT_TABS = [['open', 'À traiter'], ['deleted', 'Supprimés'], ['suspended', 'Auteur suspendu'], ['ignored', 'Ignorés']];

export function moderationHTML(S) {
  const tabs = '<div class="pills" role="group" aria-label="Statut des signalements" data-nav>' + REPORT_TABS.map(([v, l]) =>
    '<button type="button" class="pill" data-adm-repstatus="' + v + '" data-adm-focus="rep:' + v + '" aria-pressed="' + (S.repStatus === v) + '">' + l + '</button>').join('') + '</div>';
  return sectionHead('Modération', 'Messages de salon signalés par les participants.', '<button type="button" class="btn btn-ghost btn-sm" data-adm-reload>Actualiser</button>') + tabs +
    loaded(S.reports, (r) => (!r.reports.length ? empty('Aucun signalement dans cette liste.') :
      '<ul class="adm-reports">' + r.reports.map((x) => '<li class="adm-report" data-nav><div class="adm-report-h"><strong>' + esc(x.against || 'auteur inconnu') + '</strong> ' +
        '<span class="adm-dim">signalé par ' + esc(x.by || '?') + ' · ' + esc(fmtAgo(x.at)) + (x.reason ? ' · motif : ' + esc(x.reason) : '') + '</span></div>' +
        '<blockquote class="adm-quote">' + (x.text ? esc(x.text) : '<em>Message indisponible</em>') + '</blockquote>' +
        '<p class="adm-dim">Salon <code>' + esc(x.roomId) + '</code> · message <code>' + esc(x.messageId) + '</code></p>' +
        (x.status === 'open' ? '<div class="adm-actions"><button type="button" class="btn btn-ghost btn-sm" data-adm-rep="' + esc(x.id) + ':delete">Supprimer le message</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-adm-rep="' + esc(x.id) + ':suspend" data-who="' + esc(x.against) + '">Suspendre l’auteur</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-adm-rep="' + esc(x.id) + ':ignore">Ignorer</button></div>' : '<p>' + badge(x.status) + '</p>') + '</li>').join('') + '</ul>'));
}

async function reportAction(ctx, id, action, who) {
  if (action === 'delete' && !(await confirmDialog({ title: 'Supprimer le message', message: 'Le message signalé sera retiré du salon pour tous les participants.', confirmLabel: 'Supprimer', danger: true }))) return;
  if (action === 'suspend' && !(await confirmDialog({ title: 'Suspendre l’auteur', message: 'Le compte <strong>' + esc(who || 'de l’auteur') + '</strong> sera suspendu : connexion refusée et sessions révoquées.', confirmLabel: 'Suspendre', danger: true }))) return;
  const ok = await attempt(() => api.reportAction(id, action), toast);
  if (ok) toast(action === 'delete' ? 'Message supprimé' : action === 'suspend' ? 'Auteur suspendu' : 'Signalement ignoré');
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
    id: 'parties', group: 'community', label: 'Watch parties', icon: 'party', render: partiesHTML, bind: bindParties,
    load: (ctx, quiet) => ctx.fetch('rooms', () => api.listRooms(), quiet),
  },
  {
    id: 'moderation', group: 'community', label: 'Modération', icon: 'flag', render: moderationHTML, bind: bindModeration,
    load: (ctx, quiet) => ctx.fetch('reports', () => api.listReports(ctx.S.repStatus), quiet),
  },
];
