/**
 * Shared "try SES, fall back to SMTP2GO" send wrapper — used by every real
 * customer-facing send path (immediate /v1/send, the scheduled-send worker,
 * and campaign sends), so the fallback logic lives in exactly one place
 * instead of being duplicated three times.
 *
 * This is a blunt fallback, not per-domain routing: ANY SES failure
 * (unconfigured, or a real rejection like the sandbox's "identity not
 * verified" error) triggers an SMTP2GO attempt. SES stays the preferred
 * transport — this only kicks in on failure, so once AWS SES production
 * access clears, sends keep going out via SES exactly as before and
 * SMTP2GO simply stops being invoked.
 */

import { sendViaSes, isSesConfigured, SesNotConfiguredError, type SendViaSesInput } from './ses.js';
import { sendViaSmtp2go, isSmtp2goConfigured } from './smtp2go.js';
import { logger } from './logger.js';

export type SendTransportInput = SendViaSesInput;

export type SendTransportResult =
  | { ok: true; transport: 'ses'; sesMessageId: string; smtp2goMessageId: null }
  | { ok: true; transport: 'smtp2go'; sesMessageId: null; smtp2goMessageId: string }
  | { ok: false; errorMessage: string; isClientFault: boolean };

export function isSendTransportConfigured(): boolean {
  return isSesConfigured() || isSmtp2goConfigured();
}

export async function sendViaTransportWithFallback(
  input: SendTransportInput,
  logCtx: Record<string, unknown> = {},
): Promise<SendTransportResult> {
  let sesError: unknown = null;

  if (isSesConfigured()) {
    try {
      const result = await sendViaSes(input);
      return { ok: true, transport: 'ses', sesMessageId: result.sesMessageId, smtp2goMessageId: null };
    } catch (err) {
      sesError = err;
      logger.warn({ ...logCtx, err }, 'SES send failed — trying SMTP2GO fallback');
    }
  }

  if (isSmtp2goConfigured()) {
    try {
      const result = await sendViaSmtp2go(input);
      return { ok: true, transport: 'smtp2go', sesMessageId: null, smtp2goMessageId: result.smtp2goMessageId };
    } catch (err) {
      logger.error({ ...logCtx, err, sesError }, 'SMTP2GO fallback send also failed');
      return {
        ok: false,
        errorMessage: err instanceof Error ? err.message : 'Unknown SMTP2GO error',
        isClientFault: false,
      };
    }
  }

  // No SMTP2GO configured to fall back to — surface the original SES error
  // (or "not configured" if SES was never set up either).
  const errorMessage = sesError instanceof SesNotConfiguredError
    ? sesError.message
    : (sesError instanceof Error ? sesError.message : 'No send transport configured (set AWS_* or SMTP2GO_API_KEY)');
  const isClientFault = (sesError as { $fault?: string } | null)?.$fault === 'client';
  return { ok: false, errorMessage, isClientFault };
}
