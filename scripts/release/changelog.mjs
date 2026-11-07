// Notes de release : section `## vX.Y.Z – AAAA-MM-JJ` (une puce par PR fusionnée) insérée en tête de CHANGELOG.md.
//   node scripts/release/changelog.mjs --version 1.0.33 --date 2026-11-07 --prs prs.json --out CHANGELOG.md [--section-out section.md]
// prs.json : [{"number": 12, "title": "...", "author": "login"}, ...]. Idempotent : une version déjà présente n'est pas réinsérée.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADER = '# Changelog\n\n';
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function normalizeVersion(version) {
  const v = String(version).replace(/^v/, '');
  if (!SEMVER_RE.test(v)) throw new Error(`Version invalide : ${version} (attendu X.Y.Z)`);
  return v;
}

function checkDate(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO));
  const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!d || d.toISOString().slice(0, 10) !== dateISO) throw new Error(`Date invalide : ${dateISO} (attendu AAAA-MM-JJ)`);
  return dateISO;
}

/** Section de changelog pour une version : titre `## vX.Y.Z – date`, puis une puce par PR (ou Maintenance). */
export function renderSection(version, dateISO, prs = []) {
  const v = normalizeVersion(version);
  const date = checkDate(dateISO);
  const lines = prs.length
    ? prs.map((pr) => {
        if (!Number.isInteger(pr.number) || typeof pr.title !== 'string' || !pr.title.trim() || !pr.author) {
          throw new Error(`PR invalide : ${JSON.stringify(pr)} (attendu {number, title, author})`);
        }
        return `- ${pr.title.trim()} (#${pr.number}) — @${String(pr.author).replace(/^@/, '')}`;
      })
    : ['- Maintenance'];
  return `## v${v} – ${date}\n\n${lines.join('\n')}\n`;
}

/** Vrai si le texte contient déjà le titre exact `## vX.Y.Z` (X.Y.Z entier, pas un préfixe). */
function hasVersion(text, version) {
  const heading = `## v${version}`;
  return text.split(/\r?\n/).some((line) => line === heading || line.startsWith(`${heading} `));
}

/**
 * Insère la section juste après l'en-tête de `file` (crée le fichier s'il manque). Retourne false sans rien écrire
 * si la version de la section est déjà présente.
 */
export function prependToChangelog(file, section) {
  const m = /^## v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?=\s)/m.exec(section);
  if (!m) throw new Error('La section doit commencer par un titre `## vX.Y.Z`');
  const version = m[1];
  const block = section.endsWith('\n') ? section : `${section}\n`;

  if (!existsSync(file)) {
    writeFileSync(file, HEADER + block, 'utf8');
    return true;
  }
  const existing = readFileSync(file, 'utf8');
  if (hasVersion(existing, version)) return false;

  const firstSection = existing.search(/^## /m);
  const head = firstSection < 0 ? existing : existing.slice(0, firstSection);
  const tail = firstSection < 0 ? '' : existing.slice(firstSection);
  const newHead = head.trim() ? `${head.replace(/\s*$/, '')}\n\n` : HEADER;
  writeFileSync(file, `${newHead}${block}${tail ? `\n${tail}` : ''}`, 'utf8');
  return true;
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  // Windows PowerShell 5.1 supprime un argument vide : `--prs --out f` ne doit pas lire `--out` comme fichier.
  return value?.startsWith('--') ? undefined : value;
}

function main(args) {
  const version = argValue(args, '--version');
  const date = argValue(args, '--date');
  const out = argValue(args, '--out');
  if (!version || !date || !out) {
    throw new Error('Usage : changelog.mjs --version X.Y.Z --date AAAA-MM-JJ --prs prs.json --out CHANGELOG.md [--section-out section.md]');
  }
  const prsFile = argValue(args, '--prs');
  const prs = prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
  if (!Array.isArray(prs)) throw new Error(`${prsFile} doit contenir un tableau de PR`);
  const section = renderSection(version, date, prs);
  const sectionOut = argValue(args, '--section-out');
  if (sectionOut) writeFileSync(sectionOut, section, 'utf8');
  return prependToChangelog(out, section)
    ? `Changelog : section ajoutée dans ${out}`
    : `Changelog : section déjà présente dans ${out}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
