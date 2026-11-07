import type { LangPrefs } from '../data/langPrefs';
import { pickTracks, type TrackContext, type TrackPick } from './langPolicy';
import type { AudioTrack, SubtitleTrack } from './tracks';

/*
 * Application des préférences de langue à un moteur de lecture : une seule fois par lecture, au premier chargement des pistes.
 * Un choix manuel de l'utilisateur (panneau du lecteur) bloque toute application ultérieure. Les sous-titres externes qui
 * arrivent après coup (OpenSubtitles) complètent ce qui manquait, sans toucher à ce qui a déjà été choisi.
 */

/** Ce que le moteur sait faire : audio, sous-titre, second sous-titre. */
export interface TrackSink {
  setAudio(id: string): void;
  setSub(id: string | null): void;
  setSecondary(id: string | null): void;
}

export class TrackApplier {
  /** Première application faite. */
  done = false;
  /** L'utilisateur a choisi lui-même : plus rien n'est appliqué automatiquement. */
  manual = false;
  private subApplied = false;
  private subId: string | null = null;
  private secondaryApplied = false;
  private wantedSecondary = false;
  /** Dernier choix calculé (pour le message de démarrage). */
  pick: TrackPick | null = null;

  reset(): void {
    this.done = false;
    this.manual = false;
    this.subApplied = false;
    this.subId = null;
    this.secondaryApplied = false;
    this.wantedSecondary = false;
    this.pick = null;
  }

  /** L'utilisateur a changé une piste à la main. */
  markManual(): void {
    this.manual = true;
  }

  /**
   * Premier chargement des pistes. Renvoie le choix appliqué, ou null si rien n'a été fait (déjà appliqué, choix manuel,
   * ou aucune piste annoncée sans `force`).
   */
  apply(audio: readonly AudioTrack[], subs: readonly SubtitleTrack[], prefs: LangPrefs, ctx: TrackContext, sink: TrackSink, force = false): TrackPick | null {
    if (this.done || this.manual) return null;
    if (!audio.length && !subs.length && !force) return null;
    this.done = true;
    const pick = pickTracks(audio, subs, prefs, ctx);
    this.pick = pick;
    const current = audio.find((t) => t.selected);
    if (pick.audioId !== null && !(current && current.id === pick.audioId)) sink.setAudio(pick.audioId);
    if (pick.subId !== null) { sink.setSub(pick.subId); this.subApplied = true; this.subId = pick.subId; }
    if (pick.secondarySubId !== null) { sink.setSecondary(pick.secondarySubId); this.secondaryApplied = true; }
    // Le mode apprentissage attend le second sous-titre (souvent externe) s'il n'est pas encore là.
    this.wantedSecondary = prefs.learn && pick.secondarySubId === null;
    return pick;
  }

  /**
   * Nouvelles pistes après la première application (sous-titres externes chargés) : complète le sous-titre ou le second
   * sous-titre manquants. Renvoie le choix si quelque chose a été appliqué.
   */
  late(audio: readonly AudioTrack[], subs: readonly SubtitleTrack[], prefs: LangPrefs, ctx: TrackContext, sink: TrackSink): TrackPick | null {
    if (!this.done || this.manual || (this.subApplied && (this.secondaryApplied || !this.wantedSecondary))) return null;
    // L'audio déjà en lecture sert de référence : un changement manuel d'audio n'est pas rejoué.
    const playing = audio.filter((t) => t.selected);
    const pick = pickTracks(playing.length ? playing : audio, subs, prefs, ctx);
    let changed = false;
    if (!this.subApplied && pick.subId !== null) { sink.setSub(pick.subId); this.subApplied = true; this.subId = pick.subId; changed = true; }
    if (!this.secondaryApplied && this.wantedSecondary && pick.secondarySubId !== null && pick.subId === this.subId) { sink.setSecondary(pick.secondarySubId); this.secondaryApplied = true; changed = true; }
    if (!changed) return null;
    this.pick = pick;
    return pick;
  }
}
