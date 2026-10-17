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

/** Texte nettoyé du markdown, tronqué. Vide : 502 ai_bad_format. */
function cleanText(raw: string, max: number): string {
  const text = raw.replace(/[*_#`]/g, '').trim().slice(0, max);
  if (text === '') throw new LtError(502, 'ai_bad_format');
  return text;
}

/** Valeur texte d'un champ du corps (chaîne ou nombre), sinon chaîne vide. */
function textOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
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
        title: (typeof x.title === 'string' ? x.title : '').trim().slice(0, 120),
        year: typeof year === 'number' && Number.isInteger(year) ? year : null,
        type: x.type === 'tv' ? 'tv' : 'movie',
        reason: (typeof x.reason_fr === 'string' ? x.reason_fr : '').slice(0, 160),
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

/** Recommandations : OpenRouter propose 10 titres, TMDB les résout. Exige OpenRouter et TMDB. */
export async function recommend(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<unknown> {
  const ai = aiSettings(config);
  const token = serviceKey(config, 'tmdb');
  const history = sanitizeList(body.history);
  const liked = sanitizeList(body.liked);
  return ctx.state.cache.get(`ai:${digest({ history, liked, model: ai.model })}`, TTL.ai, async () => {
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

/** « Pourquoi tu vas aimer » : 2 à 3 phrases en français pour un titre. */
export async function why(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<{ text: string }> {
  const ai = aiSettings(config);
  const title = textOf(body.title).trim().slice(0, 120);
  if (title === '') throw new LtError(400, 'bad_request');
  const year = textOf(body.year).replace(/\D/g, '').slice(0, 4);
  const overview = textOf(body.overview).trim().slice(0, 900);
  const genres = (Array.isArray(body.genres) ? body.genres : [])
    .slice(0, 6)
    .map((g: unknown) => String(g).slice(0, 40))
    .join(', ');
  return ctx.state.cache.get(`why:${digest([title, year, overview, genres])}`, TTL.ai, async () => {
    const raw = await complete(ctx, ai, {
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        { role: 'system', content: WHY_SYSTEM },
        {
          role: 'user',
          content: `Titre : ${title}${year ? ' (' + year + ')' : ''}\nGenres : ${genres || 'inconnus'}\nSynopsis : ${overview || 'non fourni'}`,
        },
      ],
    });
    return { text: cleanText(raw, 600) };
  });
}

/** « En deux mots » sur une personne, à partir de quelques titres connus. */
export async function personWhy(ctx: LtContext, config: Config, body: Record<string, unknown>): Promise<{ text: string }> {
  const ai = aiSettings(config);
  const name = textOf(body.name).trim().slice(0, 100);
  if (name === '') throw new LtError(400, 'bad_request');
  const known = (Array.isArray(body.knownFor) ? body.knownFor : [])
    .slice(0, 8)
    .map((t: unknown) => String(t).slice(0, 80))
    .filter(Boolean);
  return ctx.state.cache.get(`pwhy:${digest([name, known])}`, TTL.ai, async () => {
    const raw = await complete(ctx, ai, {
      temperature: 0.6,
      max_tokens: 200,
      messages: [
        { role: 'system', content: PERSON_SYSTEM },
        { role: 'user', content: 'Personne : ' + name + '\nTitres connus : ' + (known.join(', ') || 'non fournis') },
      ],
    });
    return { text: cleanText(raw, 500) };
  });
}
