/**
 * Cursor stop hook: if BoWFM.html is older than shippable sources, force a DoD follow-up.
 * Plain Node only — no tsx (avoids platform esbuild binary issues).
 *
 * Dual-root: works when Cursor opens either:
 * - nested repo (…/Bo_4Final-main/) where package.json + src/ live here, or
 * - parent workspace (…/Bo_4Final-main (2)/) with the app under Bo_4Final-main/.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cursorDir = path.resolve(__dirname, '..');
const openRoot = path.resolve(cursorDir, '..');

function looksLikeAppRoot(dir) {
  return (
    existsSync(path.join(dir, 'package.json')) &&
    existsSync(path.join(dir, 'src')) &&
    existsSync(path.join(dir, 'scripts', 'build-standalone.mts'))
  );
}

function resolveAppRoot() {
  if (looksLikeAppRoot(openRoot)) return openRoot;
  const nested = path.join(openRoot, 'Bo_4Final-main');
  if (looksLikeAppRoot(nested)) return nested;
  return openRoot;
}

const root = resolveAppRoot();
const artifactPath = path.join(root, 'BoWFM.html');
const npmCwdHint =
  root === openRoot
    ? ''
    : ` Run npm from \`${path.basename(root)}/\` (app root), not the parent workspace.`;

const watchedFiles = [
  'scripts/build-standalone.mts',
  'vite.standalone.config.ts',
  'vite.config.ts',
  'index.html',
  'package.json',
];

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function collectWatched() {
  const files = walkFiles(path.join(root, 'src'));
  for (const rel of watchedFiles) {
    const full = path.join(root, rel);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

function freshness() {
  if (!existsSync(artifactPath)) {
    return { fresh: false, reason: 'BoWFM.html is missing' };
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
    return {
      fresh: false,
      reason: `${path.relative(root, newestPath)} is newer than BoWFM.html`,
    };
  }
  return { fresh: true, reason: '' };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const input = await readStdin();
const status = input.status ?? '';
const loopCount = Number(input.loop_count ?? 0);

if (status === 'aborted' || loopCount >= 2) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const result = freshness();
if (result.fresh) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const followup = [
  'Definition of Done incomplete: BoWFM.html is stale or missing',
  `(${result.reason}).`,
  'Run `npm run lint`, `npm test`, and `npm run build:standalone`.',
  'Then sync PRD.md and project_context.md per .cursor/rules/50-docs-and-artifact-sync.mdc.',
  'Finish with `npm run check:artifact` and state what was updated (or why rebuild was skipped).',
  npmCwdHint,
]
  .filter(Boolean)
  .join(' ');

process.stdout.write(JSON.stringify({ followup_message: followup }) + '\n');
process.exit(0);
