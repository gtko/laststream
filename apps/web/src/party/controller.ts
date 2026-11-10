import type { PartyClient } from './client';
import { driftAction, expectedPosition, type DriftAction } from './sync';

/* Lecture partagée : chaque participant (hôte ou invité) envoie ses actions locales (play, pause, seek) au salon et applique
 * l'état diffusé à son lecteur, quel que soit le moteur (HTML5/HLS, mpv, libVLC natif) : seule l'interface minimale
 * `PlayerLike` est utilisée. Seul l'hôte envoie son rapport de position (`sync`), référence de l'horloge du salon.
 * Anti-écho : un changement appliqué depuis le salon n'est jamais renvoyé (fenêtre d'application, fermée quand le lecteur
 * l'a pris), et une commande locale n'est pas défaite par un état périmé avant l'écho du serveur.
 * Appelé toutes les 250 ms par le lecteur (1 s si la boucle d'interface dort) (`tick`). */

export interface PlayerLike {
  /** Un média est chargé et la position est mesurable. */
  ready(): boolean;
  time(): number;
  duration(): number;
  paused(): boolean;
  buffering(): boolean;
  rate(): number;
  play(): void;
  pause(): void;
  seek(to: number): void;
  setRate(rate: number): void;
  /** La vitesse de lecture est réglable (lecteur natif : non, la correction passe par des sauts). */
  canRate: boolean;
  /**
   * Le système a suspendu ce lecteur (onglet ou application en arrière-plan, écran éteint, appel) : sa pause n'est pas une
   * action de l'utilisateur. Absent : jamais suspendu.
   */
  suspended?(): boolean;
}

export const HOST_SYNC_EVERY_MS = 5000;
/** Écart de position, par rapport à ce que la lecture normale produirait, qui compte comme un saut (commande `seek`). */
const SEEK_JUMP_SEC = 1.5;
/** Délai maximal laissé au lecteur pour prendre une action appliquée depuis le salon (au-delà, on re-mesure). */
const SETTLE_MS = 1500;
/** Délai pendant lequel le suivi attend l'écho du salon à une commande locale. */
const ECHO_WAIT_MS = 1500;
/** Tolérance de position qui termine l'application d'un saut. */
const SEEK_DONE_SEC = 0.5;
/** Intervalle minimal entre deux sauts envoyés : une touche maintenue ne doit pas saturer le débit du salon (au-delà, il ferme). */
const SEEK_SEND_EVERY_MS = 500;
const FOLLOW_EVERY_MS = 500;
/** Marge de fin de fichier : un lecteur arrivé là s'arrête de lui-même, ce n'est ni une pause ni un retard à corriger. */
const END_MARGIN_SEC = 1.5;

interface Measure {
  paused: boolean;
  time: number;
  at: number;
}

/** Action du salon appliquée au lecteur : il doit atteindre `paused` (et la position `to`, si un saut a été fait). */
interface Settling {
  paused: boolean;
  to: number | null;
  until: number;
}

/** Commande locale envoyée : le suivi attend un état plus récent que `rev` (l'écho du serveur). */
interface Pending {
  rev: number;
  until: number;
}

type Action = 'play' | 'pause' | 'seek' | 'sync';

export class PartyController {
  private last: Measure | null = null;
  private lastSyncSent = 0;
  private settling: Settling | null = null;
  private pending: Pending | null = null;
  private lastFollow = 0;
  private correcting = false;
  /** Saut détecté, pas encore envoyé (espacement de SEEK_SEND_EVERY_MS) : sa position la plus récente. */
  private seekDue: number | null = null;
  private lastSeekSent = 0;
  /** L'hôte vient de lancer son lecteur (ou de créer le salon) : à la première mesure, le salon s'aligne sur lui. */
  private alignOnStart = false;
  /** Révision du dernier état du salon pris en compte par le suivi : l'hôte n'envoie pas de rapport tant qu'un état plus récent attend. */
  private followedRev: number | null = null;
  /** Pause posée par le système (voir `PlayerLike.suspended`) et non diffusée : la reprise qui suit ne l'est pas non plus. */
  private systemPaused = false;
  /** Dernier écart mesuré entre ce lecteur et le salon (secondes, signé), pour « Synchronisés · écart » ; null avant la première mesure. */
  drift: number | null = null;
  /** Dernières commandes appliquées au lecteur local (inspection par les tests). */
  readonly applied: string[] = [];

  constructor(private readonly client: PartyClient, private readonly now: () => number = () => Date.now()) {}

  /** Oublie l'état mesuré (nouveau média, reconnexion) : la prochaine mesure repart de zéro, et l'état du salon fait foi. */
  reset(): void {
    this.last = null;
    this.settling = null;
    this.pending = null;
    this.seekDue = null;
    // `correcting` est gardé : la vitesse corrective en cours est rendue à 1 par le suivi (un invité promu hôte ne la garde pas).
    this.drift = null;
    this.followedRev = null;
    this.systemPaused = false;
  }

  /** Sortie du salon (départ, fin, exclusion) : le lecteur ne garde pas la vitesse corrective. */
  release(player: PlayerLike | null): void {
    if (this.correcting && player) this.restoreRate(player);
    this.correcting = false;
  }

  /** Lecteur de l'hôte démarré (ou salon créé) : l'état de son lecteur devient celui du salon à la prochaine mesure. */
  arm(): void {
    this.alignOnStart = true;
  }

  tick(player: PlayerLike | null): void {
    if (!player || !this.client.state || this.client.status === 'closed') return;
    if (this.client.status !== 'open') {
      // Hors ligne (reconnexion) : rien ne peut être envoyé et l'état connu vieillit. Le lecteur reste libre ; la bienvenue de la
      // reconnexion remet le suivi à zéro et l'état du salon refait foi.
      this.last = null;
      return;
    }
    if (!player.ready()) {
      // Lecteur absent ou en rechargement (bascule de source) : la mesure d'avant ne vaut plus, et rien n'est envoyé au salon.
      this.last = null;
      return;
    }
    const now = this.now();
    const cur: Measure = { paused: player.paused(), time: player.time(), at: now };
    if (this.settling !== null) {
      // Une action du salon est en cours d'application : on mesure sans rien envoyer, jusqu'à ce que le lecteur l'ait prise.
      if (this.isSettled(player, cur, this.settling)) this.settling = null;
      this.last = cur;
      return;
    }
    this.detect(player, cur);
    this.flushSeek(now);
    this.follow(player, now);
  }

  /** Envoie le saut en attente, au plus une fois par SEEK_SEND_EVERY_MS ; la position la plus récente part. */
  private flushSeek(now: number): void {
    if (this.seekDue === null || now - this.lastSeekSent < SEEK_SEND_EVERY_MS) return;
    const pos = this.seekDue;
    this.seekDue = null;
    this.lastSeekSent = now;
    this.send('seek', pos);
  }

  private isSettled(p: PlayerLike, cur: Measure, s: Settling): boolean {
    const reached = cur.paused === s.paused && !p.buffering() && (s.to === null || Math.abs(cur.time - s.to) < SEEK_DONE_SEC);
    return reached || cur.at >= s.until;
  }

  // ---- Actions locales -> salon ----
  private detect(p: PlayerLike, cur: Measure): void {
    const prev = this.last;
    this.last = cur;
    if (p.duration() <= 0) {
      // Aucun média mesurable (chargement, changement de moteur) : pas de mesure fiable.
      this.last = null;
      return;
    }
    if (prev === null) {
      // Première mesure : au démarrage de l'hôte, le salon s'aligne sur son lecteur s'il diffère ; sinon (invité, reconnexion)
      // le suivi cale le lecteur sur l'état du salon.
      if (this.client.isHost && this.alignOnStart) {
        this.alignOnStart = false;
        const st = this.client.state!;
        if (st.playing === cur.paused || Math.abs(expectedPosition(st, this.client.serverNow()) - cur.time) > 1) {
          this.send(cur.paused ? 'pause' : 'play', cur.time);
        }
      }
      return;
    }
    if (p.buffering() && !cur.paused) return; // la position n'est pas fiable pendant le chargement
    if (cur.paused !== prev.paused) {
      const dur = p.duration();
      // Fin du fichier (les versions n'ont pas toutes la même durée) : l'arrêt du lecteur n'est pas une pause du salon.
      if (cur.paused && cur.time >= dur - END_MARGIN_SEC) return;
      // Pause du système (arrière-plan, écran éteint, appel) : elle ne met pas le salon en pause, et la reprise au retour ne le
      // relance pas depuis la position de cet appareil : le suivi le recale sur le salon.
      if (cur.paused && p.suspended?.()) { this.systemPaused = true; return; }
      if (!cur.paused && this.systemPaused) { this.systemPaused = false; return; }
      this.systemPaused = false;
      this.send(cur.paused ? 'pause' : 'play', cur.time);
      return;
    }
    const expected = prev.paused ? prev.time : prev.time + ((cur.at - prev.at) / 1000) * Math.max(0.25, p.rate());
    if (Math.abs(cur.time - expected) > SEEK_JUMP_SEC) {
      this.seekDue = cur.time;
      return;
    }
    // Rapport de position de l'hôte, seulement pendant une lecture que le salon partage aussi (sinon il écraserait un état
    // plus récent, comme une pause qu'un invité vient de diffuser).
    // Pas de rapport non plus tant qu'un état plus récent (saut d'un invité) n'a pas été appliqué ici : la position mesurée
    // est encore celle d'avant, et la renvoyer annulerait ce saut pour tout le salon.
    const st = this.client.state!;
    if (this.client.isHost && !cur.paused && st.playing && (st.rev ?? 0) === this.followedRev && cur.at - this.lastSyncSent >= HOST_SYNC_EVERY_MS) this.send('sync', cur.time);
  }

  private send(action: Action, pos: number): void {
    const now = this.now();
    this.lastSyncSent = now;
    if (!this.client.control(action, pos)) return;
    if (action !== 'sync') this.pending = { rev: this.client.state?.rev ?? 0, until: now + ECHO_WAIT_MS };
  }

  // ---- Salon -> lecteur ----
  private follow(p: PlayerLike, now: number): void {
    if (now - this.lastFollow < FOLLOW_EVERY_MS) return;
    this.lastFollow = now;
    const st = this.client.state!;
    if (this.pending !== null) {
      // Notre commande n'est pas encore revenue du salon : un état antérieur ne doit pas la défaire.
      if ((st.rev ?? 0) <= this.pending.rev && now < this.pending.until) return;
      this.pending = null;
    }
    this.followedRev = st.rev ?? 0;
    const expected = expectedPosition(st, this.client.serverNow());
    const dur = p.duration();
    // Sans vitesse réglable (natif), la cible s'arrête à 1 s de la fin, et non 0,5 s.
    const target = dur > 0 ? Math.min(expected, Math.max(0, dur - (p.canRate ? 0.5 : 1))) : expected;
    // Sans vitesse réglable, local et cible dans la dernière seconde et demie : aucune correction (sinon re-seek en boucle).
    // Lecteur arrivé à la fin de son fichier alors que le salon continue (version plus courte) : ni relance ni saut, sinon il
    // repartirait du début pour retomber sur la fin, en boucle.
    const atEnd = dur > 0 && p.time() >= dur - END_MARGIN_SEC && target >= dur - END_MARGIN_SEC && (!p.canRate || p.paused());
    this.drift = p.buffering() ? this.drift : p.time() - target;
    if (!st.playing) {
      const seekTo = !atEnd && Math.abs(p.time() - target) >= 0.5 ? target : null;
      if (p.paused() && seekTo === null) {
        if (this.correcting) this.restoreRate(p);
        return;
      }
      if (!p.paused()) this.run(p, 'pause', () => p.pause());
      if (seekTo !== null) this.run(p, 'seek:' + seekTo.toFixed(1), () => p.seek(seekTo));
      this.settle(true, seekTo, now);
      if (this.correcting) this.restoreRate(p);
      return;
    }
    let touched: { paused: boolean; to: number | null } | null = null;
    // Lecteur suspendu par le système ou arrivé en fin de fichier : pas de relance (elle jouerait le son d'un appareil verrouillé,
    // ou repartirait du début). Le suivi reprend au retour.
    if (p.paused() && (atEnd || p.suspended?.())) return;
    // Dans un salon la lecture est à vitesse normale : une vitesse choisie à la main ferait reculer ce lecteur en boucle (hôte,
    // lecteur natif) ou entraînerait tout le salon.
    if (!this.correcting && Math.abs(p.rate() - 1) > 0.001) this.run(p, 'rate:1', () => p.setRate(1));
    if (p.paused()) {
      this.run(p, 'play', () => p.play());
      touched = { paused: false, to: null };
    }
    if (p.buffering()) {
      // La position n'est pas fiable pendant le chargement.
      if (touched !== null) this.settle(touched.paused, touched.to, now);
      return;
    }
    // L'hôte est l'horloge de référence : il ne se cale que par saut (pas de vitesse corrective, qui ferait osciller son rapport).
    const action: DriftAction = atEnd ? { kind: 'none' } : driftAction(p.time(), target, true, { canRate: p.canRate && !this.client.isHost, correcting: this.correcting });
    if (action.kind === 'none') {
      if (this.correcting) this.restoreRate(p);
    } else if (action.kind === 'rate') {
      if (Math.abs(p.rate() - action.rate) > 0.001) this.run(p, 'rate:' + action.rate, () => p.setRate(action.rate));
      this.correcting = true;
    } else {
      this.run(p, 'seek:' + action.to.toFixed(1), () => p.seek(action.to));
      touched = { paused: false, to: action.to };
      if (this.correcting) this.restoreRate(p);
    }
    if (touched !== null) this.settle(touched.paused, touched.to, now);
  }

  /** Ouvre la fenêtre d'application : les changements du lecteur qui suivent ne sont pas des actions locales. */
  private settle(paused: boolean, to: number | null, now: number): void {
    this.settling = { paused, to, until: now + SETTLE_MS };
    // Un saut local encore en attente serait périmé face à ce que le salon vient d'imposer : on l'abandonne.
    this.seekDue = null;
  }

  private restoreRate(p: PlayerLike): void {
    this.correcting = false;
    if (Math.abs(p.rate() - 1) > 0.001) this.run(p, 'rate:1', () => p.setRate(1));
  }

  private run(_p: PlayerLike, label: string, fn: () => void): void {
    this.applied.push(label);
    if (this.applied.length > 50) this.applied.shift();
    try { fn(); } catch { /* le moteur peut ne pas être prêt : retenté au tour suivant */ }
  }
}
