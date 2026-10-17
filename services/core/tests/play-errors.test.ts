import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  failureStatus,
  isPlayFailureReason,
  PLAY_FAILURES,
  renderFailure,
  type PlayFailureReason,
} from '../src/play/errors.js';

const REASONS: PlayFailureReason[] = [
  'not_cached',
  'dead_link',
  'host_unavailable',
  'age_limit',
  'subscription_expired',
  'invalid_key',
  'file_not_found',
  'not_released',
  'no_copy',
  'unsupported_format',
  'timeout',
  'quota',
  'unknown',
];

const JSON_ACCEPT = 'application/json';

describe('table des raisons d échec de /play', () => {
  it('contient exactement les 13 raisons, chacune avec titre, explication, conseil et statut HTTP', () => {
    expect(Object.keys(PLAY_FAILURES).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      const info = PLAY_FAILURES[reason];
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.explanation.length).toBeGreaterThan(0);
      expect(info.advice.length).toBeGreaterThan(0);
      expect(info.status).toBeGreaterThanOrEqual(400);
      expect(info.status).toBeLessThanOrEqual(599);
    }
  });

  it('associe les statuts attendus', () => {
    expect(failureStatus('not_cached')).toBe(404);
    expect(failureStatus('invalid_key')).toBe(401);
    expect(failureStatus('subscription_expired')).toBe(402);
    expect(failureStatus('quota')).toBe(429);
    expect(failureStatus('timeout')).toBe(504);
    expect(failureStatus('unknown')).toBe(500);
  });

  it('une valeur inconnue ou héritée de l objet renvoie le statut de unknown', () => {
    expect(failureStatus('nope')).toBe(500);
    expect(failureStatus('toString')).toBe(500);
    expect(failureStatus(undefined)).toBe(500);
    expect(failureStatus(42)).toBe(500);
  });

  it('isPlayFailureReason accepte les 13 raisons et refuse le reste', () => {
    for (const reason of REASONS) expect(isPlayFailureReason(reason)).toBe(true);
    expect(isPlayFailureReason('toString')).toBe(false);
    expect(isPlayFailureReason('__proto__')).toBe(false);
    expect(isPlayFailureReason('Not_Cached')).toBe(false);
    expect(isPlayFailureReason(null)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('échappe les cinq caractères dangereux', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('renderFailure : page HTML (par défaut)', () => {
  it('sans Accept, renvoie une page HTML française avec le bon statut', () => {
    const rendered = renderFailure('not_cached');
    expect(rendered.status).toBe(404);
    expect(rendered.contentType).toBe('text/html; charset=utf-8');
    expect(rendered.body.startsWith('<!doctype html>')).toBe(true);
    expect(rendered.body).toContain('<html lang="fr">');
    expect(rendered.body).toContain('<meta charset="utf-8">');
    expect(rendered.body).toContain(PLAY_FAILURES.not_cached.title);
    expect(rendered.body).toContain(PLAY_FAILURES.not_cached.explanation);
    expect(rendered.body).toContain(PLAY_FAILURES.not_cached.advice);
  });

  it('la page ne contient ni script, ni style, ni gestionnaire d événement (CSP-friendly)', () => {
    for (const reason of REASONS) {
      const { body } = renderFailure(reason);
      expect(body).not.toMatch(/<script/i);
      expect(body).not.toMatch(/<style/i);
      expect(body).not.toMatch(/\son[a-z]+\s*=/i);
      expect(body).not.toMatch(/javascript:/i);
    }
  });

  it('Accept text/html, ou wildcard seul, donne la page HTML', () => {
    for (const accept of [
      'text/html',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '*/*',
    ]) {
      expect(renderFailure('quota', { accept }).contentType).toBe('text/html; charset=utf-8');
    }
  });
});

describe('renderFailure : JSON', () => {
  it('Accept application/json renvoie {error, reason, message} et le statut de la raison', () => {
    const rendered = renderFailure('invalid_key', { accept: JSON_ACCEPT });
    expect(rendered.status).toBe(401);
    expect(rendered.contentType).toBe('application/json; charset=utf-8');
    const json = JSON.parse(rendered.body) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['error', 'message', 'reason']);
    expect(json.error).toBe('play_failed');
    expect(json.reason).toBe('invalid_key');
    expect(json.message).toContain(PLAY_FAILURES.invalid_key.title);
    expect(json.message).toContain(PLAY_FAILURES.invalid_key.advice);
  });

  it('un client qui accepte JSON en premier, avec wildcard ensuite, reçoit du JSON', () => {
    const rendered = renderFailure('timeout', { accept: 'application/json, text/plain, */*' });
    expect(rendered.contentType).toBe('application/json; charset=utf-8');
  });

  it('JSON seulement avec une meilleure qualité que HTML ; q=0 n est pas accepté', () => {
    expect(renderFailure('quota', { accept: 'text/html,application/json;q=0.9' }).contentType).toBe(
      'text/html; charset=utf-8',
    );
    expect(renderFailure('quota', { accept: 'application/json;q=0.9,text/html;q=0.5' }).contentType).toBe(
      'application/json; charset=utf-8',
    );
    expect(renderFailure('quota', { accept: 'application/json;q=0' }).contentType).toBe('text/html; charset=utf-8');
  });

  it('à égalité explicite (text/html et application/json), la page HTML gagne', () => {
    expect(renderFailure('quota', { accept: 'text/html, application/json' }).contentType).toBe(
      'text/html; charset=utf-8',
    );
  });
});

describe('renderFailure : entrées non fiables', () => {
  it('une raison inconnue devient unknown, sans écho de la valeur reçue', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = renderFailure(hostile);
    expect(html.status).toBe(500);
    expect(html.body).not.toContain('onerror');
    expect(html.body).not.toContain('<img');
    expect(html.body).toContain('code unknown');

    const json = renderFailure(hostile, { accept: JSON_ACCEPT });
    expect(JSON.parse(json.body)).toMatchObject({ reason: 'unknown', error: 'play_failed' });
    expect(json.body).not.toContain('onerror');
  });

  it('une raison héritée de l objet (toString, __proto__) est traitée comme inconnue', () => {
    expect(renderFailure('toString').status).toBe(500);
    expect(renderFailure('__proto__', { accept: JSON_ACCEPT }).body).toContain('"reason":"unknown"');
    expect(renderFailure(undefined).status).toBe(500);
  });

  it('la page n introduit aucune balise hors de sa structure fixe', () => {
    const allowed = new Set(['html', 'head', 'meta', 'title', 'body', 'main', 'h1', 'h2', 'p', 'small']);
    for (const reason of REASONS) {
      const tags = [...renderFailure(reason).body.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => m[1]?.toLowerCase());
      for (const tag of tags) expect(allowed.has(tag ?? '')).toBe(true);
    }
  });
});
