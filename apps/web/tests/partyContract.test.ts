import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/party/protocol';

/**
 * Contrat partagé avec lastaddon (tests/fixtures/party-contract.json, copie identique) : chaque constante listée doit être
 * exportée par protocol.ts à l'identique. Ajouter une constante commune = l'ajouter aux deux JSON.
 */
const contract: Record<string, unknown> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'party-contract.json'), 'utf8'));
const exported: Record<string, unknown> = { ...protocol };

describe('contrat du salon (protocol.ts ↔ fixtures/party-contract.json)', () => {
  for (const [name, expected] of Object.entries(contract)) {
    if (name === '_comment') continue;
    it(`${name} correspond au contrat partagé`, () => {
      expect(exported[name]).toEqual(expected);
    });
  }
});
