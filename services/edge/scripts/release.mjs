// Création d'une release : tag annoté edge-vX.Y.Z sur main à jour et propre, poussé, puis release GitHub (LAST-150).
// Notes : commits de services/edge depuis le tag edge-v précédent.
// Usage : npm run release -- <x.y.z> [--dry-run]
// --dry-run : vérifie et affiche les notes, ne crée ni tag ni release. Le déploiement part ensuite de ce tag.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRelease, realGit } from './lib/deploy-guard.mjs';

const BRANCH = 'main';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const versionArg = args.find((arg) => !arg.startsWith('--'));

const plan = planRelease(realGit, root, { branch: BRANCH, versionArg, tagPrefix: 'edge-', paths: ['services/edge'] });
if (plan.problems.length > 0) {
  console.error('Release REFUSÉE :');
  for (const problem of plan.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Release ${plan.tag} sur ${BRANCH} (${plan.sha.slice(0, 7)}), précédente : ${plan.previous ?? 'aucune'}.\n\n${plan.notes}`);
if (dryRun) {
  console.log('--dry-run : aucun tag ni release créés.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'release-'));
try {
  const notesFile = join(dir, 'notes.md');
  writeFileSync(notesFile, plan.notes);
  const steps = [
    ['git', ['tag', '-a', plan.tag, '-F', notesFile]],
    ['git', ['push', 'origin', plan.tag]],
    ['gh', ['release', 'create', plan.tag, '--title', plan.tag, '--notes-file', notesFile, '--verify-tag']],
  ];
  for (const [command, commandArgs] of steps) {
    const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      // Un tag local sans push ne doit pas rester : le prochain essai repartirait d'un état propre.
      if (command === 'git' && commandArgs[0] === 'push') spawnSync('git', ['tag', '-d', plan.tag], { cwd: root, stdio: 'inherit' });
      console.error(`Échec de « ${command} ${commandArgs.slice(0, 2).join(' ')} » : release interrompue.`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(`Release ${plan.tag} publiée. Le déploiement part de ce tag (voir README, « Déploiement »).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
