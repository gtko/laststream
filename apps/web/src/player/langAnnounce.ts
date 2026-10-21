import type { LangPrefs } from '../data/langPrefs';
import { learnNotice, secondaryFor, SECONDARY_EMPTY_MSG, SECONDARY_LOAD_FAIL_MSG, SECONDARY_OFF_MSG, SECONDARY_UNSUPPORTED_MSG, type TrackPick } from './langPolicy';
import { normalizeLang, type AudioTrack, type SubtitleTrack } from './tracks';

/*
 * Décisions de messages du mode apprentissage, sans lecteur : quand annoncer, quoi dire, que faire du second sous-titre
 * après un choix manuel. session.js ne fait que les appliquer (toast, moteur).
 */

export interface LearnAnnounceOpts {
  engineKind?: string;
  /** La source ne permet pas de changer la langue audio (aucune piste annoncée par le moteur). */
  audioUnknown: boolean;
  /** Sous-titres désactivés (« Jamais »). */
  subsOff: boolean;
  /** La recherche de sous-titres externes est terminée (chargés, en échec ou sans objet) : avant, « pas de sous-titres » serait peut-être faux. */
  extSettled: boolean;
  /** Pistes audio vues par la sonde du serveur (le navigateur n'expose pas les siennes) ; la première (ordre du fichier, pas la marque `default`) est tenue pour celle par défaut. */
  probeAudio?: readonly AudioTrack[];
  /** Un autre message a déjà prévenu que la lecture directe garde la piste audio par défaut. */
  directNotified?: boolean;
}

/** Résultat de l'annonce : `offerTranscode` : le message propose le transcodage (langue apprise sur une piste non par défaut). */
export interface LearnAnnouncement { wait: boolean; msg: string; offerTranscode: boolean }

/**
 * Message unique du mode apprentissage pour cette lecture. `wait` : attendre les sous-titres externes avant de conclure.
 * Hors mode apprentissage, rien à dire. Sans liste de pistes audio, on ne prétend pas que la langue manque : on dit qu'elle n'est pas modifiable.
 */
export function learnAnnouncement(pick: TrackPick, prefs: LangPrefs, opts: LearnAnnounceOpts): LearnAnnouncement {
  if (!prefs.learn) return { wait: false, msg: '', offerTranscode: false };
  if (!opts.extSettled) return { wait: true, msg: '', offerTranscode: false };
  let adjusted = opts.audioUnknown ? { ...pick, learnAudioMissing: false } : pick;
  let audioUnknown = opts.audioUnknown;
  if (audioUnknown) {
    const probe = opts.probeAudio ?? [];
    if (probe.length) {
      // La sonde voit les pistes : on ne signale que ce qui est vrai.
      const idx = probe.findIndex((t) => t.lang === normalizeLang(prefs.learnLang));
      // « Pas d'audio X » seulement si toutes les pistes ont une langue connue ; une piste sans étiquette peut être la bonne.
      const allLabeled = probe.every((t) => !!t.lang);
      if (idx < 0 && allLabeled) adjusted = { ...pick, learnAudioMissing: true, audioLang: probe[0].lang };
      audioUnknown = idx > 0 || (idx < 0 && !allLabeled);
    } else if (opts.directNotified) {
      audioUnknown = false;
    }
  }
  return { wait: false, msg: learnNotice(adjusted, prefs, { engineKind: opts.engineKind, audioUnknown, subsOff: opts.subsOff }), offerTranscode: audioUnknown };
}

/**
 * Après un choix manuel du sous-titre principal (`firstId`, `null` : « off ») : second sous-titre à appliquer (mode apprentissage)
 * et message quand un second actif (`hadSecond`) disparaît (« off » ou langue principale choisie).
 */
export function manualSubPlan(subTracks: readonly SubtitleTrack[], prefs: LangPrefs, firstId: string | null, canSecondary: ((t: SubtitleTrack) => boolean) | undefined, hadSecond: boolean): { secondaryId: string | null; toast: string } {
  const secondaryId = prefs.learn ? secondaryFor(subTracks, prefs, firstId, canSecondary) : null;
  return { secondaryId, toast: prefs.learn && hadSecond && secondaryId === null ? SECONDARY_OFF_MSG : '' };
}

export type SecondaryFailure = 'unsupported' | 'empty' | 'load';

/** Message d'un échec du second sous-titre. */
export function secondaryFailureMsg(f: SecondaryFailure): string {
  return f === 'unsupported' ? SECONDARY_UNSUPPORTED_MSG : f === 'empty' ? SECONDARY_EMPTY_MSG : SECONDARY_LOAD_FAIL_MSG;
}
