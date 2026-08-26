// One-shot migration runner — runs each SQL statement in the migration file
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const sql = readFileSync('./prisma/migrations/20260827_phase2_phase3_phase4.sql', 'utf8');

// Split on semicolons, filter blanks and comments
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
    // Ignore "already exists" errors (idempotent)
    if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('IF NOT EXISTS')) {
      ok++;
      process.stdout.write('s');
    } else {
      errors++;
      console.error(`\nERROR: ${msg.slice(0, 120)}`);
      console.error(`Statement: ${stmt.slice(0, 100)}`);
    }
  }
}

await prisma.$disconnect();
console.log(`\nDone: ${ok} ok, ${errors} errors`);
if (errors > 0) process.exit(1);
