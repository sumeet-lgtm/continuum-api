// Applies all standalone SQL migration files in order (idempotent).
// Only reads top-level .sql files directly inside ./prisma/migrations/
// (not Prisma-style subdirectories) — those subdirectory migrations are
// applied via prisma migrate deploy or manually.
import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const MIGRATIONS_DIR = './prisma/migrations';

// All standalone .sql files (not inside subdirectories) sorted by name
const files = readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`Found ${files.length} standalone SQL migration(s): ${files.join(', ')}`);

let totalOk = 0;
let totalErrors = 0;

for (const file of files) {
  const path = join(MIGRATIONS_DIR, file);
  console.log(`\nApplying: ${file}`);
  const sql = readFileSync(path, 'utf8');

  // Strip `--` line comments BEFORE splitting on `;` — a comment containing
  // its own semicolon (e.g. "-- ...; retention is 30 days.", the exact line
  // that broke 20260903_api_request_logs.sql and silently crash-looped
  // every worker service using this script for two days, since their start
  // command is `node run-migration.mjs && node dist/worker...js` and this
  // script calls process.exit(1) on any statement error) previously split
  // into a real statement fragment ("-- ...hook", correctly filtered by
  // startsWith('--')) and a garbage leftover (" retention is 30 days.",
  // which does NOT start with '--' once its own leading comment marker was
  // consumed by the split, so it survived the filter and got executed as SQL.
  const sqlWithoutComments = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');

  const statements = sqlWithoutComments
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  let ok = 0;
  let errors = 0;

  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt + ';');
      ok++;
      process.stdout.write('.');
    } catch (err) {
      const msg = err.message ?? String(err);
      if (
        msg.includes('already exists') ||
        msg.includes('duplicate') ||
        msg.includes('IF NOT EXISTS') ||
        msg.includes('does not exist')  // DROP IF EXISTS when table missing
      ) {
        ok++;
        process.stdout.write('s');
      } else {
        errors++;
        console.error(`\nERROR in ${file}: ${msg.slice(0, 200)}`);
        console.error(`Statement: ${stmt.slice(0, 150)}`);
      }
    }
  }

  console.log(`\n  ${file}: ${ok} ok, ${errors} errors`);
  totalOk += ok;
  totalErrors += errors;
}

await prisma.$disconnect();
console.log(`\nTotal: ${totalOk} ok, ${totalErrors} errors`);
if (totalErrors > 0) process.exit(1);
