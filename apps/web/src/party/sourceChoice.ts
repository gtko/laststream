import { matchesLanguage } from '../data/sources';
import type { Lang } from '../data/stream';
import type { Fingerprint } from '../data/socialApi';
import { langName } from '../player/tracks';
import type { SourceView } from '../sources/info';
import { pickByFingerprint } from './fingerprint';

/* Choix de la source dans une watch party : la version de l'hôte d'abord, puis la langue du salon, jamais une autre langue
 * en silence. Fonctions pures, testées. Hors salon, rien de ce module ne s'applique. */

/** Motif du choix : ce qui a décidé de la source, ou pourquoi il n'y en a pas. */
type ChoiceMotif = 'explicit' | 'fingerprint' | 'host' | 'language' | 'languageFallback' | 'none';

interface SourceChoice {
  /** Source choisie ; null avec `languageFallback` (aucune source dans la langue du salon) ou `none` (rien de jouable). */
  view: SourceView | null;
  motif: ChoiceMotif;
}

interface SourceChoiceOptions {
  /** Version choisie par le participant lui-même. */
  explicit?: SourceView | null;
  /** Empreinte de la version lue par l'hôte. */
  fingerprint?: Partial<Fingerprint> | null;
  /** Libellé de la version de l'hôte (`sourceLabel`) : même langue et même résolution. */
  hostLabel?: string | null;
  /** Langue du salon (`roomLangOf`) ; null : pas de contrainte de langue. */
  roomLanguage: Lang | null;
}

/** Délai (ms depuis le début de la recherche) pendant lequel une source hors langue du salon attend encore une source dans cette langue. */
export const LANG_WAIT_MS = 10_000;

const SUPPORTED: readonly Lang[] = ['fr', 'en', 'es', 'de', 'it'];

/** Langue d'une source pour l'affichage : VF, multi, VO, ou VO + code (« VO EN »). */
function sourceLangTag(v: SourceView): string {
  if (v.hasFrench) return 'VF';
  const langs = v.info?.languages ?? [];
  if (langs.includes('multi')) return 'multi';
  if (langs.includes('original') || langs.length === 0) return 'VO';
  return 'VO ' + langs[0].toUpperCase();
}

/** Libellé court d'une source, « VF · 1080p ». Unique source de ce libellé (comparaison avec l'hôte, avis de bascule). */
export function sourceLabel(v: SourceView): string {
  return sourceLangTag(v) + ' · ' + (v.quality || v.group);
}

/** Code de langue du salon (`vo` ou `original` : la langue d'origine du titre) vers la langue des sources. Null si le salon n'en a pas. */
export function roomLangOf(roomLanguage: string | null | undefined, originalLang = ''): Lang | null {
  const code = (roomLanguage ?? '').trim().toLowerCase();
  if (!code) return null;
  if (code === 'vo' || code === 'original') return 'original';
  if (SUPPORTED.includes(code as Lang)) return code as Lang;
  return originalLang.trim().toLowerCase() === code ? 'original' : 'multi';
}

/** Piste audio à viser (sources multi-audio) : la langue du salon, ou la langue d'origine du titre pour « vo ». */
export function roomAudioLang(roomLanguage: string | null | undefined, originalLang = ''): string | undefined {
  const code = (roomLanguage ?? '').trim().toLowerCase();
  if (!code) return undefined;
  if (code === 'vo' || code === 'original') return originalLang.trim().toLowerCase() || undefined;
  return code;
}

/** Meilleure source d'une liste jouable : son injouable en dernier, puis meilleur score, puis premier reçu. Null si aucune. */
export function bestSource(views: readonly SourceView[]): SourceView | null {
  const unsupported = (v: SourceView): number => (v.appAudio === 'unsupported' ? 1 : 0);
  const sorted = views.filter((v) => v.playable).sort((a, b) => unsupported(a) - unsupported(b) || b.score - a.score || a.index - b.index);
  return sorted[0] ?? null;
}

/**
 * Source d'une watch party, dans l'ordre : choix explicite du participant, version de l'hôte (empreinte), même langue et
 * résolution que le libellé de l'hôte, puis meilleure source dans la langue du salon. Sans source dans cette langue :
 * `languageFallback`, à l'appelant d'annoncer la langue lue. Seules les sources jouables sont retenues.
 */
export function chooseSource(views: readonly SourceView[], opts: SourceChoiceOptions): SourceChoice {
  const playable = views.filter((v) => v.playable);
  if (!playable.length) return { view: null, motif: 'none' };
  const wanted = opts.explicit;
  const explicit = wanted ? playable.find((v) => v.index === wanted.index) : undefined;
  if (explicit) return { view: explicit, motif: 'explicit' };
  const byFingerprint = pickByFingerprint(playable, opts.fingerprint);
  if (byFingerprint) return { view: byFingerprint, motif: 'fingerprint' };
  if (opts.hostLabel) {
    const host = bestSource(playable.filter((v) => sourceLabel(v) === opts.hostLabel));
    if (host) return { view: host, motif: 'host' };
  }
  const lang = opts.roomLanguage;
  const inLang = lang ? playable.filter((v) => !!v.info && matchesLanguage(v.info, lang)) : playable;
  const best = bestSource(inLang);
  return best ? { view: best, motif: 'language' } : { view: null, motif: 'languageFallback' };
}

/** Vrai si la source ne suit pas la langue du salon (failover hors langue). Hors salon (`roomLanguage` null) : faux. */
export function languageChanged(v: SourceView, roomLanguage: Lang | null): boolean {
  if (!roomLanguage || !v.info) return false;
  return !matchesLanguage(v.info, roomLanguage);
}

/** Avis quand aucune source n'est dans la langue du salon : la meilleure est lue dans une autre langue, et on le dit. */
export function languageFallbackNotice(v: SourceView, roomLanguage: string): string {
  const code = roomLanguage.trim().toLowerCase();
  const room = code === 'vo' || code === 'original' ? 'VO' : langName(code);
  return 'Pas de source en ' + room + ' : lecture en ' + sourceLangTag(v);
}
