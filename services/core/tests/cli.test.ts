import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli.js';

const CWD = resolve(tmpdir(), 'lastaddon-cwd');

describe('parseCliArgs', () => {
  it('sans option : aucune valeur', () => {
    expect(parseCliArgs([], CWD)).toEqual({});
  });

  it('forme « --option valeur » : port brut, dossiers résolus depuis le répertoire courant', () => {
    expect(parseCliArgs(['--port', ' 7001 ', '--ui', 'ui', '--data', 'donnees'], CWD)).toEqual({
      port: '7001',
      uiDir: resolve(CWD, 'ui'),
      dataDir: resolve(CWD, 'donnees'),
    });
  });

  it('forme « --option=valeur », chemin absolu conservé', () => {
    const absolute = resolve(tmpdir(), 'lastaddon-abs-ui');
    expect(parseCliArgs(['--port=8080', `--ui=${absolute}`], CWD)).toEqual({ port: '8080', uiDir: absolute });
  });

  it('option inconnue : erreur', () => {
    expect(() => parseCliArgs(['--foo', 'bar'], CWD)).toThrow(/option inconnue : --foo/);
    expect(() => parseCliArgs(['start'], CWD)).toThrow(/option inconnue : start/);
  });

  it('valeur absente ou vide : erreur', () => {
    expect(() => parseCliArgs(['--port'], CWD)).toThrow(/--port exige une valeur/);
    expect(() => parseCliArgs(['--ui', '--port', '7000'], CWD)).toThrow(/--ui exige une valeur/);
    expect(() => parseCliArgs(['--data='], CWD)).toThrow(/--data exige une valeur/);
  });

  it('un nom de propriété de l\'objet (ex. toString) n\'est pas une option', () => {
    expect(() => parseCliArgs(['toString'], CWD)).toThrow(/option inconnue/);
  });
});
