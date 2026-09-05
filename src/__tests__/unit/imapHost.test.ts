import { describe, it, expect } from 'vitest';
import { deriveImapHost, IMAP_PORT } from '../../lib/imapHost.js';

describe('deriveImapHost', () => {
  it('swaps a leading smtp. for imap. — the Gmail case the dashboard placeholder points at', () => {
    expect(deriveImapHost('smtp.gmail.com')).toBe('imap.gmail.com');
  });

  it('is case-insensitive on the smtp. prefix', () => {
    expect(deriveImapHost('SMTP.gmail.com')).toBe('imap.gmail.com');
  });

  it('leaves a single shared host unchanged (Zoho/cPanel-style providers)', () => {
    expect(deriveImapHost('mail.mydomain.com')).toBe('mail.mydomain.com');
  });

  it('leaves a host with no smtp. prefix unchanged even if it contains "smtp" elsewhere', () => {
    expect(deriveImapHost('outbound-smtp.example.com')).toBe('outbound-smtp.example.com');
  });
});

describe('IMAP_PORT', () => {
  it('is the standard implicit-TLS IMAPS port, independent of whatever SMTP port was stored', () => {
    expect(IMAP_PORT).toBe(993);
  });
});
