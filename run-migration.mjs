// Applies all SQL migrations in order (idempotent).
// Handles both standalone top-level .sql files and Prisma-style
// subdirectory migrations (YYYYMMDD.../migration.sql).
// Deduplicates: if both 20260903_foo.sql and 20260903_foo/migration.sql
// exist, only the top-level file runs (it wins because it registers the
// key first in the sorted directory listing).
import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const MIGRATIONS_DIR = './prisma/migrations';

const entries = [];
const seen = new Set();

for (const entry of readdirSync(MIGRATIONS_DIR).sort()) {
  const fullPath = join(MIGRATIONS_DIR, entry);
  const stat = statSync(fullPath);

  if (stat.isFile() && entry.endsWith('.sql')) {
    // Top-level standalone file: 20260903000001_send_window.sql
    const key = entry.replace(/\.sql$/, '');
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ key, label: entry, path: fullPath });
    }
  } else if (stat.isDirectory()) {
    // Prisma-style subdirectory: 20260903000001_send_window/migration.sql
    const migSql = join(fullPath, 'migration.sql');
    try {
      statSync(migSql);
      const key = entry;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ key, label: `${entry}/migration.sql`, path: migSql });
      }
    } catch {
      // no migration.sql in this directory — skip
    }
  }
}

entries.sort((a, b) => a.key.localeCompare(b.key));

console.log(`Found ${entries.length} migration(s):`);
entries.forEach(e => console.log(`  ${e.label}`));

let totalOk = 0;
let totalErrors = 0;

for (const { label, path: filePath } of entries) {
  console.log(`\nApplying: ${label}`);
  const sql = readFileSync(filePath, 'utf8');

  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

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
        msg.includes('does not exist') // DROP IF EXISTS when table missing
      ) {
        ok++;
        process.stdout.write('s');
      } else {
        errors++;
        console.error(`\nERROR in ${label}: ${msg.slice(0, 200)}`);
        console.error(`Statement: ${stmt.slice(0, 150)}`);
      }
    }
  }

  console.log(`\n  ${label}: ${ok} ok, ${errors} errors`);
  totalOk += ok;
  totalErrors += errors;
}

await prisma.$disconnect();
console.log(`\nTotal: ${totalOk} ok, ${totalErrors} errors`);
if (totalErrors > 0) process.exit(1);
