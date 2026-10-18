import { DEFAULT_INVITE_QUOTA } from './social-store.js';
import type { SqlDb } from './sql.js';

/** Réglages globaux de l'application, stockés dans la table `app_settings` (clé → JSON). */
export interface MaintenanceSetting {
  enabled: boolean;
  /** Message affiché aux utilisateurs (texte brut, 500 caractères au plus). */
  message: string;
}

export interface AppSettings {
  /** Quota de liens de parrainage donné aux nouveaux comptes. */
  inviteDefaultQuota: number;
  /** Inscriptions par lien de parrainage ouvertes (le premier compte et le mode d'inscription libre ne sont pas concernés). */
  invitesOpen: boolean;
  maintenance: MaintenanceSetting;
}

export const MAX_MAINTENANCE_MESSAGE = 500;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  inviteDefaultQuota: DEFAULT_INVITE_QUOTA,
  invitesOpen: true,
  maintenance: { enabled: false, message: '' },
};

const KEYS = { quota: 'invite_default_quota', open: 'invites_open', maintenance: 'maintenance' } as const;

function parse(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Réglages courants (valeurs par défaut pour toute clé absente ou illisible). */
export function readAppSettings(db: SqlDb): AppSettings {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const raw = new Map(rows.map((row) => [String(row.key), String(row.value)]));
  const quota = parse(raw.get(KEYS.quota));
  const open = parse(raw.get(KEYS.open));
  const maintenance = parse(raw.get(KEYS.maintenance));
  const maint = typeof maintenance === 'object' && maintenance !== null ? (maintenance as Partial<MaintenanceSetting>) : {};
  return {
    inviteDefaultQuota: typeof quota === 'number' && Number.isInteger(quota) && quota >= 0 ? quota : DEFAULT_APP_SETTINGS.inviteDefaultQuota,
    invitesOpen: typeof open === 'boolean' ? open : DEFAULT_APP_SETTINGS.invitesOpen,
    maintenance: {
      enabled: maint.enabled === true,
      message: typeof maint.message === 'string' ? maint.message.slice(0, MAX_MAINTENANCE_MESSAGE) : '',
    },
  };
}

/** Écrit les réglages fournis (les autres restent inchangés) et renvoie l'état résultant. */
export function writeAppSettings(db: SqlDb, patch: Partial<AppSettings>): AppSettings {
  const upsert = (key: string, value: unknown): void => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  };
  db.transaction(() => {
    if (patch.inviteDefaultQuota !== undefined) upsert(KEYS.quota, patch.inviteDefaultQuota);
    if (patch.invitesOpen !== undefined) upsert(KEYS.open, patch.invitesOpen);
    if (patch.maintenance !== undefined) upsert(KEYS.maintenance, { enabled: patch.maintenance.enabled, message: patch.maintenance.message.slice(0, MAX_MAINTENANCE_MESSAGE) });
  });
  return readAppSettings(db);
}
