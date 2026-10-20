import { isRecord } from '../sources/http.js';
import type { Config } from './schema.js';

/** Champs de `services` considérés comme secrets. `openrouterModel` est un nom de modèle, il n'est pas secret. */
const SERVICE_SECRET_FIELDS = [
  'tmdbToken',
  'tmdbApiKey',
  'mdblistApiKey',
  'tvdbApiKey',
  'tvdbPin',
  'openrouterApiKey',
  'fanartApiKey',
  'introdbApiKey',
  'skipdbApiKey',
  'animeskipClientId',
] as const;

/** Longueur minimale d'un secret pour que le masque en montre les quatre derniers caractères. */
const LAST4_MIN_LENGTH = 12;

/** Masque renvoyé à la place d'un secret : sa présence, et ses quatre derniers caractères si la clé est assez longue. */
interface SecretMask {
  set: true;
  last4?: string;
}

/** Libellé des quatre derniers caractères, ou undefined si la clé est trop courte pour en montrer une partie. */
function last4Label(value: string): string | undefined {
  return value.length >= LAST4_MIN_LENGTH ? `…${value.slice(-4)}` : undefined;
}

function maskSecret(value: string): SecretMask {
  const last4 = last4Label(value);
  return last4 === undefined ? { set: true } : { set: true, last4 };
}

/**
 * Configuration pour l'affichage (configurateur) : mêmes champs, secrets remplacés par leur masque. Aucune valeur
 * secrète n'est présente dans le résultat.
 */
export function maskConfig(config: Config): Record<string, unknown> {
  const services: Record<string, unknown> = { ...config.services };
  for (const field of SERVICE_SECRET_FIELDS) {
    const value = config.services[field];
    if (value !== undefined) services[field] = maskSecret(value);
  }
  const masked: Record<string, unknown> = { ...config, services };
  if (config.debrid !== undefined) masked.debrid = { ...config.debrid, apiKey: maskSecret(config.debrid.apiKey) };
  masked.sources = config.sources.map((source) => ('apiKey' in source ? { ...source, apiKey: maskSecret(source.apiKey) } : source));
  return masked;
}

/**
 * Vrai si une valeur saisie signifie « garder la valeur précédente » : vide, absente, masque renvoyé tel quel, ou
 * libellé des quatre derniers caractères de la valeur précédente.
 */
function keepsPrevious(value: unknown, previous: string | undefined): boolean {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return true;
  if (isRecord(value)) return value.set === true;
  return typeof value === 'string' && previous !== undefined && value === last4Label(previous);
}

/**
 * Garde le secret précédent. Sans précédente, une valeur vide disparaît ; un masque reste une erreur : il est remplacé
 * par un objet que la validation refuse (jamais une valeur inventée ni silencieusement perdue).
 */
function keepSecret(target: Record<string, unknown>, key: string, value: unknown, before: string | undefined): void {
  if (before !== undefined) target[key] = before;
  else if (value === undefined || (typeof value === 'string' && value.trim() === '')) delete target[key];
  else target[key] = { set: true };
}

/**
 * Fusionne une modification du configurateur avec la configuration précédente (déjà déchiffrée) : pour chaque secret
 * vide, absent ou masqué, la valeur précédente est gardée. Une section `services` absente garde donc tous ses secrets.
 * Un objet `debrid` absent signifie « sans debrid » (le retirer reste possible). Les sources sont appariées par type et nom.
 */
export function mergeSecrets(patch: Record<string, unknown>, previous: Config | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...patch };

  if (patch.services === undefined || isRecord(patch.services)) {
    const services: Record<string, unknown> = { ...(isRecord(patch.services) ? patch.services : {}) };
    for (const field of SERVICE_SECRET_FIELDS) {
      const before = previous?.services[field];
      if (keepsPrevious(services[field], before)) keepSecret(services, field, services[field], before);
    }
    merged.services = services;
  }

  if (isRecord(patch.debrid)) {
    const debrid: Record<string, unknown> = { ...patch.debrid };
    const before = previous?.debrid?.apiKey;
    if (keepsPrevious(debrid.apiKey, before)) keepSecret(debrid, 'apiKey', debrid.apiKey, before);
    merged.debrid = debrid;
  }

  if (Array.isArray(patch.sources)) {
    merged.sources = patch.sources.map((item: unknown) => {
      if (!isRecord(item) || item.type === 'upstream') return item;
      const source: Record<string, unknown> = { ...item };
      const match = previous?.sources.find((candidate) => 'apiKey' in candidate && candidate.type === item.type && candidate.name === item.name);
      const before = match !== undefined && 'apiKey' in match ? match.apiKey : undefined;
      if (keepsPrevious(source.apiKey, before)) keepSecret(source, 'apiKey', source.apiKey, before);
      return source;
    });
  }

  return merged;
}
