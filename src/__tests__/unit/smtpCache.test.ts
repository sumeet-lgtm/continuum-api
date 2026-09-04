import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    smtpCache: { upsert: vi.fn().mockResolvedValue({}), findUnique: vi.fn(), delete: vi.fn() },
  },
}));

import { setSmtpCache } from '../../engine/smtpCache.js';
import { prisma } from '../../lib/prisma.js';

const mockUpsert = vi.mocked(prisma.smtpCache.upsert);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setSmtpCache — never persists a false catch-all for a major webmail provider', () => {
  // storeCache is the single choke point every caller's verdict (own probe,
  // ZeroBounce, MillionVerifier) passes through — this is what actually
  // stops the shared cache from getting re-poisoned by a fresh probe, since
  // the in-memory response-level correction alone doesn't touch what gets
  // written to the DB.
  it('corrects isCatchAll to false when the source reported true for gmail.com', async () => {
    await setSmtpCache('someone@gmail.com', {
      checked: true, reachable: true, isCatchAll: true, greylisted: false, fromCache: false, rawResponse: null, error: null,
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isCatchAll: false }),
        update: expect.objectContaining({ isCatchAll: false }),
      }),
    );
  });

  it('leaves a genuine catch-all result untouched for a non-webmail domain', async () => {
    await setSmtpCache('someone@some-corp-domain.com', {
      checked: true, reachable: true, isCatchAll: true, greylisted: false, fromCache: false, rawResponse: null, error: null,
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isCatchAll: true }),
      }),
    );
  });

  it('does not touch isCatchAll:false for a webmail provider (nothing to correct)', async () => {
    await setSmtpCache('someone@yahoo.com', {
      checked: true, reachable: true, isCatchAll: false, greylisted: false, fromCache: false, rawResponse: null, error: null,
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isCatchAll: false }),
      }),
    );
  });
});
