import type { SourceView } from './info';

/* Compatibilité d'une source avec la lecture dans le navigateur, sans serveur de streaming. Fonctions pures (contexte injecté), testées.
 *  - `ok`      : la vidéo et le son passent (lecture directe, conversion par un serveur, ou rien à savoir) ;
 *  - `check`   : le son est un Dolby que l'app doit décoder elle-même (réussit seulement si l'hébergeur autorise les plages) :
 *                jamais choisie automatiquement, mais lancée à la main si l'utilisateur le veut ;
 *  - `blocked` : la vidéo ou le son ne passera pas (codec vidéo absent, DTS / TrueHD, hébergeur refusé) : grisée, non sélectionnable. */
type WebCompatLevel = 'ok' | 'check' | 'blocked';

export interface WebCompat { level: WebCompatLevel; reason: string }

export interface WebCompatContext {
  /** Navigateur seul : ni coque Windows, ni application Android (leurs lecteurs lisent tout). */
  web: boolean;
  /** Un serveur de streaming convertit les sources (la conversion n'est alors pas un obstacle). */
  serverUp: boolean;
  /** Hôte déjà refusé par la sonde de plages (CORS) : son son ne peut pas être décodé par l'app. */
  rangeDenied: (url: string | undefined | null) => boolean;
}

const OK: WebCompat = { level: 'ok', reason: '' };

export function webCompatOf(v: SourceView, ctx: WebCompatContext): WebCompat {
  if (!ctx.web) return OK;
  if (v.badContainer && !ctx.serverUp) return { level: 'blocked', reason: 'Format ' + v.badContainer.toUpperCase() + ' non pris en charge par ce navigateur' };
  if (v.convert === 'video' && !ctx.serverUp) {
    return { level: 'blocked', reason: 'Vidéo ' + (v.codec || 'inconnue') + ' non prise en charge par ce navigateur' };
  }
  if (v.appAudio === 'unsupported') return { level: 'blocked', reason: 'Son DTS / TrueHD non pris en charge par ce navigateur' };
  if (v.appAudio === 'app') {
    if (ctx.rangeDenied(v.stream?.url)) return { level: 'blocked', reason: 'L’hébergeur de ce fichier empêche le navigateur de lire son son' };
    return { level: 'check', reason: 'Son Dolby décodé par l’app : peut rester muet selon l’hébergeur' };
  }
  return OK;
}

/**
 * Sources utilisables pour la reprise automatique : celles qui passent (`ok`), jamais une source bloquée. Une source « à vérifier »
 * lancée à la main garde ses semblables comme repli (même niveau), sinon elle ne trouverait aucune copie équivalente.
 */
export function failoverCandidates<V extends SourceView>(pool: readonly V[], current: SourceView | null | undefined, ctx: WebCompatContext): V[] {
  const keep: WebCompatLevel[] = current && webCompatOf(current, ctx).level === 'check' ? ['ok', 'check'] : ['ok'];
  return pool.filter((v) => keep.includes(webCompatOf(v, ctx).level));
}
