import type { SqlDb } from './sql.js';

/**
 * Usage unique des tickets du flux temps réel. Le nonce d'un ticket accepté est mémorisé jusqu'à l'échéance du ticket
 * (table `live_ticket_nonces`, migration v16) : le rejouer échoue. Les nonces expirés sont purgés à chaque consommation.
 */

/** Vrai si le pid est un profil existant et non enfant (un profil enfant n'a pas de pid ; supprimé : plus de ligne). */
export function isLiveEligible(db: SqlDb, pid: string): boolean {
  return db.prepare('SELECT 1 AS ok FROM profiles WHERE pid = ? AND is_kid = 0 LIMIT 1').get(pid) !== undefined;
}

/**
 * Consomme le nonce : `true` à la première fois, `false` si déjà utilisé. `exp` (ms) est l'échéance du ticket ; un
 * ticket déjà échu n'est pas consommé (refusé).
 */
export function consumeLiveTicketNonce(db: SqlDb, nonce: string, exp: number, now: number): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM live_ticket_nonces WHERE expires_at <= ?').run(now);
    if (!Number.isFinite(exp) || exp <= now || nonce === '') return false;
    const result = db.prepare('INSERT INTO live_ticket_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING').run(nonce, exp);
    return Number(result.changes) === 1;
  });
}
