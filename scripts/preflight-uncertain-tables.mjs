// Read-only: confirms the existence + schema of 4 tables referenced via raw
// SQL (billing/index.ts, emailSweep.ts) but never declared in schema.prisma,
// before finalizing GRANT statements for the new restricted role.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const names = ['status_subscribers', 'sent_emails', 'processed_webhooks', 'profiles'];

(async () => {
  const schemas = await prisma.$queryRaw`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_name = ANY(${names})`;
  console.log('Schema location:', JSON.stringify(schemas, null, 2));

  for (const n of names) {
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = '${n}' ORDER BY ordinal_position`);
    console.log(`\n${n}:`, cols.length ? JSON.stringify(cols, null, 2) : 'DOES NOT EXIST');
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
