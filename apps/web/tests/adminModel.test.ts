// Helpers purs de la console d'administration : export CSV (échappement, injection de formules), compte à rebours, libellés d'état.
import { describe, expect, it } from 'vitest';
import type { AdminAccount } from '../src/data/adminApi';
import { csvCell, csvOfAccounts, formatCountdown, neutralizeFormula, serviceStatusLabel } from '../src/data/adminModel';

const HEADER = 'Identifiant,Pseudo,Statut,Créé le,Dernière activité,Suspendu le,Parrain,Profils,Bibliothèque,Quota d’invitations,Invitations utilisées,Sessions,En ligne';
const acct = (over: Partial<AdminAccount> = {}): AdminAccount => ({
  id: 'a1', username: 'alice', isOwner: false, createdAt: '2026-01-01T00:00:00Z', status: 'active', suspendedAt: null,
  referrer: 'greg', lastActivityAt: '2026-02-01T00:00:00Z', profileCount: 2, libraryCount: 5, inviteQuota: 4, invitesUsed: 1,
  online: true, sessionCount: 3, ...over,
});

describe('export CSV des comptes', () => {
  it('en-tête puis une ligne par compte, fins de ligne CRLF', () => {
    expect(csvOfAccounts([acct()])).toBe(HEADER + '\r\n' +
      'a1,alice,active,2026-01-01T00:00:00Z,2026-02-01T00:00:00Z,,greg,2,5,4,1,3,oui\r\n');
  });
  it('liste vide : en-tête seul', () => {
    expect(csvOfAccounts([])).toBe(HEADER + '\r\n');
  });
  it('guillemets doublés, cellule entre guillemets si virgule ou saut de ligne', () => {
    const out = csvOfAccounts([acct({ username: 'a"b', referrer: 'x,y\nz' })]);
    expect(out).toContain(',"a""b",');
    expect(out).toContain(',"x,y\nz",');
  });
  it('champs absents : cellules vides ; hors ligne : « non »', () => {
    expect(csvOfAccounts([acct({ referrer: null, online: false })]).split('\r\n')[1]).toBe(
      'a1,alice,active,2026-01-01T00:00:00Z,2026-02-01T00:00:00Z,,,2,5,4,1,3,non');
  });
  it('protège contre l’injection de formules (=, +, -, @, tabulation, retour chariot)', () => {
    expect(neutralizeFormula('=1+1')).toBe('\'=1+1');
    expect(neutralizeFormula('+cmd')).toBe('\'+cmd');
    expect(neutralizeFormula('-2')).toBe('\'-2');
    expect(neutralizeFormula('@SUM(A1)')).toBe('\'@SUM(A1)');
    expect(neutralizeFormula('\tcmd')).toBe('\'\tcmd');
    expect(neutralizeFormula('\rcmd')).toBe('\'\rcmd');
    expect(neutralizeFormula('alice')).toBe('alice');
    expect(neutralizeFormula('')).toBe('');
  });
  it('formule avec guillemets : apostrophe puis échappement CSV', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvOfAccounts([acct({ username: '=1+1' })]).split('\r\n')[1]).toBe(
      'a1,\'=1+1,active,2026-01-01T00:00:00Z,2026-02-01T00:00:00Z,,greg,2,5,4,1,3,oui');
  });
  it('valeurs nulles : vide ; nombres sans transformation', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(12)).toBe('12');
  });
});

describe('compte à rebours mm:ss', () => {
  it('tronque à la seconde', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(599_999)).toBe('09:59');
    expect(formatCountdown(1_500)).toBe('00:01');
    expect(formatCountdown(59_000)).toBe('00:59');
  });
  it('les minutes dépassent 59 si besoin', () => {
    expect(formatCountdown(3_725_000)).toBe('62:05');
  });
  it('zéro, négatif ou non fini : 00:00', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00');
  });
});

describe('libellés d’état des services', () => {
  it('états connus en français', () => {
    expect(serviceStatusLabel('ok')).toBe('Opérationnel');
    expect(serviceStatusLabel('degraded')).toBe('Dégradé');
    expect(serviceStatusLabel('down')).toBe('En panne');
    expect(serviceStatusLabel('unknown')).toBe('Inconnu');
  });
  it('valeur inconnue, absente ou propriété héritée : Inconnu', () => {
    expect(serviceStatusLabel('autre')).toBe('Inconnu');
    expect(serviceStatusLabel('constructor')).toBe('Inconnu');
    expect(serviceStatusLabel(null)).toBe('Inconnu');
    expect(serviceStatusLabel(undefined)).toBe('Inconnu');
  });
});
