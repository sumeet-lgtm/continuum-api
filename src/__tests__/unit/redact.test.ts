import { describe, it, expect } from 'vitest';
import { redactUrl } from '../../lib/redact.js';

describe('redactUrl', () => {
  it('leaves a URL with no query string unchanged', () => {
    expect(redactUrl('/v1/verify')).toBe('/v1/verify');
  });

  it('leaves non-sensitive query params unchanged', () => {
    expect(redactUrl('/v1/history?page=2&limit=50')).toBe('/v1/history?page=2&limit=50');
  });

  it('redacts a token= param used by /unsubscribe and /confirm', () => {
    expect(redactUrl('/v1/unsubscribe?token=abc123.signature')).toBe('/v1/unsubscribe?token=[REDACTED]');
  });

  it('redacts a t= param used by /track/open and /track/click', () => {
    expect(redactUrl('/track/open?t=eyJhbGciOi.sig')).toBe('/track/open?t=[REDACTED]');
  });

  it('redacts only the sensitive param, preserving the rest of the query string and order', () => {
    expect(redactUrl('/track/click?u=https://example.com&t=secrettoken&campaign=q4'))
      .toBe('/track/click?u=https://example.com&t=[REDACTED]&campaign=q4');
  });

  it('is case-insensitive on the param name', () => {
    expect(redactUrl('/v1/unsubscribe?TOKEN=abc123')).toBe('/v1/unsubscribe?TOKEN=[REDACTED]');
  });

  it('does not redact a param whose name merely contains "token" as a substring', () => {
    expect(redactUrl('/v1/webhooks?webhook_token_id=abc')).toBe('/v1/webhooks?webhook_token_id=abc');
  });

  it('leaves a bare flag param (no value) unchanged even if named token', () => {
    expect(redactUrl('/v1/unsubscribe?token')).toBe('/v1/unsubscribe?token');
  });
});
