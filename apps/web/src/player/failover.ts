import { copySignature, type SourceView } from '../sources/info';

/* Reprise automatique : ordre des sources à essayer et détection des blocages. Fonctions pures, testées. */

const STALL_LIMIT_MS = 15_000;
/** Position figée malgré un cache qui avance : plafond au-delà duquel la source est tout de même tenue pour bloquée. */
const HARD_STALL_LIMIT_MS = 60_000;
/** Délai avant la première image (le transcodage et le débridage à la demande démarrent plus lentement). */
const STARTUP_LIMIT_MS = 45_000;

/**
 * Sources à essayer après `current` : d'abord les copies équivalentes (même qualité, source, codec, langues),
 * puis les autres lisibles dans l'ordre de `ranked` en gardant la langue d'abord. `tried` : indices déjà essayés.
 */
export function failoverOrder(ranked: readonly SourceView[], current: SourceView, tried: ReadonlySet<number>): SourceView[] {
  const sig = copySignature(current);
  const open = ranked.filter((v) => v.playable && !tried.has(v.index) && v.index !== current.index);
  const copies = open.filter((v) => copySignature(v) === sig);
  const sameLang = open.filter((v) => copySignature(v) !== sig && v.hasFrench === current.hasFrench);
  const rest = open.filter((v) => copySignature(v) !== sig && v.hasFrench !== current.hasFrench);
  return [...copies, ...sameLang, ...rest];
}

export type StallVerdict = 'ok' | 'stalled' | 'startup-timeout';

/**
 * Surveille la progression de lecture. Horloge injectée : `tick(now, …)`.
 * `cacheTime` : fin des données déjà reçues (secondes), null si le moteur ne la connaît pas. Un tampon qui se remplit
 * (mpv en `paused-for-cache`, HTML5 qui reçoit les octets) n'est pas un blocage : la position peut rester figée jusqu'à
 * HARD_STALL_LIMIT_MS tant que le cache avance.
 */
export class StallWatch {
  private lastTime = -1;
  private lastProgressAt: number;
  private lastCache = -1;
  private lastCacheProgressAt: number;
  private started = false;
  /** Début de la lecture continue en cours (null : la position n'avance pas). Une pause ne l'interrompt pas. */
  private stableSince: number | null = null;

  constructor(private readonly begunAt: number, private readonly stallMs = STALL_LIMIT_MS, private readonly startupMs = STARTUP_LIMIT_MS) {
    this.lastProgressAt = begunAt;
    this.lastCacheProgressAt = begunAt;
  }

  /** `time` : position actuelle ; `idle` : en pause, terminée ou en recherche (jamais considéré comme un blocage). */
  tick(now: number, time: number, idle: boolean, cacheTime: number | null = null): StallVerdict {
    if (idle) {
      this.lastProgressAt = now;
      this.lastCacheProgressAt = now;
      return 'ok';
    }
    if (cacheTime !== null) {
      if (cacheTime > 0 && cacheTime !== this.lastCache) this.lastCacheProgressAt = now;
      this.lastCache = cacheTime;
    }
    if (time !== this.lastTime && time > 0) {
      this.lastTime = time;
      this.lastProgressAt = now;
      this.started = true;
      if (this.stableSince === null) this.stableSince = now;
      return 'ok';
    }
    this.stableSince = null; // position figée hors pause : la lecture continue est interrompue
    if (!this.started) return now - this.begunAt > this.startupMs ? 'startup-timeout' : 'ok';
    const sincePosition = now - this.lastProgressAt;
    if (sincePosition <= this.stallMs) return 'ok';
    if (sincePosition > HARD_STALL_LIMIT_MS) return 'stalled';
    const cacheStuck = cacheTime === null || now - this.lastCacheProgressAt > this.stallMs;
    return cacheStuck ? 'stalled' : 'ok';
  }

  /** Après une recherche ou un changement de piste, la mesure repart de zéro (position et cache). */
  reset(now: number): void {
    this.lastProgressAt = now;
    this.lastCacheProgressAt = now;
  }

  /** Durée (ms) de lecture continue depuis `stableSince` ; 0 si la position n'avance pas. Fonction pure de `now`. */
  stableFor(now: number): number {
    return this.stableSince === null ? 0 : now - this.stableSince;
  }
}

/** Délai (ms) après un démarrage ou une réouverture pendant lequel rien ne compte. */
const SLOW_GRACE_MS = 60_000;
/** Délai (ms) après une recherche pendant lequel rien ne compte. */
const SLOW_SEEK_GRACE_MS = 10_000;
/** Fenêtre glissante des épisodes de tampon. */
const SLOW_WINDOW_MS = 300_000;
/** Épisodes de tampon dans la fenêtre au-delà desquels le lien est tenu pour lent. */
const SLOW_EPISODES_MAX = 3;
/** Tampon cumulé dans la fenêtre (ms) au-delà duquel le lien est tenu pour lent. */
const SLOW_BUFFER_MAX_MS = 20_000;
/** Critère préventif : réserve de cache (s de média) sous laquelle le lien est suspect. */
const SLOW_RESERVE_S = 3;
/** Critère préventif : remplissage du cache (s de média par s réelle) sous lequel le lien est suspect. */
const SLOW_FILL_RATE = 0.7;
/** Critère préventif : durée (ms) pendant laquelle la condition doit tenir sans interruption. */
const SLOW_PREVENTIVE_MS = 60_000;
/** Délai (ms) minimal entre deux réouvertures. */
const SLOW_QUIET_MS = 90_000;

/** Épisode de tampon : au moins deux relevés consécutifs en tampon, de `start` à `end` (ms). */
interface BufferEpisode {
  start: number;
  end: number;
}

/**
 * Détecte un lien HTTP lu par mpv qui ralentit durablement (mises en tampon courtes répétées, ou cache qui se remplit trop
 * lentement) pour rouvrir la connexion. Horloge injectée : `tick(now, …)`, `now` en ms. `time` et `cacheTime` en secondes de
 * média ; `cacheTime` : demuxer-cache-time, null si inconnu. Rien ne compte pendant le délai qui suit `reset` ou `seeked`,
 * ni quand le lecteur est `idle` (pause, recherche, fin).
 */
export class SlowLinkWatch {
  private graceUntil = 0;
  private quietUntil = 0;
  private episodes: BufferEpisode[] = [];
  /** Relevés consécutifs en tampon dans l'épisode en cours, et heure du premier. */
  private runTicks = 0;
  private runStart = 0;
  /** Dernier relevé compté : sert à mesurer la vitesse de remplissage du cache. */
  private prev: { now: number; cache: number | null } | null = null;
  /** Début de la période où le critère préventif est rempli (null : pas en cours). */
  private slowSince: number | null = null;

  /** (Re)démarre : rien ne compte pendant SLOW_GRACE_MS (démarrage ou après une réouverture). Le délai entre réouvertures est gardé. */
  reset(now: number): void {
    this.graceUntil = now + SLOW_GRACE_MS;
    this.episodes = [];
    this.breakRun();
  }

  /** Recherche : rien ne compte pendant SLOW_SEEK_GRACE_MS. L'historique des épisodes est gardé. */
  seeked(now: number): void {
    this.graceUntil = Math.max(this.graceUntil, now + SLOW_SEEK_GRACE_MS);
    this.breakRun();
  }

  /** À appeler environ une fois par seconde. Renvoie 'reopen' quand le lien est tenu pour lent, pas plus d'une fois par SLOW_QUIET_MS. */
  tick(now: number, time: number, buffering: boolean, idle: boolean, cacheTime: number | null): 'ok' | 'reopen' {
    if (idle || now < this.graceUntil) {
      this.breakRun();
      return 'ok';
    }
    const p = this.prev;
    const dt = p ? now - p.now : 0;
    if (buffering) {
      this.runTicks++;
      if (this.runTicks === 1) this.runStart = now;
      else if (this.runTicks === 2) this.episodes.push({ start: this.runStart, end: now });
      else this.episodes[this.episodes.length - 1].end = now;
    } else {
      this.runTicks = 0;
    }
    let suspect = false;
    if (cacheTime !== null && p && p.cache !== null && dt > 0) {
      const fill = (cacheTime - p.cache) / (dt / 1000);
      suspect = cacheTime - time < SLOW_RESERVE_S && fill < SLOW_FILL_RATE;
    }
    this.slowSince = suspect ? (this.slowSince ?? now) : null;
    this.prev = { now, cache: cacheTime };

    this.episodes = this.episodes.filter((e) => e.end >= now - SLOW_WINDOW_MS);
    const bufferedMs = this.episodes.reduce((sum, e) => sum + (e.end - e.start), 0);
    const slow = this.episodes.length >= SLOW_EPISODES_MAX || bufferedMs >= SLOW_BUFFER_MAX_MS
      || (this.slowSince !== null && now - this.slowSince >= SLOW_PREVENTIVE_MS);
    if (!slow || now < this.quietUntil) return 'ok';
    this.quietUntil = now + SLOW_QUIET_MS;
    this.episodes = [];
    this.breakRun();
    return 'reopen';
  }

  /** Interrompt la continuité des relevés : épisode en cours, mesure de remplissage et critère préventif repartent de zéro. */
  private breakRun(): void {
    this.runTicks = 0;
    this.prev = null;
    this.slowSince = null;
  }
}

/** Lecture stable depuis ce délai : les essais déjà faits ne comptent plus (des micro-coupures espacées n'épuisent pas MAX_ATTEMPTS). */
const STABLE_RESET_MS = 120_000;

/**
 * Remise à zéro des essais après une lecture stable. Renvoie null s'il n'y a rien à remettre. Seule la vue courante reste
 * marquée « essayée » : les autres sources redeviennent candidates au failover suivant.
 */
export function attemptsAfterStable(attempts: number, currentIndex: number, stableMs: number): { attempts: number; tried: Set<number> } | null {
  if (attempts <= 0 || stableMs < STABLE_RESET_MS) return null;
  return { attempts: 0, tried: new Set([currentIndex]) };
}

/**
 * Meilleur candidat pour la course quand la source choisie tarde : même langue, puis la plus facile à lancer (lecture directe,
 * puis conversion audio, puis réencodage vidéo), puis en cache ; jamais une source déjà essayée ni mémorisée comme lente.
 */
export function pickRaceCandidate(
  ranked: readonly SourceView[], current: SourceView, tried: ReadonlySet<number>, bad: ReadonlySet<string>, keyOf: (v: SourceView) => string,
): SourceView | null {
  const open = failoverOrder(ranked, current, tried).filter((v) => !bad.has(keyOf(v)));
  const ease = (v: SourceView): number => (v.appAudio === 'unsupported' ? 5 : v.web === 'direct' ? 0 : v.convert === 'audio' ? 1 : v.web === 'unknown' ? 2 : 3);
  const score = (v: SourceView): number => (v.hasFrench === current.hasFrench ? 0 : 100) + ease(v) * 10 + (v.status === 'cached' ? 0 : 1);
  const sorted = open.map((v, i) => ({ v, i })).sort((a, b) => score(a.v) - score(b.v) || a.i - b.i);
  return sorted.length ? sorted[0].v : null;
}
