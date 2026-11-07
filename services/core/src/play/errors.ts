/** Raisons d'échec de /play. Chaque raison a un titre, une explication, un conseil et un statut HTTP. */
export type PlayFailureReason =
  | 'not_cached'
  | 'dead_link'
  | 'host_unavailable'
  | 'age_limit'
  | 'subscription_expired'
  | 'invalid_key'
  | 'file_not_found'
  | 'not_released'
  | 'no_copy'
  | 'unsupported_format'
  | 'timeout'
  | 'quota'
  | 'unknown';

/** Description d'une raison d'échec, en français. Texte fixe : aucune donnée utilisateur n'y entre. */
export interface PlayFailureInfo {
  status: number;
  title: string;
  explanation: string;
  advice: string;
}

/** Table des raisons d'échec de /play. */
export const PLAY_FAILURES: Readonly<Record<PlayFailureReason, PlayFailureInfo>> = {
  not_cached: {
    status: 404,
    title: 'Pas en cache',
    explanation: 'Ce contenu n’est pas encore disponible en cache chez AllDebrid.',
    advice: 'Réessayez plus tard ou choisissez un autre flux.',
  },
  dead_link: {
    status: 410,
    title: 'Lien mort',
    explanation: 'Le lien de ce fichier n’est plus valide.',
    advice: 'Choisissez un autre flux.',
  },
  host_unavailable: {
    status: 503,
    title: 'Hébergeur indisponible',
    explanation: 'L’hébergeur du fichier ne répond pas pour le moment.',
    advice: 'Réessayez dans quelques minutes.',
  },
  age_limit: {
    status: 403,
    title: 'Limite d’âge',
    explanation: 'Ce contenu est soumis à une limite d’âge que le service ne permet pas de lire.',
    advice: 'Choisissez un autre flux.',
  },
  subscription_expired: {
    status: 402,
    title: 'Abonnement AllDebrid expiré',
    explanation: 'Votre abonnement AllDebrid n’est plus actif.',
    advice: 'Renouvelez votre abonnement AllDebrid, puis réessayez.',
  },
  invalid_key: {
    status: 401,
    title: 'Clé API invalide',
    explanation: 'La clé API AllDebrid de la configuration est refusée.',
    advice: 'Vérifiez la clé API AllDebrid dans la configuration de l’addon.',
  },
  file_not_found: {
    status: 404,
    title: 'Fichier introuvable dans le pack',
    explanation: 'Le fichier demandé n’existe pas dans ce pack.',
    advice: 'Choisissez un autre flux.',
  },
  not_released: {
    status: 404,
    title: 'Épisode non sorti',
    explanation: 'Cet épisode n’est pas encore disponible.',
    advice: 'Revenez quand il sera sorti.',
  },
  no_copy: {
    status: 404,
    title: 'Aucune copie disponible',
    explanation: 'Aucune copie n’est disponible pour ce contenu.',
    advice: 'Essayez un autre contenu ou revenez plus tard.',
  },
  unsupported_format: {
    status: 415,
    title: 'Format non lu',
    explanation: 'Le format de ce fichier n’est pas lisible par le lecteur.',
    advice: 'Choisissez un autre flux.',
  },
  timeout: {
    status: 504,
    title: 'Délai dépassé',
    explanation: 'Le service a mis trop de temps à répondre.',
    advice: 'Réessayez dans un instant.',
  },
  quota: {
    status: 429,
    title: 'Quota atteint',
    explanation: 'Le quota d’utilisation du service est atteint.',
    advice: 'Réessayez plus tard.',
  },
  unknown: {
    status: 500,
    title: 'Erreur inconnue',
    explanation: 'Une erreur inattendue est survenue.',
    advice: 'Réessayez ; si le problème persiste, consultez les journaux de l’addon.',
  },
};

/** Vrai si la valeur est une raison d'échec connue (et non une clé héritée de l'objet). */
export function isPlayFailureReason(value: unknown): value is PlayFailureReason {
  return typeof value === 'string' && Object.hasOwn(PLAY_FAILURES, value);
}

/** Statut HTTP d'une raison. Une raison inconnue donne le statut de « unknown ». */
export function failureStatus(reason: unknown): number {
  return failureInfo(reason).status;
}

function failureInfo(reason: unknown): PlayFailureInfo {
  return PLAY_FAILURES[isPlayFailureReason(reason) ? reason : 'unknown'];
}

/** Échappement HTML strict (&, <, >, ", ') pour toute valeur insérée dans la page. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rendu d'un échec : statut, type de contenu et corps (JSON ou page HTML). */
export interface RenderedFailure {
  status: number;
  contentType: string;
  body: string;
}

export interface RenderFailureOptions {
  /** Valeur de l'en-tête Accept de la requête. Absent : page HTML. */
  accept?: string | undefined;
}

interface AcceptQuality {
  q: number;
  /** Vrai si le type est nommé explicitement (et non seulement couvert par un wildcard). */
  explicit: boolean;
}

/**
 * Qualité (q) d'un type média dans un en-tête Accept : valeur exacte, sinon wildcard du même sous-type
 * principal (text suivi de /*), sinon le wildcard global. q vaut 0 si le type n'est pas accepté.
 */
function acceptQuality(accept: string, type: string): AcceptQuality {
  const [major = ''] = type.split('/');
  let exact: number | undefined;
  let partial: number | undefined;
  let any: number | undefined;
  for (const range of accept.split(',')) {
    const [rawType = '', ...params] = range.trim().toLowerCase().split(';');
    const q = qualityParam(params);
    const mediaType = rawType.trim();
    if (mediaType === type) exact = Math.max(exact ?? 0, q);
    else if (mediaType === `${major}/*`) partial = Math.max(partial ?? 0, q);
    else if (mediaType === '*/*') any = Math.max(any ?? 0, q);
  }
  if (exact !== undefined) return { q: exact, explicit: true };
  if (partial !== undefined) return { q: partial, explicit: false };
  return { q: any ?? 0, explicit: false };
}

function qualityParam(params: readonly string[]): number {
  for (const param of params) {
    const [name = '', value = ''] = param.trim().split('=');
    if (name.trim() !== 'q') continue;
    const q = Number(value.trim());
    return Number.isFinite(q) ? Math.min(Math.max(q, 0), 1) : 1;
  }
  return 1;
}

/**
 * JSON si le client accepte application/json mieux que text/html. À égalité, JSON gagne seulement si JSON
 * est nommé explicitement et que HTML n'est accepté que par le wildcard global (ex. « application/json » suivi
 * du wildcard global). Sinon HTML.
 */
function wantsJson(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  const json = acceptQuality(accept, 'application/json');
  const html = acceptQuality(accept, 'text/html');
  if (json.q <= 0) return false;
  if (json.q !== html.q) return json.q > html.q;
  return json.explicit && !html.explicit;
}

/**
 * Corps de réponse d'un échec de /play. JSON `{error, reason, message}` si Accept demande du JSON,
 * sinon une petite page HTML en français, sans script ni style. Seules les valeurs fixes de la table sont
 * écrites : une raison inconnue devient « unknown ». Aucune donnée de requête n'entre dans le rendu.
 */
export function renderFailure(reason: unknown, opts: RenderFailureOptions = {}): RenderedFailure {
  const key: PlayFailureReason = isPlayFailureReason(reason) ? reason : 'unknown';
  const info = PLAY_FAILURES[key];
  if (wantsJson(opts.accept)) {
    return {
      status: info.status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        error: 'play_failed',
        reason: key,
        message: `${info.title} : ${info.explanation} ${info.advice}`,
      }),
    };
  }
  const title = escapeHtml(info.title);
  return {
    status: info.status,
    contentType: 'text/html; charset=utf-8',
    body: [
      '<!doctype html>',
      '<html lang="fr">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="color-scheme" content="light dark">',
      `<title>Lecture impossible : ${title}</title>`,
      '</head>',
      '<body>',
      '<main>',
      '<h1>Lecture impossible</h1>',
      `<h2>${title}</h2>`,
      `<p>${escapeHtml(info.explanation)}</p>`,
      `<p>${escapeHtml(info.advice)}</p>`,
      `<p><small>Erreur ${info.status} · code ${escapeHtml(key)}</small></p>`,
      '</main>',
      '</body>',
      '</html>',
    ].join('\n'),
  };
}
