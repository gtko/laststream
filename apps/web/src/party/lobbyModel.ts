import type { Lang } from '../data/stream';
import type { PartyParticipant } from '../data/socialApi';
import { sourceKeyOf, type SourceView } from '../sources/info';
import { groupReleases, providerOf, releaseName, sourceDetail } from '../sources/release';
import { languageChanged, sourceLabel } from './sourceChoice';
import {
  COUNTDOWN_DEFAULT_SEC, type ControlMode, type EventKind, type ReactionMode, type VoteView, type WaitLateMode,
} from './protocol';
import { t as tr } from '../i18n';

/* Modèle du salon d'attente et de l'affichage en lecture (Social v3) : fonctions pures, sans DOM ni réseau, testées. */

export type PrepView = { state: 'ready' | 'searching' | 'buffering'; label: string };

/** Libellés des réglages de l'hôte, dans l'ordre de la maquette. */
export const CONTROL_OPTIONS: ReadonlyArray<readonly [ControlMode, string]> = [['all', tr('Tout le monde')], ['host', tr('L’hôte')]];
export const WAIT_LATE_OPTIONS: ReadonlyArray<readonly [WaitLateMode, string]> = [['off', tr('Non')], ['10s', tr('10 s max')], ['always', tr('Toujours')]];
export const REACTION_OPTIONS: ReadonlyArray<readonly [ReactionMode, string]> = [['float', tr('Flottantes')], ['discreet', tr('Discrètes')], ['off', tr('Off')]];


/** Initiales d'un avatar sans illustration : une lettre pour un compte, deux pour un invité (comme la maquette). */
export function initialsOf(name: string, guest = false): string {
  const chars = Array.from(String(name ?? '').trim());
  if (chars.length === 0) return '?';
  return chars.slice(0, guest ? 2 : 1).join('').toLocaleUpperCase('fr');
}

/** Qualité exploitable : vide si la chaîne n'a ni lettre ni chiffre (« ? » d'une résolution inconnue). */
function knownQuality(q: unknown): string {
  const t = typeof q === 'string' ? q.trim() : '';
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/**
 * État de préparation d'un participant. Un invité (lien partagé) ne déclare rien : il est « Prêt · via le lien ». Un
 * serveur antérieur n'envoie aucun état : tout le monde est prêt.
 */
export type PrepSource = Partial<Pick<PartyParticipant, 'ready' | 'quality' | 'status'>> & { guest?: boolean };

export function prepView(p: PrepSource): PrepView {
  const quality = knownQuality(p.quality);
  if (p.status === 'buffering') return { state: 'buffering', label: tr('Tampon en cours…') };
  if (p.status === 'searching') return { state: 'searching', label: tr('Cherche une source…') };
  if (p.ready === false) return { state: 'searching', label: tr('Pas encore prêt') };
  if (quality) return { state: 'ready', label: tr('Prêt · {quality}', { quality }) };
  return { state: 'ready', label: p.guest ? tr('Prêt · via le lien') : tr('Prêt') };
}

/** Qualité annoncée au salon pour la source choisie : « 4K HDR », « 1080p » (40 caractères au plus, comme le serveur). */
export function qualityLabel(view: { quality?: string | null; hdr?: readonly string[] | null } | null | undefined): string {
  if (!view) return '';
  const q = knownQuality(view.quality);
  const hdr = Array.isArray(view.hdr) && typeof view.hdr[0] === 'string' ? view.hdr[0].trim() : '';
  return [q, hdr].filter(Boolean).join(' ').slice(0, 40);
}

export interface ReadySummary {
  ready: number;
  total: number;
  /** Pseudos des participants pas encore prêts. */
  waiting: string[];
}

export function readySummary(list: readonly (PrepSource & Pick<PartyParticipant, 'username'>)[]): ReadySummary {
  const waiting = list.filter((p) => prepView(p).state !== 'ready').map((p) => p.username);
  return { ready: list.length - waiting.length, total: list.length, waiting };
}

/** « 3 prêts sur 4 » (ou « Tout le monde est prêt »). */
export function readyText(sum: ReadySummary): string {
  if (sum.total > 0 && sum.ready === sum.total) return sum.total === 1 ? tr('Tu es prêt') : tr('Tout le monde est prêt');
  return sum.ready + (sum.ready > 1 ? ' ' + tr('prêts') : ' ' + tr('prêt')) + ' sur ' + sum.total;
}

/** Libellé du bouton « Démarrer sans … » (un pseudo, ou le nombre de retardataires). */
export function startWithoutText(waiting: readonly string[]): string {
  if (waiting.length === 0) return '';
  return waiting.length === 1 ? tr('Démarrer sans {v}', { v: waiting[0] }) : tr('Démarrer sans {length} personnes', { length: waiting.length });
}

/** Libellé du bouton de départ avec compte à rebours (« Lancer dans 5 s »). */
export const launchText = (sec: number = COUNTDOWN_DEFAULT_SEC): string => tr('Lancer dans {sec} s', { sec });

/** Secondes restantes avant le départ (arrondi supérieur, jamais négatif) ; null hors compte à rebours. */
export function countdownLeft(at: number | null, serverNow: number): number | null {
  if (at === null || !Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - serverNow) / 1000));
}

/** Position du film en « 1:12:34 » ou « 12:34 ». */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
}

/** Durée d'un saut : « 10 s », « 1 min 30 s ». */
export function formatDelta(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ' min' + (r ? ' ' + r + ' s' : '');
}

/** Phrase d'un événement du salon : « Hugo a reculé de 10 s ». */
export function eventText(ev: { kind: EventKind; by: string; pos: number; delta?: number }): string {
  switch (ev.kind) {
    case 'pause': return tr('{by} a mis en pause · {pos}', { by: ev.by, pos: formatTimecode(ev.pos) });
    case 'play': return tr('{by} a relancé la lecture', { by: ev.by });
    case 'seek': {
      const d = typeof ev.delta === 'number' && Number.isFinite(ev.delta) ? ev.delta : 0;
      if (d < 0) return tr('{by} a reculé de {d}', { by: ev.by, d: formatDelta(d) });
      if (d > 0) return tr('{by} a avancé de {d}', { by: ev.by, d: formatDelta(d) });
      return tr('{by} a changé de position · {pos}', { by: ev.by, pos: formatTimecode(ev.pos) });
    }
    case 'join': return tr('{by} a rejoint le salon', { by: ev.by });
    case 'leave': return tr('{by} a quitté le salon', { by: ev.by });
    default: return '';
  }
}

/** Les actions qui touchent la lecture de tous : affichées en bandeau avec « pour tout le monde ». */
export const isPlaybackEvent = (kind: EventKind): boolean => kind === 'pause' || kind === 'play' || kind === 'seek';

/** Écart de synchronisation : « Synchronisés · écart 0,2 s » (ou « Synchronisés » sans mesure). */
export function syncText(drift: number | null): { ok: boolean; text: string } {
  if (drift === null || !Number.isFinite(drift)) return { ok: true, text: tr('Synchronisés') };
  const abs = Math.abs(drift);
  const shown = (Math.round(abs * 10) / 10).toFixed(1).replace('.', ',');
  if (abs >= 1.5) return { ok: false, text: tr('Resynchronisation… écart {shown} s', { shown }) };
  return { ok: true, text: tr('Synchronisés · écart {shown} s', { shown }) };
}

/** Part d'une option dans les voix (0 à 100) ; 0 sans aucune voix. */
export function voteShare(option: Pick<VoteView, 'votes'>, options: readonly Pick<VoteView, 'votes'>[]): number {
  const total = options.reduce((sum, o) => sum + o.votes, 0);
  return total > 0 ? Math.round((option.votes / total) * 100) : 0;
}

/** Réactions de la barre de lecture : sous-ensemble de la liste du salon (REACTIONS), la maquette en montre cinq ou six. */
export const STAGE_EMOJIS = ['😂', '🔥', '😮', '❤️', '👏', '🎉'] as const;
/** Réactions rapides du salon d'attente. */
export const LOBBY_EMOJIS = ['👍', '🎉', '🔥', '😂'] as const;

// ---------- Source du participant (« Ma source ») ----------
/** Ligne de la liste des sources du salon d'attente. Aucun lien : seulement ce qui s'affiche. */
export interface SourceRow {
  /** Identifiant stable de la source (`sourceKeyOf`), l'index change à chaque réponse d'addon. */
  key: string;
  /** « VF · 1080p ». */
  label: string;
  /** « En cache · 4,2 Go ». */
  meta: string;
  selected: boolean;
  /** `host` : même version que l'hôte ; `other` : autre langue que le salon ; null sinon. */
  badge: 'host' | 'other' | null;
  /** Pourquoi cette source ne passe pas dans ce navigateur (ligne d'avertissement), null si elle passe. */
  warn: string | null;
  /** Addon ou fournisseur d'origine (« Lumpi », « StreamFusion · AllDebrid ») ; vide si inconnu. */
  provider: string;
  /** Autres fournisseurs qui proposent la même release (regroupés sur cette ligne, essayés en premier au repli). */
  others: number;
  /** Nom du fichier ou de la release ; vide si inconnu. */
  release: string;
  /** « WEB-DL · HEVC · DV · EAC3 5.1 · 12,4 Mb/s · 85 seeders » (ce qui est connu). */
  detail: string;
}

const SOURCE_ROWS_MAX = 8;
export const SOURCE_BADGE_TEXT = { host: tr('Même version que l’hôte'), other: tr('Autre langue que le salon') } as const;

const STATUS_TEXT: Record<string, string> = { cached: tr('En cache'), uncached: tr('À la demande'), direct: tr('Direct') };

/**
 * Lignes jouables, au plus SOURCE_ROWS_MAX. Une ligne ne change jamais de place sous le doigt ni sous le focus : `opts.order`
 * garde l'ordre des clés déjà affichées (la meilleure source d'abord au premier sondage), les nouvelles viennent à la suite. Le
 * tableau est mis à jour sur place ; l'appelant le garde le temps du titre et le vide quand le titre change. Une sélection qui
 * sort des lignes affichées prend la dernière place.
 */
export function buildSourceRows(
  views: readonly SourceView[],
  opts: { selectedKey: string; hostLabel: string | null; roomLanguage: Lang | null; compat?: (v: SourceView) => string | null; order?: string[] },
): SourceRow[] {
  const sorted: SourceView[] = [];
  const seen = new Set<string>();
  for (const v of [...views].filter((x) => x.playable).sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (!seen.has(sourceKeyOf(v))) { seen.add(sourceKeyOf(v)); sorted.push(v); }
  }
  // Une ligne par release : les doublons d'autres fournisseurs s'y regroupent. La source affichée reste celle déjà choisie ou
  // déjà affichée (sa clé ne change pas d'un sondage à l'autre), sinon la mieux classée.
  const shownBefore = opts.order ?? [];
  const groups = groupReleases(sorted, (members) => members.find((m) => sourceKeyOf(m) === opts.selectedKey)
    ?? members.map((m) => ({ m, at: shownBefore.indexOf(sourceKeyOf(m)) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0]?.m);
  const byKey = new Map(groups.map((g) => [sourceKeyOf(g.lead), g] as const));
  const order = opts.order ?? [];
  for (const key of byKey.keys()) if (!order.includes(key)) order.push(key);
  const keys = order.filter((key) => byKey.has(key));
  const top = keys.slice(0, SOURCE_ROWS_MAX);
  if (byKey.has(opts.selectedKey) && !top.includes(opts.selectedKey)) top[top.length - 1] = opts.selectedKey;
  const shown = top.map((key) => byKey.get(key)!);
  return shown.map(({ lead: v, others }) => {
    const label = sourceLabel(v);
    const badge = opts.hostLabel && label === opts.hostLabel ? 'host' : languageChanged(v, opts.roomLanguage) ? 'other' : null;
    return {
      key: sourceKeyOf(v),
      label,
      meta: [STATUS_TEXT[v.status] ?? '', v.sizeLabel].filter(Boolean).join(' · '),
      selected: sourceKeyOf(v) === opts.selectedKey,
      badge,
      warn: opts.compat?.(v) ?? null,
      provider: providerOf(v),
      others,
      release: releaseName(v),
      detail: sourceDetail(v),
    };
  });
}

/** « Hôte : VF · 1080p » ; null sans libellé (l'hôte n'est pas prêt) ou pour l'hôte lui-même. */
export const hostSourceLine = (hostLabel: string | null | undefined): string | null => (hostLabel ? tr('Hôte : {hostLabel}', { hostLabel }) : null);

/** Statut de la recherche de sources du participant. */
export function sourceSearchText(count: number, searching: boolean): string {
  if (searching) return count > 0 ? tr('Recherche en cours… {count}', { count }) + (count > 1 ? ' sources' : ' source') : tr('Recherche en cours…');
  return count > 0 ? count + (count > 1 ? ' ' + tr('sources trouvées') : ' ' + tr('source trouvée')) : tr('Aucune source trouvée');
}

/** Avertissement quand la source choisie n'est pas dans la langue du salon ; null sinon. */
export function sourceLanguageWarning(view: SourceView | null, roomLanguage: Lang | null, roomName: string): string | null {
  return view && languageChanged(view, roomLanguage) ? tr('Cette source n’est pas dans la langue du salon ({roomName}) : tu la liras dans une autre langue.', { roomName }) : null;
}

/** Vrai si des sources existent mais aucune dans la langue du salon (bandeau « Réessayer la recherche »). */
export function noSourceInRoomLanguage(views: readonly SourceView[], roomLanguage: Lang | null): boolean {
  const playable = views.filter((v) => v.playable);
  return !!roomLanguage && playable.length > 0 && playable.every((v) => languageChanged(v, roomLanguage));
}
