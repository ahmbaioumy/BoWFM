/**
 * Claude Code Stop hook: after any agent turn that changed files, auto-commit
 * and push those changes to the `auto/agent-updates` branch on GitHub.
 *
 * Uses a hidden git worktree (.git/auto-push-worktree/) checked out to
 * auto/agent-updates so the user's real working directory/branch is never
 * touched. Never force-pushes; sync failures are logged and non-blocking.
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const worktreeDir = path.join(root, '.git', 'auto-push-worktree');
const branch = 'auto/agent-updates';

const SECRET_PATTERNS = [/AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{20,}\b/];

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(args, cwd = root) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (err) {
    return { ok: false, out: '', err: String(err.stderr || err.message || err) };
  }
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

function warn(msg) {
  process.stderr.write(`[auto-push] ${msg}\n`);
}

function listGitFiles() {
  // Tracked files + untracked-but-not-ignored files, exactly what `git add -A` would stage.
  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const others = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  return Array.from(new Set([...tracked, ...others]));
}

function syncIntoWorktree(files) {
  // Mirror current file state into the worktree, then remove worktree files
  // that no longer exist in the main tree (handles deletions).
  const wtFiles = new Set(
    tryGit(['ls-files']).ok
      ? git(['ls-files'], worktreeDir).split('\n').filter(Boolean)
      : []
  );
  for (const rel of files) {
    const src = path.join(root, rel);
    const dest = path.join(worktreeDir, rel);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    wtFiles.delete(rel);
  }
  const currentSet = new Set(files);
  for (const rel of wtFiles) {
    if (!currentSet.has(rel)) {
      const dest = path.join(worktreeDir, rel);
      if (existsSync(dest)) rmSync(dest, { force: true });
    }
  }
}

function containsSecret(diffText) {
  return SECRET_PATTERNS.some((re) => re.test(diffText));
}

async function main() {
  const input = await readStdin();
  if (input.stop_hook_active) {
    process.stdout.write('{}\n');
    return;
  }

  const status = tryGit(['status', '--porcelain']);
  if (!status.ok) {
    warn(`git status failed, skipping: ${status.err}`);
    process.stdout.write('{}\n');
    return;
  }
  if (!status.out.trim()) {
    process.stdout.write('{}\n');
    return;
  }

  // Set up (or reuse) the hidden worktree on the auto-sync branch.
  if (!existsSync(worktreeDir)) {
    const branchExists = tryGit(['rev-parse', '--verify', branch]).ok;
    const remoteExists = tryGit(['ls-remote', '--exit-code', '--heads', 'origin', branch]).ok;
    let addResult;
    if (branchExists) {
      addResult = tryGit(['worktree', 'add', worktreeDir, branch]);
    } else if (remoteExists) {
      addResult = tryGit(['worktree', 'add', '--track', '-b', branch, worktreeDir, `origin/${branch}`]);
    } else {
      addResult = tryGit(['worktree', 'add', '-b', branch, worktreeDir, 'HEAD']);
    }
    if (!addResult.ok) {
      warn(`failed to set up worktree, skipping push: ${addResult.err}`);
      process.stdout.write('{}\n');
      return;
    }
  } else {
    const fetch = tryGit(['fetch', 'origin', branch], worktreeDir);
    if (fetch.ok) {
      const reset = tryGit(['reset', '--hard', `origin/${branch}`], worktreeDir);
      if (!reset.ok) warn(`could not fast-forward worktree to origin/${branch}: ${reset.err}`);
    }
  }

  const files = listGitFiles();
  syncIntoWorktree(files);

  tryGit(['add', '-A'], worktreeDir);
  const diff = tryGit(['diff', '--cached'], worktreeDir);
  if (diff.ok && diff.out.trim() === '') {
    // Worktree already matches — nothing new to push.
    process.stdout.write('{}\n');
    return;
  }
  if (diff.ok && containsSecret(diff.out)) {
    warn('staged diff matches a secret-like pattern; leaving changes staged in worktree without pushing.');
    process.stdout.write('{}\n');
    return;
  }

  const timestamp = new Date().toISOString();
  const commit = tryGit(['commit', '-m', `chore: auto-sync ${timestamp}`], worktreeDir);
  if (!commit.ok) {
    warn(`commit failed: ${commit.err}`);
    process.stdout.write('{}\n');
    return;
  }

  let push = tryGit(['push', 'origin', `HEAD:${branch}`], worktreeDir);
  if (!push.ok) {
    warn(`push rejected, attempting rebase: ${push.err}`);
    const rebase = tryGit(['pull', '--rebase', 'origin', branch], worktreeDir);
    if (!rebase.ok) {
      tryGit(['rebase', '--abort'], worktreeDir);
      warn(`rebase failed, giving up for this turn (no force-push): ${rebase.err}`);
      process.stdout.write('{}\n');
      return;
    }
    push = tryGit(['push', 'origin', `HEAD:${branch}`], worktreeDir);
    if (!push.ok) {
      warn(`push still failed after rebase: ${push.err}`);
      process.stdout.write('{}\n');
      return;
    }
  }

  process.stdout.write('{}\n');
}

await main();
