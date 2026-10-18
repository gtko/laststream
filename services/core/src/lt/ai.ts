import type { Config } from '../config/schema.js';
import { isRecord } from '../sources/http.js';
import { digest, getJson, LtError, type LtContext, serviceKey, TTL } from './context.js';
import { tmdbGet } from './providers.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_TIMEOUT_MS = 25000;

const WHY_SYSTEM =
  'Tu es un critique de cinéma et de séries. En 2 à 3 phrases en français (60 mots maximum), ' +
  'explique pourquoi ce titre vaut le coup d’être regardé : ambiance, points forts, public visé. ' +
  'Sans spoiler, sans formule de politesse, sans titre, sans guillemets, sans markdown.';

const PERSON_SYSTEM =
  'Tu es un critique de cinéma. En 2 phrases en français (50 mots maximum), résume le style et les temps forts de la carrière ' +
  'de cette personnalité du cinéma ou des séries à partir des titres fournis. Sans formule de politesse, sans guillemets, sans markdown, ' +
  'sans inventer de faits précis (dates, prix) que tu ne peux pas déduire des titres.';

/** Langue par défaut des textes « pourquoi » (contenu TMDB et réponse IA). */
const DEFAULT_LANGUAGE = 'fr-FR';
/** Code de langue BCP 47 simple, par exemple fr ou fr-FR. */
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** Clé OpenRouter et modèle (défaut openai/gpt-4o-mini) d'une configuration. */
interface AiSettings {
  key: string;
  model: string;
}

function aiSettings(config: Config): AiSettings {
  return { key: serviceKey(config, 'openrouter'), model: config.services.openrouterModel };
}

/** Texte de la première réponse d'un chat OpenRouter ; vide si la forme n'est pas celle attendue. */
function messageContent(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.choices)) return '';
  const first: unknown = json.choices[0];
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  return typeof content === 'string' ? content : '';
}

async function complete(ctx: LtContext, ai: AiSettings, payload: Record<string, unknown>): Promise<string> {
  const json = await getJson(
    ctx,
    OPENROUTER_URL,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + ai.key,
        'content-type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'Laststream',
      },
      body: JSON.stringify({ model: ai.model, ...payload }),
    },
    AI_TIMEOUT_MS,
  );
  return messageContent(json);
}

/**
 * Texte brut sûr pour l'affichage : balises HTML retirées (répétées jusqu'à stabilité), tabulations et retours à la
 * ligne ramenés à des espaces, caractères de contrôle supprimés, espaces réduits.
 */
export function plainText(raw: string): string {
  let text = raw;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  }
  const printable = [...text.replace(/[\t\r\n]+/g, ' ')].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return !(code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0xfeff);
  });
  return printable.join('').replace(/\s+/g, ' ').trim();
}

/** Texte nettoyé du markdown et en texte brut, tronqué. Vide : 502 ai_bad_format. */
function cleanText(raw: string, max: number): string {
  const text = plainText(raw.replace(/[*_#`]/g, '')).slice(0, max);
  if (text === '') throw new LtError(502, 'ai_bad_format');
  return text;
}

/** Texte d'un champ TMDB : chaîne nettoyée et tronquée, sinon vide. */
function tmdbText(value: unknown, max: number): string {
  return typeof value === 'string' ? plainText(value).slice(0, max) : '';
}

/**
 * Référence TMDB d'un texte « pourquoi » : seuls `tmdbId` et `language` sont lus. Tout autre champ du corps (titre,
 * année, synopsis, genres, nom, etc.) est ignoré : le serveur reconstruit le contenu depuis TMDB.
 */
function tmdbRef(body: Record<string, unknown>): { id: string; lang: string } {
  const id = typeof body.tmdbId === 'number' || typeof body.tmdbId === 'string' ? String(body.tmdbId) : '';
  if (!/^\d{1,9}$/.test(id)) throw new LtError(400, 'bad_request');
  const lang = body.language === undefined ? DEFAULT_LANGUAGE : body.language;
  if (typeof lang !== 'string' || !LANGUAGE.test(lang)) throw new LtError(400, 'bad_request');
  return { id, lang };
}

/** Lecture TMDB d'un titre ou d'une personne. Une 404 amont devient 404 not_found (jamais mise en cache là). */
async function tmdbLookup(ctx: LtContext, token: string, sub: string, lang: string): Promise<unknown> {
  try {
    return await tmdbGet(ctx, token, sub, { language: lang });
  } catch (err) {
    if (err instanceof LtError && err.code === 'upstream_404') throw new LtError(404, 'not_found');
    throw err;
  }
}

interface TitleFacts {
  title: string;
  year: string;
  overview: string;
  genres: string;
}

/** Titre, année, synopsis et genres d'un film ou d'une série, dans la langue demandée. */
async function titleFacts(ctx: LtContext, token: string, kind: 'movie' | 'tv', id: string, lang: string): Promise<TitleFacts> {
  const json = await tmdbLookup(ctx, token, `${kind}/${id}`, lang);
  const data = isRecord(json) ? json : {};
  const title = tmdbText(kind === 'tv' ? data.name : data.title, 120);
  if (title === '') throw new LtError(404, 'not_found');
  const date = tmdbText(kind === 'tv' ? data.first_air_date : data.release_date, 10);
  const genres = (Array.isArray(data.genres) ? data.genres.filter(isRecord) : [])
    .slice(0, 6)
    .map((genre) => tmdbText(genre.name, 40))
    .filter((name) => name !== '');
  return {
    title,
    year: /^\d{4}/.exec(date)?.[0] ?? '',
    overview: tmdbText(data.overview, 900),
    genres: genres.join(', '),
  };
}

interface PersonFacts {
  name: string;
  known: string[];
}

const popularityOf = (credit: Record<string, unknown>): number => (typeof credit.popularity === 'number' ? credit.popularity : 0);

/** Nom d'une personne et jusqu'à 8 titres connus (les plus populaires d'abord, sans doublon), depuis TMDB. */
async function personFacts(ctx: LtContext, token: string, id: string, lang: string): Promise<PersonFacts> {
  const person = await tmdbLookup(ctx, token, `person/${id}`, lang);
  const name = tmdbText(isRecord(person) ? person.name : undefined, 100);
  if (name === '') throw new LtError(404, 'not_found');
  const credits = await tmdbLookup(ctx, token, `person/${id}/combined_credits`, lang);
  const cast = isRecord(credits) && Array.isArray(credits.cast) ? credits.cast.filter(isRecord) : [];
  const known: string[] = [];
  for (const credit of [...cast].sort((a, b) => popularityOf(b) - popularityOf(a))) {
    const label = tmdbText(credit.title ?? credit.name, 80);
    if (label !== '' && !known.includes(label)) known.push(label);
    if (known.length === 8) break;
  }
  return { name, known };
}

export interface HistoryItem {
  title: string;
  year: number | null;
  type: 'movie' | 'tv';
}

/** Historique ou titres aimés : 10 entrées au plus, titre borné, année plausible. */
function sanitizeList(list: unknown): HistoryItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 10)
    .map((x: unknown): HistoryItem => {
      const rec = isRecord(x) ? x : {};
      const year = rec.year;
      return {
        title: (typeof rec.title === 'string' ? rec.title : '').trim().slice(0, 120),
        year: typeof year === 'number' && Number.isInteger(year) && year > 1900 && year < 2100 ? year : null,
        type: rec.type === 'tv' ? 'tv' : 'movie',
      };
    })
    .filter((x) => x.title !== '');
}

/** Extrait le premier objet JSON d'un texte (le modèle ajoute parfois du texte autour). */
function extractJSON(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LtError(502, 'ai_bad_format');
  return text.slice(start, end + 1);
}

/** Recommandations : nombre de titres par défaut, plafond, et titres demandés en plus (compensent les non-résolus et les exclus). */
const RECOMMEND_DEFAULT_COUNT = 50;
const RECOMMEND_MAX_COUNT = 80;
const RECOMMEND_SPARE = 15;
/** Un appel au modèle par angle, en parallèle : titres dans les goûts, puis découvertes. */
const RECOMMEND_ANGLES = [
  'dans les goûts de l’utilisateur : proches de son historique, de ses titres aimés et de ses notes 4 à 5',
  'découvertes : titres moins connus ou inattendus, hors des habitudes visibles, qui devraient pourtant lui plaire',
] as const;
const RECOMMEND_EXCLUDE_MAX = 500;
const RECOMMEND_RATINGS_MAX = 100;
/** Bornes fixes du prompt : quel que soit le corps reçu, la partie « notes » et « déjà vus » reste petite. */
const RECOMMEND_RATINGS_IN_PROMPT = 40;
const RECOMMEND_EXCLUDED_IN_PROMPT = 30;
/** Résolutions TMDB simultanées (les résultats de recherche sont mis en cache par tmdbGet). */
const RESOLVE_CONCURRENCY = 6;
/** Budget de jetons par titre demandé (sortie compacte {t,y,k,r}). */
const TOKENS_PER_ITEM = 60;

interface Suggestion {
  title: string;
  year: number | null;
  type: 'movie' | 'tv';
  reason: string;
}

/** Titre de comparaison : sans accents ni ponctuation, en minuscules. */
function normalizeTitle(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Note valide : de 0 à 5 par pas de 0,5. */
function isRating(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 5 && Number.isInteger(value * 2);
}

interface RatedTitle {
  title: string;
  year: number | null;
  type: 'movie' | 'tv';
  rating: number;
}

/** Notes de l'utilisateur (`ratings`) : 100 entrées au plus, les entrées invalides sont ignorées. */
function ratingsOf(list: unknown): RatedTitle[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > RECOMMEND_RATINGS_MAX) throw new LtError(400, 'bad_request');
  return list.filter(isRecord).flatMap((x): RatedTitle[] => {
    const title = typeof x.title === 'string' ? x.title.trim().slice(0, 120) : '';
    if (title === '' || !isRating(x.rating)) return [];
    const year = x.year;
    return [
      {
        title,
        year: typeof year === 'number' && Number.isInteger(year) ? year : null,
        type: x.type === 'tv' || x.type === 'series' ? 'tv' : 'movie',
        rating: x.rating,
      },
    ];
  });
}

/** Exclusion : un titre déjà vu ou suivi, par identifiant TMDB ou par titre et année. */
type Exclusion =
  | { kind: 'id'; type: 'movie' | 'tv'; tmdbId: number }
  | { kind: 'title'; label: string; key: string; year: number | null };

/** `exclude` : 500 entrées au plus ; les entrées sans identifiant ni titre sont ignorées. */
function exclusionsOf(list: unknown): Exclusion[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > RECOMMEND_EXCLUDE_MAX) throw new LtError(400, 'bad_request');
  return list.filter(isRecord).flatMap((x): Exclusion[] => {
    const type = x.type === 'movie' ? 'movie' : x.type === 'series' || x.type === 'tv' ? 'tv' : null;
    if (type !== null && typeof x.tmdbId === 'number' && Number.isInteger(x.tmdbId) && x.tmdbId > 0) {
      return [{ kind: 'id', type, tmdbId: x.tmdbId }];
    }
    const label = typeof x.title === 'string' ? x.title.trim().slice(0, 200) : '';
    const key = normalizeTitle(label);
    if (key === '') return [];
    const year = x.year;
    return [{ kind: 'title', label, key, year: typeof year === 'number' && Number.isInteger(year) ? year : null }];
  });
}

/** Nombre de titres voulu : entier de 1 à 80, 50 par défaut. */
function countOf(body: Record<string, unknown>): number {
  const count = body.count;
  if (count === undefined) return RECOMMEND_DEFAULT_COUNT;
  if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= RECOMMEND_MAX_COUNT) return count;
  throw new LtError(400, 'bad_request');
}

/** Contexte utilisateur du prompt : historique, titres aimés, notes sur 5, titres déjà vus (bornés). */
function promptContext(history: HistoryItem[], liked: HistoryItem[], ratings: RatedTitle[], exclude: Exclusion[]): string {
  const fmt = (arr: HistoryItem[]): string =>
    arr.length ? arr.map((x) => `${x.title}${x.year ? ' (' + x.year + ')' : ''} [${x.type}]`).join(', ') : 'aucun';
  const lines = [`Historique récent : ${fmt(history)}`, `Titres aimés : ${fmt(liked)}`];
  if (ratings.length > 0) {
    const shown = [...ratings].sort((a, b) => b.rating - a.rating).slice(0, RECOMMEND_RATINGS_IN_PROMPT);
    const list = shown.map((r) => `${r.title}${r.year ? ' (' + r.year + ')' : ''} [${r.type}] ${r.rating}`).join(', ');
    lines.push(
      `Notes de l'utilisateur sur 5 : ${list}. Privilégie ce qui ressemble aux titres notés 4–5, évite ce qui ressemble aux titres notés 0–2.`,
    );
  }
  const seen = exclude.flatMap((entry) => (entry.kind === 'title' ? [entry.label] : [])).slice(0, RECOMMEND_EXCLUDED_IN_PROMPT);
  if (seen.length > 0) lines.push(`Déjà vus ou suivis (ne pas proposer) : ${seen.join(', ')}`);
  return lines.join('\n');
}

/** Un appel au modèle : `count` titres, selon l'angle donné. Sortie compacte, budget de jetons proportionné. */
async function askModel(ctx: LtContext, ai: AiSettings, count: number, angle: string, context: string): Promise<Suggestion[]> {
  const text = await complete(ctx, ai, {
    temperature: 0.7,
    max_tokens: count * TOKENS_PER_ITEM + 200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Tu es un recommandeur de films et de séries. Réponds uniquement avec un objet JSON compact de la forme ' +
          '{"items":[{"t":"Titre original","y":2000,"k":"movie" ou "tv","r":"raison courte en français"}]}, sans texte autour. ' +
          `Donne exactement ${count} titres réels et distincts, qui ne figurent pas parmi les titres déjà cités. ` +
          `r fait au plus 120 caractères. Angle : ${angle}.`,
      },
      { role: 'user', content: context },
    ],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSON(text)) as unknown;
  } catch {
    throw new LtError(502, 'ai_bad_format');
  }
  const items: unknown[] = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return items
    .filter(isRecord)
    .map((x): Suggestion => {
      const year = x.y;
      return {
        title: plainText(typeof x.t === 'string' ? x.t : '').slice(0, 120),
        year: typeof year === 'number' && Number.isInteger(year) ? year : null,
        type: x.k === 'tv' ? 'tv' : 'movie',
        reason: plainText(typeof x.r === 'string' ? x.r : '').slice(0, 160),
      };
    })
    .filter((x) => x.title !== '');
}

/** Résout un titre suggéré en résultat TMDB (affiche de préférence). Échec : null, sans bloquer les autres. */
async function resolveTitle(ctx: LtContext, token: string, item: Suggestion): Promise<Record<string, unknown> | null> {
  const params: Record<string, string> = { query: item.title, include_adult: 'false' };
  if (item.year !== null) params[item.type === 'tv' ? 'first_air_date_year' : 'year'] = String(item.year);
  try {
    const json = await tmdbGet(ctx, token, 'search/' + item.type, params);
    const results: Record<string, unknown>[] =
      isRecord(json) && Array.isArray(json.results) ? json.results.filter(isRecord) : [];
    const hit = results.find((r) => Boolean(r.poster_path)) ?? results[0];
    if (hit === undefined) return null;
    return { ...hit, media_type: item.type, reason_fr: item.reason };
  } catch {
    return null;
  }
}

/** Année d'un résultat TMDB (film ou série), ou null. */
function yearOf(hit: Record<string, unknown>): number | null {
  const date = typeof hit.release_date === 'string' ? hit.release_date : typeof hit.first_air_date === 'string' ? hit.first_air_date : '';
  return /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
}

function isExcluded(hit: Record<string, unknown>, exclude: readonly Exclusion[]): boolean {
  const type = hit.media_type === 'tv' ? 'tv' : 'movie';
  const names = [hit.title, hit.name, hit.original_title, hit.original_name]
    .filter((name): name is string => typeof name === 'string')
    .map(normalizeTitle);
  const year = yearOf(hit);
  return exclude.some((entry) =>
    entry.kind === 'id' ? entry.type === type && entry.tmdbId === hit.id : names.includes(entry.key) && (entry.year === null || entry.year === year),
  );
}

/** Applique `load` à chaque élément, au plus `limit` à la fois. Ordre des résultats conservé. */
async function mapLimit<T, R>(items: readonly T[], limit: number, load: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await load(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Recommandations : deux appels parallèles au modèle (count + 15 titres au total, un angle chacun), résolus via TMDB
 * (6 à la fois), puis dédoublonnés et filtrés (exclusions, titres non résolus). Renvoie au plus `count` titres.
 * Cache 30 min par charge utile, notes incluses (empreinte).
 */
export async function recommend(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<unknown> {
  const ai = aiSettings(config);
  const token = serviceKey(config, 'tmdb');
  const history = sanitizeList(body.history);
  const liked = sanitizeList(body.liked);
  const ratings = ratingsOf(body.ratings);
  const exclude = exclusionsOf(body.exclude);
  const count = countOf(body);
  const cacheKey = `ai:${digest({ history, liked, ratings: digest(ratings), exclude, count, model: ai.model })}`;
  return ctx.state.cache.get(cacheKey, TTL.aiRecommend, async () => {
    const perCall = Math.ceil((count + RECOMMEND_SPARE) / RECOMMEND_ANGLES.length);
    const context = promptContext(history, liked, ratings, exclude);
    const batches = await Promise.all(RECOMMEND_ANGLES.map((angle) => askModel(ctx, ai, perCall, angle, context)));
    const resolved = await mapLimit(batches.flat(), RESOLVE_CONCURRENCY, (item) => resolveTitle(ctx, token, item));
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];
    for (const hit of resolved) {
      if (hit === null || isExcluded(hit, exclude)) continue;
      const hitKey = `${String(hit.media_type)}${String(hit.id)}`;
      if (seen.has(hitKey)) continue;
      seen.add(hitKey);
      items.push(hit);
    }
    return { items: items.slice(0, count) };
  });
}

/**
 * « Pourquoi tu vas aimer » : 2 à 3 phrases en français pour un titre. Corps accepté : `type` (movie ou tv), `tmdbId`,
 * `language` (défaut fr-FR). Titre, année, synopsis et genres viennent de TMDB. Cache partagé de 7 jours par
 * `${type}:${tmdbId}:${language}`, seulement en cas de réponse réussie.
 */
export async function why(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<{ text: string }> {
  const ai = aiSettings(config);
  const kind = body.type === 'tv' ? 'tv' : body.type === 'movie' ? 'movie' : null;
  if (kind === null) throw new LtError(400, 'bad_request');
  const { id, lang } = tmdbRef(body);
  const token = serviceKey(config, 'tmdb');
  return ctx.state.cache.get(`why:${kind}:${id}:${lang}`, TTL.aiText, async () => {
    const facts = await titleFacts(ctx, token, kind, id, lang);
    const raw = await complete(ctx, ai, {
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        { role: 'system', content: WHY_SYSTEM },
        {
          role: 'user',
          content: `Titre : ${facts.title}${facts.year ? ' (' + facts.year + ')' : ''}\nGenres : ${facts.genres || 'inconnus'}\nSynopsis : ${facts.overview || 'non fourni'}`,
        },
      ],
    });
    return { text: cleanText(raw, 600) };
  });
}

/**
 * « En deux mots » sur une personne. Corps accepté : `tmdbId`, `language` (défaut fr-FR). Nom et titres connus
 * viennent de TMDB. Cache partagé de 7 jours par `person:${tmdbId}:${language}`.
 */
export async function personWhy(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<{ text: string }> {
  const ai = aiSettings(config);
  const { id, lang } = tmdbRef(body);
  const token = serviceKey(config, 'tmdb');
  return ctx.state.cache.get(`pwhy:person:${id}:${lang}`, TTL.aiText, async () => {
    const facts = await personFacts(ctx, token, id, lang);
    const raw = await complete(ctx, ai, {
      temperature: 0.6,
      max_tokens: 200,
      messages: [
        { role: 'system', content: PERSON_SYSTEM },
        { role: 'user', content: 'Personne : ' + facts.name + '\nTitres connus : ' + (facts.known.join(', ') || 'non fournis') },
      ],
    });
    return { text: cleanText(raw, 500) };
  });
}
