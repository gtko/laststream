import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { androidVersionCode } from './android-version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('androidVersionCode : premier tag du jour = AAAAMMJJ50', () => {
  assert.equal(androidVersionCode('2026-11-07', 0), 2026110750);
  assert.equal(androidVersionCode(new Date(Date.UTC(2026, 10, 7)), 0), 2026110750);
});

test('androidVersionCode croît avec le jour et avec le nombre de tags du jour', () => {
  assert.ok(androidVersionCode('2026-11-07', 0) > 2026110201);
  assert.equal(androidVersionCode('2026-11-07', 1), 2026110751);
  assert.ok(androidVersionCode('2026-11-08', 0) > androidVersionCode('2026-11-07', 49));
});

test('androidVersionCode plafonne le suffixe à 99', () => {
  assert.equal(androidVersionCode('2026-11-07', 49), 2026110799);
  assert.equal(androidVersionCode('2026-11-07', 50), 2026110799);
  assert.equal(androidVersionCode('2026-11-07', 1000), 2026110799);
});

test('androidVersionCode lit la date en UTC', () => {
  assert.equal(androidVersionCode(new Date('2026-11-07T23:30:00Z'), 0), 2026110750);
});

test('androidVersionCode refuse une date ou un compteur invalides', () => {
  assert.throws(() => androidVersionCode('2026-02-30', 0));
  assert.throws(() => androidVersionCode('07/11/2026', 0));
  assert.throws(() => androidVersionCode('2026-11-07', -1));
  assert.throws(() => androidVersionCode('2026-11-07', 1.5));
});

test('CLI : affiche le code pour la date et le compteur donnés', () => {
  const out = execFileSync(
    process.execPath,
    [join(HERE, 'android-version.mjs'), '--date', '2026-11-07', '--tags-today', '0'],
    { encoding: 'utf8' },
  );
  assert.equal(out, '2026110750\n');
});
