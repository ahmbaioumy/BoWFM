/**
 * Fail if BoWFM.html is missing or older than shippable sources.
 * Exit 0 when fresh; exit 1 when stale/missing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const artifactPath = path.join(root, 'BoWFM.html');

const watchedFiles = [
  'scripts/build-standalone.mts',
  'vite.standalone.config.ts',
  'vite.config.ts',
  'index.html',
  'package.json',
];

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function collectWatched(): string[] {
  const files = walkFiles(path.join(root, 'src'));
  for (const rel of watchedFiles) {
    const full = path.join(root, rel);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

if (!existsSync(artifactPath)) {
  console.error('BoWFM.html is missing. Run: npm run build:standalone');
  process.exit(1);
}

const artifactMtime = statSync(artifactPath).mtimeMs;
let newestPath = '';
let newestMtime = 0;

for (const file of collectWatched()) {
  const mtime = statSync(file).mtimeMs;
  if (mtime > newestMtime) {
    newestMtime = mtime;
    newestPath = file;
  }
}

if (newestMtime > artifactMtime) {
  const rel = path.relative(root, newestPath);
  console.error(
    `BoWFM.html is stale.\n` +
      `  artifact: ${new Date(artifactMtime).toISOString()}\n` +
      `  newer:    ${rel} @ ${new Date(newestMtime).toISOString()}\n` +
      `Run: npm run build:standalone`
  );
  process.exit(1);
}

console.log(
  `BoWFM.html is fresh (${(statSync(artifactPath).size / 1024).toFixed(1)} KB; ` +
    `mtime ${new Date(artifactMtime).toISOString()})`
);
process.exit(0);
