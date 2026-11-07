// Catalogue OpenRouter : lecture défensive, prix et badges, estimation, recherche sans accents, tri, cache 24 h, repli réseau.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  badges, CACHE_KEY, CACHE_TTL_MS, cachedModels, ctxLabel, ESTIMATE_INPUT_TOKENS, ESTIMATE_OUTPUT_TOKENS, ESTIMATE_RUNS, estimateCost,
  estimateText, filterModels, groupModels, isFreeModel, loadModels, money, MODELS_URL, normalize, parseModels, priceLabel, type OrModel,
} from '../src/data/openrouterModels';

const sp = (s: string) => s.replace(/ /g, ' ');

const RAW = {
  data: [
    { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', context_length: 128000, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    { id: 'openai/gpt-4o-mini', name: 'doublon', pricing: { prompt: '1', completion: '1' } },
    { id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4', context_length: 1000000, pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct (free)', context_length: 65536, pricing: { prompt: '0', completion: '0' } },
    { id: 'google/gemini-2.0-flash', name: 'Google: Gemini 2.0 Flash', top_provider: { context_length: 1048576 }, pricing: { prompt: 0.0000001, completion: 0.0000004 } },
    { id: 'openrouter/auto', name: 'Auto Router', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'mistralai/mistral-large', name: 'Mistral: Mistral Large', pricing: { prompt: '0.000002', completion: '0.000006' } },
    { id: 'mistralai/mistral-large-2407', name: 'Mistral Large 2407' },
    { id: 'zeta/éclair', name: 'Éclair Rapide', context_length: 'abc', pricing: null },
    { name: 'sans identifiant' }, null, 'texte', { id: '   ' },
  ],
};

const byId = (list: OrModel[], id: string) => list.find((m) => m.id === id) as OrModel;

describe('parseModels', () => {
  const list = parseModels(RAW);

  it('ignore les entrées invalides et dédoublonne par identifiant (la première gagne)', () => {
    expect(list.map((m) => m.id).sort()).toEqual([
      'anthropic/claude-sonnet-4', 'google/gemini-2.0-flash', 'meta-llama/llama-3.3-70b-instruct:free', 'mistralai/mistral-large',
      'mistralai/mistral-large-2407', 'openai/gpt-4o-mini', 'openrouter/auto', 'zeta/éclair',
    ]);
    expect(byId(list, 'openai/gpt-4o-mini').name).toBe('GPT-4o-mini');
  });

  it('convertit les prix $/token (chaînes ou nombres) en $ par million', () => {
    const m = byId(list, 'openai/gpt-4o-mini');
    expect(m.inPrice).toBeCloseTo(0.15);
    expect(m.outPrice).toBeCloseTo(0.6);
    expect(byId(list, 'google/gemini-2.0-flash').inPrice).toBeCloseTo(0.1);
    expect(byId(list, 'openrouter/auto').inPrice).toBeNull();
    expect(byId(list, 'zeta/éclair').inPrice).toBeNull();
  });

  it('fournisseur tiré du nom, sinon du préfixe de l’identifiant ; contexte manquant à 0', () => {
    expect(byId(list, 'anthropic/claude-sonnet-4').provider).toBe('Anthropic');
    expect(byId(list, 'mistralai/mistral-large-2407').provider).toBe('Mistral');
    expect(byId(list, 'openrouter/auto').provider).toBe('Openrouter');
    expect(byId(list, 'meta-llama/llama-3.3-70b-instruct:free').name).toBe('Llama 3.3 70B Instruct');
    expect(byId(list, 'google/gemini-2.0-flash').ctx).toBe(1048576);
    expect(byId(list, 'zeta/éclair').ctx).toBe(0);
  });

  it('réponse illisible : liste vide', () => {
    expect(parseModels(null)).toEqual([]);
    expect(parseModels({ data: 'x' })).toEqual([]);
  });
});

describe('prix, contexte et badges', () => {
  const list = parseModels(RAW);

  it('formats français', () => {
    expect(sp(priceLabel(byId(list, 'openai/gpt-4o-mini')))).toBe('0,15 $ / 0,60 $');
    expect(priceLabel(byId(list, 'meta-llama/llama-3.3-70b-instruct:free'))).toBe('Gratuit');
    expect(priceLabel(byId(list, 'openrouter/auto'))).toBe('Prix variable');
    expect(sp(money(0.075))).toBe('0,075 $');
    expect(sp(money(0))).toBe('0 $');
    expect(sp(ctxLabel(128000))).toBe('128 k');
    expect(sp(ctxLabel(1000000))).toBe('1 M');
    expect(ctxLabel(0)).toBe('');
  });

  it('Gratuit (prix nul ou suffixe :free), Économique (≤ 1 $/M), Long contexte (≥ 500 k)', () => {
    const free = { id: 'x/y:free', name: 'y', provider: 'X', ctx: 1000, inPrice: 0.5, outPrice: 0.5 };
    expect(isFreeModel(free)).toBe(true);
    expect(badges(free)).toEqual({ free: true, eco: false, long: false });
    expect(badges(byId(list, 'openai/gpt-4o-mini'))).toEqual({ free: false, eco: true, long: false });
    expect(badges(byId(list, 'anthropic/claude-sonnet-4'))).toEqual({ free: false, eco: false, long: true });
    expect(badges(byId(list, 'openrouter/auto')).eco).toBe(false);
  });

  it('estimation pour 100 recommandations', () => {
    expect([ESTIMATE_RUNS, ESTIMATE_INPUT_TOKENS, ESTIMATE_OUTPUT_TOKENS]).toEqual([100, 1500, 400]);
    expect(estimateCost(byId(list, 'openai/gpt-4o-mini'))).toBeCloseTo(0.0465);
    expect(sp(estimateText(byId(list, 'openai/gpt-4o-mini')))).toBe('≈ 0,05 $ pour 100 recommandations.');
    expect(estimateText(byId(list, 'meta-llama/llama-3.3-70b-instruct:free'))).toContain('débit limité');
    expect(estimateText(byId(list, 'openrouter/auto'))).toMatch(/^Coût inconnu/);
    expect(estimateText(undefined)).toMatch(/^Coût inconnu/);
    expect(estimateText({ id: 'a/b', name: 'b', provider: 'A', ctx: 0, inPrice: 0.01, outPrice: 0.01 })).toContain('moins de 0,01');
  });
});

describe('recherche et tri', () => {
  const list = parseModels(RAW);

  it('sans accents ni casse, sur le nom, le fournisseur et l’identifiant', () => {
    expect(normalize('Éclair')).toBe('eclair');
    expect(filterModels(list, 'ECLAIR').map((m) => m.id)).toEqual(['zeta/éclair']);
    expect(filterModels(list, 'anthropic').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4']);
    expect(filterModels(list, 'gpt-4o').map((m) => m.id)).toEqual(['openai/gpt-4o-mini']);
    expect(filterModels(list, 'mistral 2407').map((m) => m.id)).toEqual(['mistralai/mistral-large-2407']);
    expect(filterModels(list, '  ')).toHaveLength(list.length);
    expect(filterModels(list, 'introuvable')).toEqual([]);
  });

  it('groupes alphabétiques par fournisseur, tri dans chaque groupe', () => {
    const groups = groupModels(list, 'name');
    expect(groups.map((g) => g.provider)).toEqual(['Anthropic', 'Google', 'Meta', 'Mistral', 'OpenAI', 'Openrouter', 'Zeta']);
    const mistral = (sort: 'price' | 'ctx' | 'name') => groupModels(list, sort).find((g) => g.provider === 'Mistral')!.models.map((m) => m.id);
    expect(mistral('name')).toEqual(['mistralai/mistral-large', 'mistralai/mistral-large-2407']);
    expect(mistral('price')).toEqual(['mistralai/mistral-large', 'mistralai/mistral-large-2407']); // prix inconnu en dernier
    const two = [
      { id: 'p/a', name: 'A', provider: 'P', ctx: 1000, inPrice: 5, outPrice: 5 },
      { id: 'p/b', name: 'B', provider: 'P', ctx: 9000, inPrice: 0.1, outPrice: 0.1 },
    ];
    expect(groupModels(two, 'price')[0].models.map((m) => m.id)).toEqual(['p/b', 'p/a']);
    expect(groupModels(two, 'ctx')[0].models.map((m) => m.id)).toEqual(['p/b', 'p/a']);
    expect(groupModels(two, 'name')[0].models.map((m) => m.id)).toEqual(['p/a', 'p/b']);
  });
});

describe('loadModels : cache 24 h et repli', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('requête publique sans clé ni cookie, puis cache daté', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(RAW)));
    vi.stubGlobal('fetch', f);
    const now = 1_700_000_000_000;
    const list = await loadModels({ now });
    expect(list.length).toBe(8);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(MODELS_URL);
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).at).toBe(now);
    // Encore frais : pas de nouvelle requête.
    await loadModels({ now: now + CACHE_TTL_MS - 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(cachedModels(now + CACHE_TTL_MS - 1)).toHaveLength(8);
    // Périmé : nouvelle requête.
    expect(cachedModels(now + CACHE_TTL_MS)).toBeNull();
    await loadModels({ now: now + CACHE_TTL_MS });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('échec réseau : dernière liste connue, sinon erreur', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(loadModels()).rejects.toThrow();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: 1, models: parseModels(RAW) }));
    expect(await loadModels({ now: 10 * CACHE_TTL_MS })).toHaveLength(8);
  });

  it('cache : horloge reculée rejetée, entrées invalides écartées', () => {
    const models = parseModels(RAW);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: 5000, models: [...models, { id: 3 }, null, { id: 'x/y' }] }));
    expect(cachedModels(4000)).toBeNull();
    expect(cachedModels(6000)).toHaveLength(models.length);
  });

  it('réponse HTTP en erreur ou vide : erreur', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await expect(loadModels()).rejects.toThrow('HTTP 503');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}')));
    await expect(loadModels()).rejects.toThrow();
  });
});
