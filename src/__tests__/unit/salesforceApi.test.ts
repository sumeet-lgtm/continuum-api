import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findLeadByEmail, createLead, SalesforceApiError } from '../../lib/salesforceApi.js';

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('salesforceApi — error handling', () => {
  it('surfaces the first error message from a Salesforce error array, not a generic status text', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify([{ message: 'REQUIRED_FIELD_MISSING: [Company]', errorCode: 'REQUIRED_FIELD_MISSING' }]),
    }) as unknown as typeof fetch;

    await expect(createLead('https://test.my.salesforce.com', 'token', {
      Email: 'a@b.com', LastName: 'Doe', Company: 'Acme',
    })).rejects.toThrow(/REQUIRED_FIELD_MISSING/);
  });

  it('throws SalesforceApiError with the HTTP status attached', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]),
    }) as unknown as typeof fetch;

    try {
      await createLead('https://test.my.salesforce.com', 'token', { Email: 'a@b.com', LastName: 'Doe', Company: 'Acme' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SalesforceApiError);
      expect((err as SalesforceApiError).status).toBe(401);
    }
  });
});

describe('salesforceApi — findLeadByEmail', () => {
  it('returns null when no matching Lead exists', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ totalSize: 0, records: [] }),
    }) as unknown as typeof fetch;

    const result = await findLeadByEmail('https://test.my.salesforce.com', 'token', 'nobody@example.com');
    expect(result).toBeNull();
  });

  it('escapes a single quote in the email so a malformed SOQL query cannot be injected', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ totalSize: 0, records: [] }) });
    }) as unknown as typeof fetch;

    await findLeadByEmail('https://test.my.salesforce.com', 'token', "o'brien@example.com");
    expect(capturedUrl).toContain(encodeURIComponent("o\\'brien@example.com"));
  });

  it('maps a found Lead record into the expected shape', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        totalSize: 1,
        records: [{ Id: '00Qxx1', Status: 'Working', LastModifiedDate: '2026-01-01T00:00:00.000Z', IsConverted: false, ConvertedContactId: null }],
      }),
    }) as unknown as typeof fetch;

    const result = await findLeadByEmail('https://test.my.salesforce.com', 'token', 'lead@example.com');
    expect(result).toEqual({ id: '00Qxx1', status: 'Working', lastModified: '2026-01-01T00:00:00.000Z', converted: false, convertedContactId: null });
  });
});
