import { describe, expect, it } from 'vitest';
import { configJsonSchema } from '../src/config/schema.js';
import { filterCandidates } from '../src/engine/filter.js';
import { runEngine } from '../src/engine/index.js';
import type { Candidate } from '../src/engine/types.js';
import type { ParsedRelease } from '../src/types.js';
import { cand, cfg, titles } from './engine-fixtures.js';

const HASH = 'a'.repeat(40);

/** Candidat français (VFF) avec infoHash : livrable en P2P. */
function fr(title: string, parsed: Partial<ParsedRelease> = {}): Candidate {
  return cand({ parsed: { languages: ['fr'], frVariant: 'VFF', ...parsed }, raw: { title, infoHash: HASH } });
}

/** Candidat anglais (VO, sans sous-titres FR) avec infoHash. */
function en(title: string, parsed: Partial<ParsedRelease> = {}): Candidate {
  return cand({
    parsed: { languages: ['en'], frVariant: undefined, subsFr: false, multi: false, ...parsed },
    raw: { title, infoHash: HASH },
  });
}

const FMT = { playBaseUrl: 'https://addon.example.test', configToken: 'tok', secret: 'fallback-test-secret', hasDebrid: false };

describe('languages.fallbackToOthers : repli sur les autres langues', () => {
  it('(a) seulement des résultats anglais, repli activé : streams anglais renvoyés et marqués', () => {
    const config = cfg({ languages: { preferred: ['fr', 'multi'] } });
    const result = filterCandidates([en('en.one'), en('en.two')], config);
    expect(titles(result)).toEqual(['en.one', 'en.two']);
    expect(result.every((c) => c.languageFallback === true)).toBe(true);

    const streams = runEngine([en('en.one')], config, FMT);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.laststream).toMatchObject({ languageFallback: true, languages: ['en'] });
    // Gabarit détaillé : la marque « Autre langue » ouvre la première ligne ; la langue annoncée reste suffixée de « ? ».
    expect(streams[0]?.name).toBe('lastAddon 1080p');
    expect(streams[0]?.description?.split('\n')[0]).toBe('Autre langue • WEB-DL • 🇬🇧?');
  });

  it('(b) repli désactivé : liste vide', () => {
    const config = cfg({ languages: { preferred: ['fr', 'multi'], fallbackToOthers: false } });
    expect(filterCandidates([en('en.one'), en('en.two')], config)).toEqual([]);
    expect(runEngine([en('en.one')], config, FMT)).toEqual([]);
  });

  it('(c) mélange fr et en : seul le fr est retenu, sans marque ni préfixe', () => {
    const config = cfg({ languages: { preferred: ['fr', 'multi'] } });
    const result = filterCandidates([en('en.one'), fr('fr.one')], config);
    expect(titles(result)).toEqual(['fr.one']);

    const [stream] = runEngine([en('en.one'), fr('fr.one')], config, FMT);
    expect(stream?.description?.startsWith('Autre langue')).toBe(false);
    expect(stream?.laststream).not.toHaveProperty('languageFallback');
  });

  it('le repli respecte les filtres de qualité, de taille et de tags exclus', () => {
    const config = cfg({ languages: { preferred: ['fr'] }, resolutions: { allowed: ['720p'] } });
    const result = filterCandidates(
      [
        en('en.1080p', { resolution: '1080p' }),
        en('en.720p', { resolution: '720p' }),
        en('en.cam', { resolution: '720p', source: 'CAM' }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['en.720p']);
  });

  it('le repli respecte onlyCached : un anglais non caché est écarté', () => {
    const config = cfg({ languages: { preferred: ['fr'] }, onlyCached: true });
    const notCached = en('en.nc');
    const cached = { ...en('en.c'), cached: true };
    expect(titles(filterCandidates([notCached, cached], config))).toEqual(['en.c']);
  });

  it('pas de repli quand preferred est vide : tout passe déjà, aucune marque', () => {
    const config = cfg({ languages: { preferred: [] } });
    const result = filterCandidates([en('en.one')], config);
    expect(titles(result)).toEqual(['en.one']);
    expect(result[0]?.languageFallback).toBeUndefined();
  });

  it('la valeur par défaut est vraie et le libellé français figure dans le schéma', () => {
    expect(cfg({}).languages.fallbackToOthers).toBe(true);
    expect(JSON.stringify(configJsonSchema())).toContain("Afficher les autres langues s'il n'y a rien dans ma langue");
  });
});
