import net from 'node:net';
import type { SmtpProbeResult } from '../types/verification.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Unique probe address used for catch-all detection.
 * Must not be a real address — randomised suffix prevents any chance
 * of accidentally matching a real mailbox.
 */
const CATCHALL_PROBE_LOCAL = 'cnt-probe-v1-xq7z2k9m';

/** Primary SMTP port (MTA-to-MTA) */
const SMTP_PORT = 25;

/** Submission port fallback — some providers block port 25 outbound */
const SMTP_PORT_FALLBACK = 587;

/**
 * Perform a safe SMTP probe against an MX host.
 *
 * Protocol sequence:
 *   TCP connect → read banner (220) → EHLO → MAIL FROM → RCPT TO → QUIT
 *
 * Catch-all detection:
 *   After confirming the real address is accepted, a second connection
 *   probes a known-invalid address on the same domain.
 *   If the server accepts it too, isCatchAll = true.
 *
 * Safety guarantees:
 *   - DATA is never sent — zero email delivered
 *   - Every TCP connection is closed after QUIT or on timeout/error
 *   - Network errors set smtpChecked=false (not invalid) — fail open
 *   - Port 25 is tried first; 587 is used only when port 25 is refused/reset
 *
 * Greylisting:
 *   A 4xx RCPT response after a clean EHLO is treated as "greylisted" and
 *   mapped to subStatus=smtp_greylisted with smtpReachable=null (unknown).
 */
export async function smtpProbe(
  email: string,
  mxHost: string,
): Promise<SmtpProbeResult> {
  if (!config.SMTP_CHECK_ENABLED) {
    return notChecked('SMTP check disabled via SMTP_CHECK_ENABLED=false');
  }

  const domain = email.split('@')[1] ?? '';
  if (!domain) return notChecked('Could not extract domain from email');

  // ── Step 1: probe the actual target address ───────────────────────────────
  const port = await resolvePort(mxHost);
  if (port === null) {
    return notChecked(`Cannot connect to ${mxHost} on port 25 or 587`);
  }

  const targetResult = await probeAddress(email, mxHost, port);

  if (!targetResult.connected) {
    return notChecked(targetResult.error ?? `Could not connect to ${mxHost}:${port}`);
  }

  // Greylisting: temporary rejection at RCPT TO — address might exist
  if (targetResult.greylisted) {
    return {
      checked:     true,
      reachable:   null,          // indeterminate — try again later
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

  // ── Step 2: catch-all detection ───────────────────────────────────────────
  const catchAllAddr  = `${CATCHALL_PROBE_LOCAL}@${domain}`;
  const catchAllResult = await probeAddress(catchAllAddr, mxHost, port);

  const isCatchAll =
    catchAllResult.connected && catchAllResult.accepted && !catchAllResult.greylisted;

  return {
    checked:     true,
    reachable:   true,
    isCatchAll:  isCatchAll,
    greylisted:  false,
    rawResponse: targetResult.rawResponse,
    error:       null,
  };
}

// ─── Port resolution ──────────────────────────────────────────────────────────

/**
 * Attempt a quick TCP connect to determine which port is reachable.
 * Returns 25, 587, or null if both are unreachable.
 */
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
    const timer  = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─── Low-level SMTP session ───────────────────────────────────────────────────

interface ProbeResult {
  connected:   boolean;
  accepted:    boolean;
  greylisted:  boolean;
  rawResponse: string;
  error:       string | null;
}

interface SessionState {
  socket:  net.Socket;
  done:    boolean;
  buffer:  string;
}

async function probeAddress(
  email: string,
  mxHost: string,
  port: 25 | 587,
): Promise<ProbeResult> {
  const timeoutMs  = config.SMTP_CHECK_TIMEOUT_MS;
  const heloDomain = config.SMTP_HELO_DOMAIN;

  return new Promise<ProbeResult>((resolve) => {
    const state: SessionState = {
      socket: new net.Socket(),
      done:   false,
      buffer: '',
    };

    type Stage = 'banner' | 'ehlo' | 'mail_from' | 'rcpt_to' | 'quit';
    let stage: Stage = 'banner';
    let rawLog = '';

    const finish = (
      accepted: boolean,
      greylisted = false,
      error: string | null = null,
    ): void => {
      if (state.done) return;
      state.done = true;
      clearTimeout(globalTimer);
      try {
        if (!state.socket.destroyed) {
          state.socket.write('QUIT\r\n');
          // Give the server a moment to respond then destroy
          setTimeout(() => { if (!state.socket.destroyed) state.socket.destroy(); }, 500);
        }
      } catch { /* ignore cleanup errors */ }
      resolve({
        connected:   true,
        accepted,
        greylisted,
        rawResponse: rawLog.slice(0, 1024),
        error,
      });
    };

    const abort = (error: string): void => {
      if (state.done) return;
      state.done = true;
      clearTimeout(globalTimer);
      try { state.socket.destroy(); } catch { /* ignore */ }
      resolve({ connected: false, accepted: false, greylisted: false, rawResponse: '', error });
    };

    const globalTimer = setTimeout(
      () => abort(`SMTP session timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    state.socket.setTimeout(timeoutMs);
    state.socket.on('timeout', () => abort('Socket read timeout'));
    state.socket.on('error',   (err) => abort(err.message));
    state.socket.on('close',   () => {
      if (!state.done) {
        clearTimeout(globalTimer);
        resolve({
          connected:   true,
          accepted:    false,
          greylisted:  false,
          rawResponse: rawLog.slice(0, 1024),
          error:       'Connection closed unexpectedly',
        });
        state.done = true;
      }
    });

    state.socket.connect(port, mxHost);

    state.socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('ascii');
      rawLog       += text;
      state.buffer += text;

      // Process complete SMTP response lines from the buffer
      let crlfIdx: number;
      while ((crlfIdx = state.buffer.indexOf('\r\n')) !== -1) {
        const line        = state.buffer.slice(0, crlfIdx);
        state.buffer      = state.buffer.slice(crlfIdx + 2);

        if (line.length < 3) continue;

        const code    = parseInt(line.slice(0, 3), 10);
        if (isNaN(code)) continue;

        // Multi-line responses: "250-" is continuation, "250 " is final
        const isFinal = line.length === 3 || line[3] === ' ';
        if (!isFinal) continue;

        logger.trace({ host: mxHost, stage, code, line }, 'SMTP line received');

        switch (stage) {
          case 'banner':
            if (code === 220) {
              stage = 'ehlo';
              state.socket.write(`EHLO ${heloDomain}\r\n`);
            } else if (code === 421 || code === 450 || code === 451) {
              finish(false, true);  // Greylisted at banner
            } else {
              finish(false, false, `Unexpected banner code: ${code}`);
            }
            break;

          case 'ehlo':
            if (code === 250) {
              stage = 'mail_from';
              state.socket.write(`MAIL FROM:<probe@${heloDomain}>\r\n`);
            } else if (code >= 400 && code < 500) {
              finish(false, code === 421 || code === 450 || code === 451);
            } else {
              finish(false, false, `EHLO rejected with ${code}`);
            }
            break;

          case 'mail_from':
            if (code === 250) {
              stage = 'rcpt_to';
              state.socket.write(`RCPT TO:<${email}>\r\n`);
            } else if (code >= 400 && code < 500) {
              // Temporary rejection — treat as greylisting
              finish(false, true, `MAIL FROM temp rejection: ${code}`);
            } else {
              finish(false, false, `MAIL FROM permanent rejection: ${code}`);
            }
            break;

          case 'rcpt_to':
            if (code === 250 || code === 251) {
              // 251 = "User not local; will forward" — still accepted
              finish(true, false);
            } else if (code >= 500 && code < 600) {
              // 5xx = permanent rejection — address definitively does not exist
              finish(false, false);
            } else if (code === 421 || code === 450 || code === 451 || code === 452) {
              // Greylisting: "try again later" response
              finish(false, true, `RCPT greylisted: ${code}`);
            } else if (code >= 400 && code < 500) {
              // Other 4xx — ambiguous; treat as not-found to be conservative
              finish(false, false, `RCPT temporary rejection: ${code}`);
            } else {
              finish(false, false, `RCPT unexpected code: ${code}`);
            }
            stage = 'quit';
            break;

          case 'quit':
            // Nothing to act on; connection will close naturally
            break;
        }
      }
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notChecked(reason: string): SmtpProbeResult {
  logger.debug({ reason }, 'SMTP probe skipped');
  return { checked: false, reachable: null, isCatchAll: null, greylisted: false, rawResponse: null, error: reason };
}
