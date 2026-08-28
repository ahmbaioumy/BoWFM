/**
 * Claude Code Stop hook: if BoWFM.html is older than shippable sources, block
 * completion and ask for the Definition-of-Done rebuild (CLAUDE.md).
 * Plain Node only — no tsx (avoids platform esbuild binary issues).
 *
 * Ported from .cursor/hooks/ensure-artifact-fresh.mjs. Simplified vs. the Cursor
 * version: this file lives at <root>/.claude/hooks/, so the app root is always
 * two levels up — no dual-root guessing needed.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const artifactPath = path.join(root, 'BoWFM.html');

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

// stop_hook_active is true when this Stop already forced one continuation —
// don't block a second time in the same turn, to avoid an infinite loop.
if (input.stop_hook_active) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const result = freshness();
if (result.fresh) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const reason = [
  'Definition of Done incomplete: BoWFM.html is stale or missing',
  `(${result.reason}).`,
  'Run `npm run lint`, `npm test`, and `npm run build:standalone`.',
  'Then sync PRD.md and project_context.md per the Definition of Done section in CLAUDE.md.',
  'Finish with `npm run check:artifact` and state what was updated (or why the rebuild was skipped).',
].join(' ');

process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
process.exit(0);