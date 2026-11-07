/**
 * Machine d'états des téléchargements (ODY-198) : fonctions pures, sans I/O.
 *
 * `done` est terminal. Une transition interdite lève `InvalidTransitionError` ; l'objet d'origine n'est jamais modifié.
 */
import type { DownloadItem, DownloadState } from './types';

/** Transitions autorisées depuis chaque état. */
export const TRANSITIONS: Record<DownloadState, readonly DownloadState[]> = {
  pending: ['running', 'paused'],
  running: ['paused', 'done', 'error', 'pending'],
  paused: ['pending'],
  error: ['pending'],
  done: [],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: DownloadState, readonly to: DownloadState) {
    super(`transition interdite : ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: DownloadState, to: DownloadState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Nouvel item dans l'état `to`, copie de `item` avec `patch` appliqué. `updatedAt` vaut `now` (défaut : l'horloge).
 * `error` est effacé, sauf si `patch.error` est fourni. L'état reste `to`, même si `patch` contient un `state`.
 */
export function transition(
  item: DownloadItem,
  to: DownloadState,
  patch: Partial<DownloadItem> = {},
  now?: number,
): DownloadItem {
  if (!canTransition(item.state, to)) throw new InvalidTransitionError(item.state, to);
  const next: DownloadItem = { ...item, ...patch, state: to, updatedAt: now ?? Date.now() };
  if (patch.error === undefined) delete next.error;
  return next;
}
