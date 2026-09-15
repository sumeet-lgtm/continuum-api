// Genuine attacker's-eye test of the continuum_app restricted role, run
// directly against production BEFORE any service's DATABASE_URL moves.
// Proves RLS actually enforces (zero rows / permission denied), not just
// that GRANTs were applied without error.
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const crypto = require('crypto');

const restrictedUrl = fs.readFileSync(
  'C:/Users/sumit/AppData/Local/Temp/claude/C--Users-sumit-wyberai/6154bc46-8825-48aa-ba43-65665e5cd8ac/scratchpad/continuum_app_database_url.txt',
  'utf8'
).trim();

const restricted = new PrismaClient({ datasources: { db: { url: restrictedUrl } } });
const privileged = new PrismaClient(); // current DATABASE_URL — postgres role, setup/cleanup only

const LABEL_A = 'RLS-VERIFY-DO-NOT-USE-A';
const LABEL_B = 'RLS-VERIFY-DO-NOT-USE-B';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('  PASS:', msg);
}

async function assertRejects(fn, pattern, msg) {
  try {
    await fn();
    throw new Error('ASSERTION FAILED (expected rejection): ' + msg);
  } catch (e) {
    if (e.message.startsWith('ASSERTION FAILED')) throw e;
    if (!pattern.test(e.message)) {
      throw new Error(`ASSERTION FAILED: ${msg} — got wrong error: ${e.message.slice(0, 200)}`);
    }
    console.log('  PASS:', msg, `(refused: ${e.message.split('\n')[0].slice(0, 100)})`);
  }
}

async function main() {
  const rawA = 'verify_a_' + crypto.randomBytes(16).toString('hex');
  const rawB = 'verify_b_' + crypto.randomBytes(16).toString('hex');
  const keyA = await privileged.apiKey.create({
    data: { keyHash: crypto.createHash('sha256').update(rawA).digest('hex'), keyPrefix: rawA.slice(0, 8), label: LABEL_A },
  });
  const keyB = await privileged.apiKey.create({
    data: { keyHash: crypto.createHash('sha256').update(rawB).digest('hex'), keyPrefix: rawB.slice(0, 8), label: LABEL_B },
  });
  const contactA = await privileged.contact.create({ data: { apiKeyId: keyA.id, email: 'verify-a@example.invalid' } });
  const contactB = await privileged.contact.create({ data: { apiKeyId: keyB.id, email: 'verify-b@example.invalid' } });
  console.log('Setup complete: keyA=%s keyB=%s contactA=%s contactB=%s\n', keyA.id, keyB.id, contactA.id, contactB.id);

  try {
    console.log('(a) Same-tenant CRUD succeeds under RLS:');
    await restricted.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_api_key_id = '${keyA.id}'`);
      const found = await tx.contact.findMany({ where: { apiKeyId: keyA.id } });
      assert(found.some((c) => c.id === contactA.id), 'same-tenant read sees own row');
      const updated = await tx.contact.update({ where: { id: contactA.id }, data: { firstName: 'Verified' } });
      assert(updated.firstName === 'Verified', 'same-tenant update applies');
    });

    console.log('\n(b) Cross-tenant read/write returns ZERO ROWS:');
    await restricted.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_api_key_id = '${keyA.id}'`);
      const leaked = await tx.contact.findMany({ where: { id: contactB.id } });
      assert(leaked.length === 0, 'cross-tenant read returns zero rows (RLS enforcing)');
      const affected = await tx.contact.updateMany({ where: { id: contactB.id }, data: { firstName: 'PWNED' } });
      assert(affected.count === 0, 'cross-tenant write affects zero rows (RLS enforcing)');
    });

    console.log('\n(c) app.rls_bypass restores cross-tenant visibility (worker-sweep path):');
    await restricted.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.rls_bypass = 'true'`);
      const both = await tx.contact.findMany({ where: { id: { in: [contactA.id, contactB.id] } } });
      assert(both.length === 2, 'rls_bypass restores full cross-tenant visibility');
    });

    console.log('\n(d) DDL is refused (proves run-migration.mjs would fail loudly, not silently):');
    await assertRejects(
      () => restricted.$executeRawUnsafe(`CREATE TABLE _continuum_app_role_probe (id int)`),
      /permission denied/i,
      'restricted role cannot CREATE TABLE',
    );
    await assertRejects(
      () => restricted.$executeRawUnsafe(`ALTER TABLE contacts ADD COLUMN _probe TEXT`),
      /permission denied|must be owner/i,
      'restricted role cannot ALTER TABLE',
    );

    console.log('\nALL CHECKS PASSED');
  } finally {
    await privileged.contact.deleteMany({ where: { id: { in: [contactA.id, contactB.id] } } });
    await privileged.apiKey.deleteMany({ where: { id: { in: [keyA.id, keyB.id] } } });
    console.log('\nCleanup complete.');
  }
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { await restricted.$disconnect(); await privileged.$disconnect(); });
