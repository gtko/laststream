import type { Config } from '../config/schema.js';
import { isRecord } from '../sources/http.js';
import { digest, getJson, LtError, type LtContext, serviceKey, TTL } from './context.js';
import { tmdbGet } from './providers.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_TIMEOUT_MS = 25000;

const AI_SYSTEM =
  'Tu es un recommandeur de films et de séries. Réponds uniquement avec un objet JSON valide ' +
  'de la forme {"items":[{"title":"Titre original","year":2000,"type":"movie" ou "tv","reason_fr":"raison courte en français"}]}. ' +
  "Donne exactement 10 titres réels, différents de ceux de l'historique, adaptés aux goûts exprimés. " +
  'reason_fr fait au plus 110 caractères.';

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

interface Suggestion {
  title: string;
  year: number | null;
  type: 'movie' | 'tv';
  reason: string;
}

async function askModel(ctx: LtContext, ai: AiSettings, history: HistoryItem[], liked: HistoryItem[]): Promise<Suggestion[]> {
  const fmt = (arr: HistoryItem[]): string =>
    arr.length ? arr.map((x) => `${x.title}${x.year ? ' (' + x.year + ')' : ''} [${x.type}]`).join(', ') : 'aucun';
  const text = await complete(ctx, ai, {
    temperature: 0.7,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: `Historique récent : ${fmt(history)}\nTitres aimés : ${fmt(liked)}` },
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
      const year = x.year;
      return {
        title: plainText(typeof x.title === 'string' ? x.title : '').slice(0, 120),
        year: typeof year === 'number' && Number.isInteger(year) ? year : null,
        type: x.type === 'tv' ? 'tv' : 'movie',
        reason: plainText(typeof x.reason_fr === 'string' ? x.reason_fr : '').slice(0, 160),
      };
    })
    .filter((x) => x.title !== '')
    .slice(0, 12);
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

/** Recommandations : OpenRouter propose 10 titres, TMDB les résout. Exige OpenRouter et TMDB. Cache 30 min par charge utile. */
export async function recommend(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<unknown> {
  const ai = aiSettings(config);
  const token = serviceKey(config, 'tmdb');
  const history = sanitizeList(body.history);
  const liked = sanitizeList(body.liked);
  return ctx.state.cache.get(`ai:${digest({ history, liked, model: ai.model })}`, TTL.aiRecommend, async () => {
    const suggestions = await askModel(ctx, ai, history, liked);
    const resolved = await Promise.all(suggestions.slice(0, 10).map((item) => resolveTitle(ctx, token, item)));
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];
    for (const hit of resolved) {
      if (hit === null) continue;
      const key = `${String(hit.media_type)}${String(hit.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(hit);
    }
    return { items };
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
