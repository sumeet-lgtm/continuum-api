/**
 * Mailboxes store one host/port pair, entered once by the user for SMTP
 * (the dashboard form's own placeholder is "smtp.gmail.com") — but IMAP
 * almost always lives on a different hostname and always on a different
 * port. Reusing the SMTP host/port for IMAP connects silently fails for
 * exactly the setup the UI guides people toward (Gmail: smtp.gmail.com:587
 * vs imap.gmail.com:993), which breaks reply detection and warmup
 * auto-open/reply without ever surfacing an error to the user — the IMAP
 * connect just times out and gets swallowed by a catch block.
 *
 * This derives a best-guess IMAP host from the stored SMTP host rather than
 * requiring a schema change and a second form field: the "smtp." → "imap."
 * swap covers Gmail and most conventional split-subdomain providers, and
 * falls through unchanged for the single-host providers (Zoho, cPanel-style
 * hosting) where SMTP and IMAP already share one hostname.
 */
export function deriveImapHost(smtpHost: string): string {
  if (smtpHost.toLowerCase().startsWith('smtp.')) {
    return 'imap.' + smtpHost.slice(5);
  }
  return smtpHost;
}

// IMAPS (implicit TLS) — practically universal regardless of whatever SMTP
// port (587 STARTTLS, 465 implicit) the user entered for sending.
export const IMAP_PORT = 993;

/**
 * Auth-only IMAP reachability check — connects and logs in, doesn't touch
 * any mailbox contents. Mirrors testSmtpConnection's shape so the mailbox
 * "Test connection" button can report both halves: a mailbox that sends
 * fine but has the wrong IMAP host still can't support reply detection or
 * warmup auto-open, and that was previously invisible until it silently
 * failed in production days later.
 */
export async function testImapConnection(creds: {
  host: string; username: string; passwordEnc: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { decryptValue } = await import('./crypto.js');
    const { config } = await import('../config.js');
    const secret = (config as Record<string, unknown>)['MAILBOX_CREDS_SECRET'] as string ?? config.API_KEY_SALT;
    const password = decryptValue(creds.passwordEnc, secret);

    const imap = await import('imap-simple');
    const connection = await imap.connect({
      imap: {
        user: creds.username,
        password,
        host: deriveImapHost(creds.host),
        port: IMAP_PORT,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    });
    connection.end();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'IMAP connection failed' };
  }
}
