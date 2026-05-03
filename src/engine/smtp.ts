import net from 'node:net';
import type { SmtpProbeResult } from '../types/verification.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const CATCHALL_PROBE_LOCAL = 'cnt-probe-v1-xq7z2k9m';
const SMTP_PORT = 25;
const SMTP_PORT_FALLBACK = 587;

export async function smtpProbe(
  email: string,
  mxHost: string,
): Promise<SmtpProbeResult> {
  if (!config.SMTP_CHECK_ENABLED) {
    return notChecked('SMTP check disabled via SMTP_CHECK_ENABLED=false');
  }

  const domain = email.split('@')[1] ?? '';
  if (!domain) return notChecked('Could not extract domain from email');

  // ── Use remote SMTP probe microservice if configured ──────────────────────
  if (config.SMTP_PROBE_URL) {
    return remoteProbe(email, mxHost);
  }

  // ── Local SMTP probe (fallback — may fail on cloud providers) ─────────────
  const port = await resolvePort(mxHost);
  if (port === null) {
    return notChecked(`Cannot connect to ${mxHost} on port 25 or 587`);
  }

  const targetResult = await probeAddress(email, mxHost, port);

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

  const catchAllAddr   = `${CATCHALL_PROBE_LOCAL}@${domain}`;
  const catchAllResult = await probeAddress(catchAllAddr, mxHost, port);
  const isCatchAll     = catchAllResult.connected && catchAllResult.accepted && !catchAllResult.greylisted;

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
    return notChecked('Remote probe unreachable');
  }
}

// ─── Local probe helpers ──────────────────────────────────────────────────────

async function resolvePort(host: string): Promise<25 | 587 | null> {
  const canConnect25  = await tcpReachable(host, SMTP_PORT, 2_000);
  if (canConnect25) return 25;
  const canConnect587 = await tcpReachable(host, SMTP_PORT_FALLBACK, 2_000);
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
  return { checked: false, reachable: null, isCatchAll: null, greylisted: false, rawResponse: '', error: null };
}
