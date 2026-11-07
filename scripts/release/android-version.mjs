// Code de version Android (versionCode) : AAAAMMJJ * 100 + suffixe, avec suffixe = min(99, 50 + tags du jour).
// Croissant d'un jour à l'autre et d'une release à la suivante le même jour ; plafonné à 99.
//   node scripts/release/android-version.mjs --date 2026-11-07 --tags-today 0
import { fileURLToPath } from 'node:url';

/** Jour UTC sous forme [année, mois, jour] ; accepte une Date ou une chaîne AAAA-MM-JJ, lève une erreur sinon. */
function utcDateParts(dateUTC) {
  if (dateUTC instanceof Date) {
    if (Number.isNaN(dateUTC.getTime())) throw new Error('Date invalide (Date non valide)');
    return [dateUTC.getUTCFullYear(), dateUTC.getUTCMonth() + 1, dateUTC.getUTCDate()];
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateUTC));
  if (!m) throw new Error(`Date invalide : ${dateUTC} (attendu AAAA-MM-JJ)`);
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
    throw new Error(`Date invalide : ${dateUTC} (jour inexistant)`);
  }
  return [y, mo, da];
}

/** versionCode Android pour le jour UTC donné et le nombre de tags déjà posés ce jour-là. */
export function androidVersionCode(dateUTC, tagsToday) {
  const [y, mo, da] = utcDateParts(dateUTC);
  if (!Number.isInteger(tagsToday) || tagsToday < 0) {
    throw new Error(`tagsToday invalide : ${tagsToday} (entier >= 0 attendu)`);
  }
  const day = y * 10000 + mo * 100 + da;
  return day * 100 + Math.min(99, 50 + tagsToday);
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value?.startsWith('--') ? undefined : value;
}

function main(args) {
  const date = argValue(args, '--date');
  if (!date) throw new Error('Usage : android-version.mjs --date AAAA-MM-JJ [--tags-today N]');
  return androidVersionCode(date, Number(argValue(args, '--tags-today') ?? '0'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
