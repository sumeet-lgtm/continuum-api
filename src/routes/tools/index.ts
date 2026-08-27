import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import dns from 'dns/promises';
import tls from 'tls';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { Errors } from '../../plugins/errorHandler.js';
import { checkDeliverability } from '../../engine/deliverability.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

// ─── Spam word lists ──────────────────────────────────────────────────────────

const SPAM_WORDS = [
  'free money','make money fast','click here','buy now','limited time','act now',
  'order now','special promotion','cash bonus','earn extra','work from home',
  'no credit check','guaranteed income','winner','you have been selected',
  'congratulations','urgent','no questions asked','risk free','100% free',
  'opt out','you are receiving this','this is not spam',
  'dear friend','dear valued customer','million dollars','nigerian',
  'weight loss','lose weight fast','casino','online pharmacy','prescription',
];

// ─── SSL checker ─────────────────────────────────────────────────────────────

async function checkSsl(domain: string): Promise<{
  valid: boolean;
  issuer: string | null;
  subject: string | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  protocol: string | null;
  error: string | null;
}> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, timeout: 5000 }, () => {
      try {
        const cert = socket.getPeerCertificate(true);
        const protocol = socket.getProtocol();
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const now = new Date();
        const daysUntilExpiry = validTo
          ? Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null;

        resolve({
          valid: socket.authorized,
          issuer: (Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O) ?? (Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN) ?? null,
          subject: (Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN) ?? null,
          expiresAt: validTo?.toISOString() ?? null,
          daysUntilExpiry,
          protocol: protocol ?? null,
          error: socket.authorized ? null : (socket.authorizationError?.toString() ?? null),
        });
      } catch (e) {
        resolve({ valid: false, issuer: null, subject: null, expiresAt: null, daysUntilExpiry: null, protocol: null, error: String(e) });
      } finally {
        socket.destroy();
      }
    });
    socket.on('error', (err) => {
      resolve({ valid: false, issuer: null, subject: null, expiresAt: null, daysUntilExpiry: null, protocol: null, error: err.message });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ valid: false, issuer: null, subject: null, expiresAt: null, daysUntilExpiry: null, protocol: null, error: 'Connection timed out' });
    });
  });
}

// ─── DKIM record lookup for a specific selector ───────────────────────────────

async function lookupDkim(domain: string, selector: string): Promise<{
  found: boolean;
  record: string | null;
  keyType: string | null;
  keyLength: number | null;
}> {
  try {
    const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
    const raw = records.flat().join('');
    if (!raw) return { found: false, record: null, keyType: null, keyLength: null };

    // Parse key type
    const ktMatch = raw.match(/k=([a-z0-9]+)/i);
    const keyType = ktMatch?.[1] ?? 'rsa';

    // Parse public key length from p= value
    const pMatch = raw.match(/p=([A-Za-z0-9+/=]+)/);
    let keyLength: number | null = null;
    if (pMatch?.[1]) {
      const bytes = Buffer.from(pMatch[1], 'base64').length;
      // RSA key length heuristic: roughly 8 * bytes for the modulus
      keyLength = bytes > 200 ? 2048 : bytes > 100 ? 1024 : null;
    }

    return { found: true, record: raw, keyType, keyLength };
  } catch {
    return { found: false, record: null, keyType: null, keyLength: null };
  }
}

// ─── MX record lookup ────────────────────────────────────────────────────────

async function lookupMx(domain: string): Promise<{ found: boolean; records: Array<{ exchange: string; priority: number }> }> {
  try {
    const records = await dns.resolveMx(domain);
    return {
      found: records.length > 0,
      records: records.sort((a, b) => a.priority - b.priority).map(r => ({ exchange: r.exchange, priority: r.priority })),
    };
  } catch {
    return { found: false, records: [] };
  }
}

// ─── SPF record generator ────────────────────────────────────────────────────

function generateSpfRecord(options: {
  includes?: string[];
  ipv4?: string[];
  ipv6?: string[];
  policy: 'none' | 'softfail' | 'fail';
}): string {
  const parts = ['v=spf1'];
  for (const inc of (options.includes ?? [])) parts.push(`include:${inc}`);
  for (const ip of (options.ipv4 ?? [])) parts.push(`ip4:${ip}`);
  for (const ip of (options.ipv6 ?? [])) parts.push(`ip6:${ip}`);
  const policies: Record<string, string> = { none: '?all', softfail: '~all', fail: '-all' };
  parts.push(policies[options.policy] ?? '~all');
  return parts.join(' ');
}

// ─── DMARC record generator ──────────────────────────────────────────────────

function generateDmarcRecord(options: {
  policy: 'none' | 'quarantine' | 'reject';
  subdomain_policy?: 'none' | 'quarantine' | 'reject';
  rua?: string;
  ruf?: string;
  pct?: number;
  adkim?: 'r' | 's';
  aspf?: 'r' | 's';
}): string {
  const parts = ['v=DMARC1', `p=${options.policy}`];
  if (options.subdomain_policy) parts.push(`sp=${options.subdomain_policy}`);
  if (options.rua) parts.push(`rua=mailto:${options.rua}`);
  if (options.ruf) parts.push(`ruf=mailto:${options.ruf}`);
  if (options.pct !== undefined && options.pct !== 100) parts.push(`pct=${options.pct}`);
  if (options.adkim && options.adkim !== 'r') parts.push(`adkim=${options.adkim}`);
  if (options.aspf && options.aspf !== 'r') parts.push(`aspf=${options.aspf}`);
  return parts.join('; ');
}

// ─── Spam content scorer ─────────────────────────────────────────────────────

function scoreSpamContent(subject: string, body: string): {
  score: number;
  flags: string[];
  recommendation: string;
} {
  const flags: string[] = [];
  let score = 0;
  const text = `${subject} ${body}`.toLowerCase();

  // Spam word hits
  for (const word of SPAM_WORDS) {
    if (text.includes(word)) {
      score += 10;
      flags.push(`Spam phrase: "${word}"`);
    }
  }

  // All caps words
  const capsWords = subject.match(/\b[A-Z]{4,}\b/g) ?? [];
  if (capsWords.length > 0) {
    score += capsWords.length * 5;
    flags.push(`All-caps words in subject: ${capsWords.join(', ')}`);
  }

  // Excessive exclamation
  const excl = (text.match(/!/g) ?? []).length;
  if (excl > 2) { score += excl * 3; flags.push(`${excl} exclamation marks`); }

  // Excessive links
  const links = (body.match(/https?:\/\//gi) ?? []).length;
  if (links > 5) { score += (links - 5) * 2; flags.push(`${links} links in body`); }

  // Dollar signs
  const dollars = (text.match(/\$/g) ?? []).length;
  if (dollars > 1) { score += dollars * 3; flags.push(`${dollars} dollar signs`); }

  // No unsubscribe link is a spam signal; having one is good
  if (!body.toLowerCase().includes('unsubscribe')) { score += 5; flags.push('No unsubscribe link detected'); }

  score = Math.min(100, score);
  const recommendation = score === 0
    ? 'Email looks clean. Low spam risk.'
    : score < 30
    ? 'Minor spam signals. Review flagged items.'
    : score < 60
    ? 'Moderate spam risk. Address flagged items before sending.'
    : 'High spam risk. This email will likely land in spam.';

  return { score, flags, recommendation };
}

// ─── AI subject line generator ───────────────────────────────────────────────

async function generateSubjectLines(context: {
  topic: string;
  tone: string;
  count: number;
  anthropicKey: string;
}): Promise<string[]> {
  const { topic, tone, count, anthropicKey } = context;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Generate ${count} email subject lines for the following context.
Topic: ${topic}
Tone: ${tone}

Requirements:
- Each subject line under 60 characters
- No clickbait or spammy words
- Mix of curiosity, benefit, and question-based styles
- Return ONLY a JSON array of strings, nothing else

Example output: ["Subject 1", "Subject 2", "Subject 3"]`,
      }],
    }),
  });
  if (!resp.ok) throw new Error('Anthropic API error');
  const data = await resp.json() as { content?: Array<{ text?: string }> };
  let text = data.content?.[0]?.text?.trim() ?? '[]';
  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    // If Claude returned an object with a subjects key
    if (typeof parsed === 'object' && parsed !== null && 'subjects' in parsed) {
      return (parsed as { subjects: string[] }).subjects;
    }
    return [];
  } catch {
    // Last resort: extract quoted strings from the text
    const matches = text.match(/"([^"]{5,80})"/g);
    return matches ? matches.map(m => m.slice(1, -1)) : [];
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function toolRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /v1/tools/spf?domain=example.com — SPF record lookup
  fastify.get('/tools/spf', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim();

    try {
      const records = await dns.resolveTxt(domain);
      const spfRecords = records.flat().filter(r => r.toLowerCase().startsWith('v=spf1'));
      const record = spfRecords[0] ?? null;
      const valid = !!record;

      // Parse SPF mechanisms
      const mechanisms: string[] = record ? record.split(' ').filter(p => p !== 'v=spf1') : [];
      const includes = mechanisms.filter(m => m.startsWith('include:')).map(m => m.slice(8));
      const ipv4 = mechanisms.filter(m => m.startsWith('ip4:')).map(m => m.slice(4));
      const policy = record?.match(/([~?+-]?all)$/)?.[1] ?? null;

      return reply.status(200).send({
        domain, valid, record,
        mechanisms: { includes, ipv4, policy },
        recommendation: valid
          ? (policy === '-all' ? 'SPF is configured with strict policy. Excellent.' : 'SPF is configured. Consider using -all for stricter enforcement.')
          : 'No SPF record found. Add a TXT record to your DNS.',
        checkedAt: new Date().toISOString(),
      });
    } catch {
      return reply.status(200).send({
        domain, valid: false, record: null, mechanisms: { includes: [], ipv4: [], policy: null },
        recommendation: 'No SPF record found. Add a TXT record to your DNS.',
        checkedAt: new Date().toISOString(),
      });
    }
  });

  // GET /v1/tools/dmarc?domain=example.com — DMARC record lookup
  fastify.get('/tools/dmarc', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim();

    try {
      const records = await dns.resolveTxt(`_dmarc.${domain}`);
      const record = records.flat().find(r => r.toLowerCase().startsWith('v=dmarc1')) ?? null;
      const valid = !!record;

      const pMatch = record?.match(/\bp=([a-z]+)/i);
      const policy = pMatch?.[1] ?? null;
      const ruaMatch = record?.match(/rua=mailto:([^;]+)/i);
      const reportEmail = ruaMatch?.[1] ?? null;

      return reply.status(200).send({
        domain, valid, record,
        policy, reportEmail,
        recommendation: !valid
          ? 'No DMARC record. Add _dmarc TXT record to enable DMARC.'
          : policy === 'reject'
          ? 'DMARC is set to reject. Maximum protection.'
          : policy === 'quarantine'
          ? 'DMARC is set to quarantine. Consider upgrading to reject after monitoring.'
          : 'DMARC is set to none (monitor only). Upgrade to quarantine or reject.',
        checkedAt: new Date().toISOString(),
      });
    } catch {
      return reply.status(200).send({
        domain, valid: false, record: null, policy: null, reportEmail: null,
        recommendation: 'No DMARC record. Add _dmarc TXT record to enable DMARC.',
        checkedAt: new Date().toISOString(),
      });
    }
  });

  // GET /v1/tools/dkim?domain=example.com&selector=google — DKIM record lookup
  fastify.get('/tools/dkim', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string; selector?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim();
    const selector = q.selector ?? 'default';

    const result = await lookupDkim(domain, selector);
    return reply.status(200).send({
      domain, selector,
      ...result,
      recommendation: result.found
        ? `DKIM record found for selector "${selector}". Email signing is active.`
        : `No DKIM record at ${selector}._domainkey.${domain}. Try a different selector or check your email provider's settings.`,
      checkedAt: new Date().toISOString(),
    });
  });

  // GET /v1/tools/mx?domain=example.com — MX record lookup
  fastify.get('/tools/mx', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim();

    const result = await lookupMx(domain);
    return reply.status(200).send({
      domain, ...result,
      recommendation: result.found
        ? `${result.records.length} MX record(s) found. Domain can receive email.`
        : 'No MX records found. This domain cannot receive email.',
      checkedAt: new Date().toISOString(),
    });
  });

  // GET /v1/tools/ssl?domain=example.com — SSL certificate checker
  fastify.get('/tools/ssl', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim().replace(/^https?:\/\//, '');

    const result = await checkSsl(domain);
    let recommendation = '';
    if (!result.valid) {
      recommendation = `SSL error: ${result.error ?? 'Invalid certificate'}`;
    } else if (result.daysUntilExpiry !== null && result.daysUntilExpiry < 30) {
      recommendation = `Certificate expires in ${result.daysUntilExpiry} days. Renew soon.`;
    } else {
      recommendation = `Certificate is valid. Expires in ${result.daysUntilExpiry} days.`;
    }

    return reply.status(200).send({ domain, ...result, recommendation, checkedAt: new Date().toISOString() });
  });

  // GET /v1/tools/domain-check?domain=example.com — comprehensive domain health (SPF + DMARC + DKIM + blacklist)
  fastify.get('/tools/domain-check', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim();

    const [deliverability, mx, ssl] = await Promise.allSettled([
      checkDeliverability(domain),
      lookupMx(domain),
      checkSsl(domain),
    ]);

    const del = deliverability.status === 'fulfilled' ? deliverability.value : null;
    const mxResult = mx.status === 'fulfilled' ? mx.value : { found: false, records: [] };
    const sslResult = ssl.status === 'fulfilled' ? ssl.value : null;

    let score = 0;
    if (del?.spfValid) score += 20;
    if (del?.dmarcValid) score += 25;
    if (del?.dkimFound) score += 25;
    if (!del?.blacklisted) score += 20;
    if (mxResult.found) score += 5;
    if (sslResult?.valid) score += 5;

    return reply.status(200).send({
      domain,
      score,
      grade: score >= 90 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D',
      checks: {
        spf: { valid: del?.spfValid ?? false, record: del?.spfRecord ?? null },
        dmarc: { valid: del?.dmarcValid ?? false, record: del?.dmarcRecord ?? null },
        dkim: { found: del?.dkimFound ?? false, selectors: del?.dkimSelectors ?? [] },
        blacklist: { clean: !(del?.blacklisted ?? false), hits: del?.blacklists ?? [] },
        mx: mxResult,
        ssl: sslResult ? { valid: sslResult.valid, daysUntilExpiry: sslResult.daysUntilExpiry } : null,
      },
      checkedAt: new Date().toISOString(),
    });
  });

  // GET /v1/tools/blacklist?domain=example.com — blacklist check (shorthand for /domains/blacklist-check)
  fastify.get('/tools/blacklist', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { domain?: string };
    if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);
    const domain = q.domain.toLowerCase().trim();

    const deliverability = await checkDeliverability(domain);
    return reply.status(200).send({
      domain,
      blacklisted: deliverability.blacklisted,
      hits: deliverability.blacklists,
      clean: !deliverability.blacklisted,
      checkedAt: new Date().toISOString(),
    });
  });

  // POST /v1/tools/spam-check — spam content scorer
  fastify.post('/tools/spam-check', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(100_000),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { subject, body } = parsed.data;
    const result = scoreSpamContent(subject, body);
    return reply.status(200).send({ subject, ...result, checkedAt: new Date().toISOString() });
  });

  // POST /v1/tools/subject-line — AI subject line generator
  fastify.post('/tools/subject-line', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({
      topic: z.string().min(5).max(500),
      tone: z.enum(['professional', 'casual', 'witty', 'urgent', 'curious']).default('professional'),
      count: z.number().int().min(1).max(10).default(5),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const anthropicKey = config.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw Errors.serviceUnavailable('AI service temporarily unavailable.');

    const { topic, tone, count } = parsed.data;
    try {
      const subjects = await generateSubjectLines({ topic, tone, count, anthropicKey });
      return reply.status(200).send({
        topic, tone,
        subjects,
        model: 'claude-haiku-4-5-20251001',
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err }, 'Subject line generation failed');
      throw Errors.serviceUnavailable('Subject line generation temporarily unavailable.');
    }
  });

  // GET /v1/tools/spf-generator — generate an SPF record from options
  fastify.get('/tools/spf-generator', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({
      includes: z.string().optional(), // comma-separated: amazonses.com,sendgrid.net
      ipv4: z.string().optional(),     // comma-separated: 1.2.3.4,5.6.7.8
      ipv6: z.string().optional(),
      policy: z.enum(['none', 'softfail', 'fail']).default('softfail'),
    });
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { includes, ipv4, ipv6, policy } = parsed.data;
    const record = generateSpfRecord({
      includes: includes ? includes.split(',').map(s => s.trim()).filter(Boolean) : [],
      ipv4:     ipv4     ? ipv4.split(',').map(s => s.trim()).filter(Boolean)     : [],
      ipv6:     ipv6     ? ipv6.split(',').map(s => s.trim()).filter(Boolean)     : [],
      policy,
    });
    return reply.status(200).send({
      record,
      ttl: 3600,
      type: 'TXT',
      instructions: `Add this TXT record to your domain's DNS with TTL ${3600}.`,
    });
  });

  // GET /v1/tools/dmarc-generator — generate a DMARC record from options
  fastify.get('/tools/dmarc-generator', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({
      policy: z.enum(['none', 'quarantine', 'reject']).default('none'),
      subdomain_policy: z.enum(['none', 'quarantine', 'reject']).optional(),
      rua: z.string().email().optional(),
      ruf: z.string().email().optional(),
      pct: z.coerce.number().int().min(1).max(100).default(100),
    });
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { policy, pct, rua, ruf, subdomain_policy } = parsed.data;
    const record = generateDmarcRecord({
      policy, pct,
      ...(rua !== undefined && { rua }),
      ...(ruf !== undefined && { ruf }),
      ...(subdomain_policy !== undefined && { subdomain_policy }),
    });
    return reply.status(200).send({
      record,
      host: '_dmarc',
      type: 'TXT',
      ttl: 3600,
      instructions: `Add this TXT record to _dmarc.yourdomain.com with TTL 3600.`,
    });
  });

  // GET /v1/tools/rates — email metrics calculators
  fastify.get('/tools/rates', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const schema = z.object({
      sent:        z.coerce.number().int().min(0),
      delivered:   z.coerce.number().int().min(0).optional(),
      opened:      z.coerce.number().int().min(0).optional(),
      clicked:     z.coerce.number().int().min(0).optional(),
      bounced:     z.coerce.number().int().min(0).optional(),
      complained:  z.coerce.number().int().min(0).optional(),
      unsubscribed: z.coerce.number().int().min(0).optional(),
    });
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { sent, delivered = 0, opened = 0, clicked = 0, bounced = 0, complained = 0, unsubscribed = 0 } = parsed.data;
    const base = delivered > 0 ? delivered : sent;

    const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 10000) / 100 : 0;

    return reply.status(200).send({
      input: { sent, delivered, opened, clicked, bounced, complained, unsubscribed },
      rates: {
        delivery_rate: pct(delivered, sent),
        open_rate:     pct(opened, base),
        click_rate:    pct(clicked, base),
        cto_rate:      pct(clicked, opened),      // click-to-open rate
        bounce_rate:   pct(bounced, sent),
        complaint_rate: pct(complained, delivered > 0 ? delivered : sent),
        unsubscribe_rate: pct(unsubscribed, base),
      },
      benchmarks: {
        open_rate:    { good: '>20%',  average: '15-20%', poor: '<15%' },
        click_rate:   { good: '>3%',   average: '1-3%',   poor: '<1%'  },
        cto_rate:     { good: '>15%',  average: '10-15%', poor: '<10%' },
        bounce_rate:  { good: '<1%',   average: '1-3%',   poor: '>3%'  },
        complaint_rate: { good: '<0.08%', average: '0.08-0.1%', poor: '>0.1%' },
      },
    });
  });
}
