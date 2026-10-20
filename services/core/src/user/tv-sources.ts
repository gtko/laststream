import { isRecord } from '../sources/http.js';
import { UserApiError } from './validation.js';

/** Séparation de clé : les sources TV ne se déchiffrent pas avec la clé des configurations. */
export const TV_SOURCES_PURPOSE = 'tv-sources';

const MAX_TV_LISTS = 20;
const MAX_URL = 2048;
const MAX_NAME = 80;
const MAX_ID = 64;

export interface TvSource {
  id: string;
  name: string;
  kind: 'url' | 'freebox';
  url: string;
  guideUrl: string;
  enabled: boolean;
}

function httpUrl(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== 'string') throw new UserApiError(400, 'invalid_body', [`${field}:chaine_attendue`]);
  if (value === '' && allowEmpty) return '';
  if (value.length > MAX_URL) throw new UserApiError(400, 'invalid_body', [`${field}:trop_longue`]);
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:') return value;
  } catch {
    /* URL invalide : rejet ci-dessous, sans recopier la valeur */
  }
  throw new UserApiError(400, 'invalid_body', [`${field}:url_http_attendue`]);
}

/** Valide la liste reçue (null = suppression). Les messages d'erreur ne contiennent jamais les URL. */
export function parseTvSources(value: unknown): TvSource[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new UserApiError(400, 'invalid_body', ['lists:tableau_attendu']);
  if (value.length > MAX_TV_LISTS) throw new UserApiError(400, 'invalid_body', ['lists:trop_nombreuses']);
  return value.map((raw, i): TvSource => {
    const at = `lists[${i}]`;
    if (!isRecord(raw)) throw new UserApiError(400, 'invalid_body', [`${at}:objet_attendu`]);
    const { id, name, kind, enabled } = raw;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) throw new UserApiError(400, 'invalid_body', [`${at}.id:invalide`]);
    if (typeof name !== 'string' || name.length > MAX_NAME) throw new UserApiError(400, 'invalid_body', [`${at}.name:invalide`]);
    if (kind !== 'url' && kind !== 'freebox') throw new UserApiError(400, 'invalid_body', [`${at}.kind:invalide`]);
    if (typeof enabled !== 'boolean') throw new UserApiError(400, 'invalid_body', [`${at}.enabled:booleen_attendu`]);
    return {
      id,
      name,
      kind,
      url: httpUrl(raw.url, `${at}.url`, false),
      guideUrl: httpUrl(raw.guideUrl ?? '', `${at}.guideUrl`, true),
      enabled,
    };
  });
}
