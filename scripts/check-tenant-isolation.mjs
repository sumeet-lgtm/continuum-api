#!/usr/bin/env node
// Static guard against the 2026-09-14 isolation incident class of bug: a
// Prisma query on a tenant-owned model that returns MANY rows (findMany,
// count) or a single row picked from a set (findFirst) without any
// apiKeyId scoping anywhere in the call — directly, or via a relation to
// another apiKeyId-bearing model (e.g. `contact: { apiKeyId }`).
//
// Deliberately a substring/brace-matching heuristic, not a real
// TypeScript/Prisma-aware analyzer: it looks for the literal text
// "apiKeyId" anywhere inside the call's argument object. That is enough
// to catch what actually happened three separate times this session —
// none of the buggy queries referenced apiKeyId anywhere at all — while
// staying simple enough to run with zero dependencies in CI.
//
// A legitimate "scan every tenant's due work, each row carries its own
// apiKeyId used downstream" query (sequenceWorker's dueEnrollments,
// scheduledChecks' A/B test sweep, bulkWorker's stalled-job sweep) is
// exempted by a `// tenant-sweep: <reason>` comment on the line directly
// above the prisma call — an explicit, reviewable opt-out rather than a
// silent one.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(__dirname, '..', 'src');

// Models that carry a direct apiKeyId field (from prisma/schema.prisma) —
// any findMany/findFirst/count against one of these, or against a model
// that relates to one of these, is in scope for this check.
const TENANT_MODELS = new Set([
  'auditLog', 'apiRequestLog', 'bulkJob', 'monitor', 'webhook', 'sendMessage',
  'suppression', 'softBounceTrack', 'sendingDomain', 'emailTemplate',
  'mailingList', 'contact', 'segment', 'campaign', 'mailbox', 'sequence',
  'lead', 'account', 'inboxTest', 'automation', 'salesforceConnection',
  'salesforceLeadSync',
  // Models with no direct apiKeyId but that hold per-tenant data via a
  // relation — the exact shape of every bug found this session.
  'contactListMembership', 'sequenceEnrollment', 'replyEvent',
  'campaignRecipient', 'automationEnrollment',
]);

const CHECKED_METHODS = ['findMany', 'findFirst', 'count'];
const EXEMPT_COMMENT = /tenant-sweep:/;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listFiles(full));
    } else if (extname(entry) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

// Given source text and the index right after "prisma.<model>.<method>(",
// return the substring up to the matching close-paren.
function extractCall(text, startIdx) {
  let depth = 1;
  let i = startIdx;
  while (i < text.length && depth > 0) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    i++;
  }
  return text.slice(startIdx, i - 1);
}

function lineNumberAt(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

function checkFile(path) {
  const text = readFileSync(path, 'utf8');
  const violations = [];
  const callRe = /prisma\.(\w+)\.(findMany|findFirst|count)\(/g;
  let match;
  while ((match = callRe.exec(text))) {
    const [full, model, method] = match;
    if (!TENANT_MODELS.has(model) || !CHECKED_METHODS.includes(method)) continue;

    const callStart = match.index + full.length;
    const callBody = extractCall(text, callStart);
    if (callBody.includes('apiKeyId')) continue;

    // Check for an explicit exemption comment on the line(s) immediately above.
    const beforeCall = text.slice(0, match.index);
    const linesBefore = beforeCall.split('\n');
    const precedingLines = linesBefore.slice(-3).join('\n');
    if (EXEMPT_COMMENT.test(precedingLines)) continue;

    violations.push({
      line: lineNumberAt(text, match.index),
      model,
      method,
    });
  }
  return violations;
}

// Parses `git diff --unified=0 <base>...HEAD -- src` and returns, per file
// (relative to repo root), the set of NEW line numbers the diff touched.
// This is what lets the check act as a ratchet: it holds new/changed code
// to the rule without requiring the entire pre-existing codebase (99
// candidates as of 2026-09-14, most unverified but likely mostly benign)
// to be triaged and fixed or annotated in one sitting before this can ship.
function getChangedLines(baseRef) {
  let diff;
  try {
    diff = execSync(`git diff --unified=0 ${baseRef}...HEAD -- src`, {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`Could not compute git diff against ${baseRef}: ${err.message}`);
    process.exit(2);
  }

  const changed = new Map(); // relative path -> Set<line>
  let currentFile = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      if (!changed.has(currentFile)) changed.set(currentFile, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && currentFile) {
      const start = parseInt(hunk[1], 10);
      const count = hunk[2] !== undefined ? parseInt(hunk[2], 10) : 1;
      for (let i = 0; i < count; i++) changed.get(currentFile).add(start + i);
    }
  }
  return changed;
}

function main() {
  const diffMode = process.argv.includes('--diff');
  const baseRefArg = process.argv.find((a) => a.startsWith('--base='));
  const baseRef = baseRefArg ? baseRefArg.slice('--base='.length) : 'origin/main';

  const changedLines = diffMode ? getChangedLines(baseRef) : null;
  const files = listFiles(SRC);
  let totalViolations = 0;
  let filesScanned = 0;

  for (const file of files) {
    const repoRoot = join(__dirname, '..');
    const relPath = relative(repoRoot, file).split('\\').join('/'); // git diff paths are always forward-slash

    if (diffMode && !changedLines.has(relPath)) continue;
    filesScanned++;

    const violations = checkFile(file);
    for (const v of violations) {
      if (diffMode && !changedLines.get(relPath).has(v.line)) continue;
      totalViolations++;
      console.error(
        `${relPath}:${v.line}  prisma.${v.model}.${v.method}() has no apiKeyId scoping anywhere in its call, ` +
        `and no "// tenant-sweep: <reason>" exemption comment above it.`,
      );
    }
  }

  if (totalViolations > 0) {
    console.error(
      `\n${totalViolations} potential tenant-isolation gap(s) found${diffMode ? ' in this change' : ''}. ` +
      `Either scope the query by apiKeyId (directly or via a relation, e.g. "contact: { apiKeyId }"), ` +
      `or if this genuinely needs to scan across all tenants (a background sweep where each row carries ` +
      `and uses its own apiKeyId downstream), add a "// tenant-sweep: <why>" comment on the line above the call.`,
    );
    process.exit(1);
  }

  console.log(
    diffMode
      ? `tenant-isolation check passed (${filesScanned} changed file(s) checked against ${baseRef}).`
      : `tenant-isolation check passed (${files.length} files scanned).`,
  );
}

main();
