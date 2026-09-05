import net from 'node:net';
import type { SmtpProbeResult } from '../types/verification.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { isFreeEmailProvider } from './lookalike.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

const CATCHALL_PROBE_LOCAL = 'cnt-probe-v1-xq7z2k9m';
const SMTP_PORT = 25;
const SMTP_PORT_FALLBACK = 587;
const MAX_MX_ATTEMPTS = 3;
const DOMAIN_CATCHALL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Catch-all status belongs to the domain's mail server, not to any one
// mailbox on it — a bulk list is routinely dozens or hundreds of different
// addresses at the same handful of company domains, so the second (and
// 500th) email at a domain we've already probed shouldn't pay for a live
// SMTP round trip just to learn the same answer again. Shared across every
// customer, same reasoning as the per-email SmtpCache elsewhere.
async function getDomainCatchAll(domain: string): Promise<boolean | null> {
  try {
    const cached = await prisma.domainCatchAllCache.findUnique({ where: { domain } });
    if (!cached || cached.expiresAt < new Date()) return null;
    return cached.isCatchAll;
  } catch (err) {
    logger.warn({ err, domain }, 'Domain catch-all cache read failed — probing live');
    return null;
  }
}

function setDomainCatchAll(domain: string, isCatchAll: boolean): void {
  const expiresAt = new Date(Date.now() + DOMAIN_CATCHALL_TTL_MS);
  prisma.domainCatchAllCache
    .upsert({
      where: { domain },
      create: { domain, isCatchAll, expiresAt },
      update: { isCatchAll, checkedAt: new Date(), expiresAt },
    })
    .catch((err) => logger.warn({ err, domain }, 'Failed to cache domain catch-all status'));
}

/**
 * Probe a domain's MX hosts in priority order, stopping at the first one
 * that yields a definitive result. A single flaky or probe-hostile MX
 * host (rate-limiting, firewalling the probe IP) shouldn't sink the whole
 * verification to "unknown" when the domain has working secondaries —
 * this is what most of the accuracy gap between a single-host probe and a
 * paid verification API actually comes from.
 */
export async function smtpProbeWithFallback(
  email: string,
  mxHosts: string[],
): Promise<SmtpProbeResult> {
  const hosts = mxHosts.slice(0, MAX_MX_ATTEMPTS);
  let last: SmtpProbeResult = notChecked('No MX hosts to probe');
  for (const host of hosts) {
    const result = await smtpProbe(email, host);
    if (result.checked) return result;
    last = result;
    // The relay itself is down, not this specific MX host — every
    // remaining host in this list goes through the same relay and would
    // fail the exact same way, so retrying them only adds latency with
    // zero chance of a different outcome.
    if (result.error === 'relay_unreachable') break;
  }
  return last;
}

// Found live: SMTP_PROBE_URL points at a relay VPS that was down, and every
// single verification was still paying its full 15s connect-timeout tax
// (via remoteProbe below) before ever falling through to localProbe or the
// paid-provider fallback — a "relay down" outage was silently costing
// 15s on 100% of traffic, not just failing gracefully. This circuit
// breaker remembers a relay outage for a short window so the 10,000th
// verification during an outage skips straight past the dead relay
// instead of re-discovering it's dead one more time.
const RELAY_DOWN_KEY = 'smtp:relay_down';
const RELAY_DOWN_TTL_SECONDS = 60;

async function isRelayMarkedDown(): Promise<boolean> {
  try {
    return (await redis.get(RELAY_DOWN_KEY)) !== null;
  } catch {
    return false; // Redis itself unavailable — don't let that also disable the relay
  }
}

function markRelayDown(): void {
  redis.set(RELAY_DOWN_KEY, '1', { px: RELAY_DOWN_TTL_SECONDS * 1000 }).catch(() => {});
}

export async function smtpProbe(
  email: string,
  mxHost: string,
): Promise<SmtpProbeResult> {
  if (!config.SMTP_CHECK_ENABLED) {
    return notChecked('SMTP check disabled via SMTP_CHECK_ENABLED=false');
  }

  const domain = email.split('@')[1] ?? '';
  if (!domain) return notChecked('Could not extract domain from email');

  const useRelay = config.SMTP_PROBE_URL && !(await isRelayMarkedDown());
  const result = useRelay
    ? await remoteProbe(email, mxHost)
    : await localProbe(email, domain, mxHost);

  if (result.error === 'relay_unreachable') {
    markRelayDown();
  }

  // Major consumer webmail providers (Gmail chief among them) commonly
  // accept RCPT TO for almost any syntactically valid local-part and only
  // reject nonexistent mailboxes later, asynchronously, via a bounce email —
  // there is no reliable real-time SMTP signal to probe for a catch-all on
  // them. Reporting one anyway doesn't detect a real catch-all domain, it
  // just reliably mislabels ordinary valid Gmail/Outlook/Yahoo addresses as
  // "risky: catch-all", which is actively harmful given how common these
  // domains are among real recipients — every serious verification provider
  // excludes this same domain set from catch-all detection for exactly this
  // reason. Applied uniformly after either probe path so it can't be
  // silently lost if the remote microservice is swapped out or bypassed.
  if (result.checked && result.isCatchAll && isFreeEmailProvider(domain)) {
    return { ...result, isCatchAll: false };
  }
  return result;
}

async function localProbe(email: string, domain: string, mxHost: string): Promise<SmtpProbeResult> {
  const port = await resolvePort(mxHost);
  if (port === null) {
    return notChecked(`Cannot connect to ${mxHost} on port 25 or 587`);
  }

  // Skip the live catch-all probe entirely when we already know this
  // domain's answer — this is the common case for any bulk list clustered
  // by company domain (a Finder-sourced lead list, a company's own contact
  // export), since only the first email at a given domain ever needs to
  // pay for it. When we do still need it, it's an independent connection
  // to the same mxHost with no ordering dependency on the target probe, so
  // it runs in parallel rather than after (measured live: ~16s sequential
  // -> ~8s parallel for the cache-miss case) — this is where most of a
  // bulk job's runtime goes, since EMAIL_CONCURRENCY chunks are gated on
  // the slowest email in the batch.
  const cachedCatchAll = await getDomainCatchAll(domain);
  const catchAllAddr = `${CATCHALL_PROBE_LOCAL}@${domain}`;
  const [targetResult, catchAllResult] = await Promise.all([
    probeAddress(email, mxHost, port),
    cachedCatchAll !== null ? Promise.resolve(null) : probeAddress(catchAllAddr, mxHost, port),
  ]);

  if (!targetResult.connected) {
    return notChecked(targetResult.error ?? `Could not connect to ${mxHost}:${port}`);
  }

  if (targetResult.greylisted) {
    return {
      checked:     true,
      reachable:   null,
      isCatchAll:  null,
      greylisted:  true,
      rawResponse: targetResult.rawResponse,
      error:       'smtp_greylisted',
    };
  }

  if (!targetResult.accepted) {
    return {
      checked:     true,
      reachable:   false,
      isCatchAll:  null,
      greylisted:  false,
      rawResponse: targetResult.rawResponse,
      error:       null,
    };
  }

  const isCatchAll = cachedCatchAll !== null
    ? cachedCatchAll
    : (catchAllResult!.connected && catchAllResult!.accepted && !catchAllResult!.greylisted);

  if (cachedCatchAll === null) {
    // Fire-and-forget — never let a slow cache write hold up the response.
    setDomainCatchAll(domain, isCatchAll);
  }

  return {
    checked:     true,
    reachable:   true,
    isCatchAll,
    greylisted:  false,
    rawResponse: targetResult.rawResponse,
    error:       null,
  };
}

// ─── Remote probe via SMTP microservice ───────────────────────────────────────

async function remoteProbe(email: string, mxHost: string): Promise<SmtpProbeResult> {
  try {
    const res = await fetch(`${config.SMTP_PROBE_URL}/probe`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-probe-key':   config.SMTP_PROBE_KEY ?? '',
      },
      body:    JSON.stringify({ email, mxHost }),
      signal:  AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status, email }, 'Remote SMTP probe returned error');
      return notChecked(`Remote probe HTTP ${res.status}`);
    }

    const data = await res.json() as {
      checked: boolean;
      reachable: boolean | null;
      isCatchAll: boolean | null;
      greylisted: boolean;
      error: string | null;
    };

    return {
      checked:     data.checked,
      reachable:   data.reachable,
      isCatchAll:  data.isCatchAll,
      greylisted:  data.greylisted,
      rawResponse: '',
      error:       data.error,
    };
  } catch (err) {
    logger.error({ err, email }, 'Remote SMTP probe failed');
    // A connection-level failure (the relay VPS itself refused/timed out,
    // as opposed to a non-2xx response meaning the relay was reached but
    // errored) means every other MX host for this same domain will fail
    // identically — they all go through this one relay. Tagging this
    // distinctly lets the caller stop retrying immediately instead of
    // wasting the full per-host timeout 2 more times against a relay
    // that's already known to be down (found live: a genuine relay outage
    // was costing ~30s per verification — 3 sequential 10s connect
    // timeouts — before ever reaching the paid-provider fallback).
    const isConnectFailure = err instanceof Error && (
      err.name === 'ConnectTimeoutError' ||
      err.cause instanceof Error && err.cause.name === 'ConnectTimeoutError' ||
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(err.message)
    );
    return notChecked(isConnectFailure ? 'relay_unreachable' : 'Remote probe unreachable');
  }
}

// ─── Local probe helpers ──────────────────────────────────────────────────────

async function resolvePort(host: string): Promise<25 | 587 | null> {
  // Same reasoning as the target/catch-all probes below: these are two
  // independent TCP connects, so check both at once instead of paying up
  // to 2s for a doomed port-25 attempt before ever trying 587.
  const [canConnect25, canConnect587] = await Promise.all([
    tcpReachable(host, SMTP_PORT, 2_000),
    tcpReachable(host, SMTP_PORT_FALLBACK, 2_000),
  ]);
  if (canConnect25) return 25;
  if (canConnect587) return 587;
  return null;
}

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error',   () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

interface ProbeResult {
  connected:   boolean;
  accepted:    boolean;
  greylisted:  boolean;
  rawResponse: string | null;
  error?:      string | null;
}

function probeAddress(email: string, mxHost: string, port: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket     = new net.Socket();
    const timeoutMs  = 10_000;
    let buffer       = '';
    let step         = 'banner';
    let accepted     = false;
    let greylisted   = false;
    let rawResponse  = '';
    let settled      = false;

    socket.setTimeout(timeoutMs);

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      try { socket.write('QUIT\r\n'); } catch (_) {}
      setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 300);
      resolve(result);
    };

    const send = (cmd: string) => {
      rawResponse += `> ${cmd}\n`;
      socket.write(cmd + '\r\n');
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      rawResponse += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const isLast = line[3] === ' ' || line.length === 3;
        if (!isLast) continue;

        if (step === 'banner') {
          if (code === 220) { step = 'ehlo'; send(`EHLO ${config.SMTP_HELO_DOMAIN}`); }
          else settle({ connected: true, accepted: false, greylisted: false, rawResponse, error: `bad banner ${code}` });
        } else if (step === 'ehlo') {
          if (code === 250) { step = 'mailfrom'; send(`MAIL FROM:<probe@${config.SMTP_HELO_DOMAIN}>`); }
        } else if (step === 'mailfrom') {
          if (code === 250) { step = 'rcptto'; send(`RCPT TO:<${email}>`); }
          else settle({ connected: true, accepted: false, greylisted: false, rawResponse, error: `MAIL FROM rejected ${code}` });
        } else if (step === 'rcptto') {
          if (code === 250 || code === 251) { accepted = true; }
          else if (code >= 400 && code < 500) { greylisted = true; }
          settle({ connected: true, accepted, greylisted, rawResponse, error: null });
        }
      }
    });

    socket.once('timeout', () => settle({ connected: false, accepted: false, greylisted: false, rawResponse, error: 'timeout' }));
    socket.once('error',   (err) => settle({ connected: false, accepted: false, greylisted: false, rawResponse, error: err.message }));
    socket.connect(port, mxHost);
  });
}

function notChecked(reason: string): SmtpProbeResult {
  logger.debug({ reason }, 'SMTP probe skipped');
  return { checked: false, reachable: null, isCatchAll: null, greylisted: false, rawResponse: null, error: reason };
}
