/**
 * CLI: Generate a new Continuum API key.
 *
 * Usage:
 *   npx tsx scripts/generate-api-key.ts [--label "My key"] [--owner "user_123"] [--rpm 500]
 *
 * Outputs the raw key ONCE — it is not stored and cannot be recovered.
 * Only the SHA-256 hash is saved to the database.
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

// Inline minimal config so the script works without the full src/ tree compiled
const salt = process.env['API_KEY_SALT'] ?? 'dev-salt-change-in-production';

function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(salt + rawKey).digest('hex');
}

function generateApiKey(): string {
  return `cnt_${crypto.randomBytes(24).toString('hex')}`;
}

function getKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 12); // "cnt_" + 8 chars
}

function parseArgs(): { label?: string; owner?: string; rpm: number } {
  const args = process.argv.slice(2);
  let label: string | undefined;
  let owner: string | undefined;
  let rpm = 1000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label' && args[i + 1]) {
      label = args[++i];
    } else if (args[i] === '--owner' && args[i + 1]) {
      owner = args[++i];
    } else if (args[i] === '--rpm' && args[i + 1]) {
      rpm = parseInt(args[++i] ?? '1000', 10);
      if (isNaN(rpm) || rpm < 1) {
        console.error('--rpm must be a positive integer');
        process.exit(1);
      }
    }
  }

  return { label, owner, rpm };
}

async function main(): Promise<void> {
  const { label, owner, rpm } = parseArgs();

  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = getKeyPrefix(rawKey);

  const prisma = new PrismaClient();

  try {
    const apiKey = await prisma.apiKey.create({
      data: {
        keyHash,
        keyPrefix,
        label: label ?? null,
        ownerId: owner ?? null,
        rateLimit: rpm,
        isActive: true,
      },
    });

    console.log('\n✅ API key created successfully\n');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log(`│  ID:       ${apiKey.id}`);
    console.log(`│  Prefix:   ${keyPrefix}`);
    if (label) console.log(`│  Label:    ${label}`);
    if (owner) console.log(`│  Owner:    ${owner}`);
    console.log(`│  RPM:      ${rpm}`);
    console.log('│');
    console.log(`│  KEY:      ${rawKey}`);
    console.log('│');
    console.log('│  ⚠  Save this key now — it will not be shown again.');
    console.log('└─────────────────────────────────────────────────────────────┘\n');
    console.log('Usage:');
    console.log(`  curl -H "Authorization: Bearer ${rawKey}" http://localhost:3000/health\n`);
  } catch (err) {
    console.error('Failed to create API key:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
