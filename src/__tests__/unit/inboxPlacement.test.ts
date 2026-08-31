import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// checkInboxPlacement previously didn't exist — the route hardcoded
// results['gmail'] = 'inbox' whenever a seed account was configured, with
// zero actual verification. This pins down the real IMAP-backed behavior:
// no seed creds -> 'unavailable', found in INBOX -> 'inbox', found only in
// the spam folder -> 'spam', found nowhere -> 'not_found', connect/search
// failure -> 'error' (never fabricated as a placement).

const { connectMock, openBoxMock, searchMock, endMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  openBoxMock: vi.fn(),
  searchMock: vi.fn(),
  endMock: vi.fn(),
}));

vi.mock('imap-simple', () => ({
  default: undefined,
  connect: connectMock,
}));

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  vi.clearAllMocks();
  connectMock.mockResolvedValue({ openBox: openBoxMock, search: searchMock, end: endMock });
});

afterEach(() => {
  process.env = originalEnv;
});

async function freshCheckInboxPlacement() {
  vi.resetModules();
  const mod = await import('../../lib/inboxPlacement.js');
  return mod.checkInboxPlacement;
}

describe('checkInboxPlacement', () => {
  it('reports a provider as unavailable when no seed credentials are configured', async () => {
    delete process.env['SEED_GMAIL_USER'];
    delete process.env['SEED_GMAIL_PASSWORD'];
    delete process.env['SEED_OUTLOOK_USER'];
    delete process.env['SEED_OUTLOOK_PASSWORD'];

    const checkInboxPlacement = await freshCheckInboxPlacement();
    const results = await checkInboxPlacement('test-marker-1');

    expect(results['gmail']).toBe('unavailable');
    expect(results['outlook']).toBe('unavailable');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('reports inbox when the probe is found in INBOX', async () => {
    process.env['SEED_GMAIL_USER'] = 'seed@gmail.com';
    process.env['SEED_GMAIL_PASSWORD'] = 'app-password';
    delete process.env['SEED_OUTLOOK_USER'];
    delete process.env['SEED_OUTLOOK_PASSWORD'];

    searchMock.mockResolvedValueOnce([{ id: 1 }]); // found in INBOX

    const checkInboxPlacement = await freshCheckInboxPlacement();
    const results = await checkInboxPlacement('test-marker-2');

    expect(results['gmail']).toBe('inbox');
    expect(openBoxMock).toHaveBeenCalledWith('INBOX');
    expect(endMock).toHaveBeenCalled();
  });

  it('reports spam when not in INBOX but found in the spam folder', async () => {
    process.env['SEED_GMAIL_USER'] = 'seed@gmail.com';
    process.env['SEED_GMAIL_PASSWORD'] = 'app-password';
    delete process.env['SEED_OUTLOOK_USER'];
    delete process.env['SEED_OUTLOOK_PASSWORD'];

    searchMock
      .mockResolvedValueOnce([]) // not in INBOX
      .mockResolvedValueOnce([{ id: 1 }]); // found in [Gmail]/Spam

    const checkInboxPlacement = await freshCheckInboxPlacement();
    const results = await checkInboxPlacement('test-marker-3');

    expect(results['gmail']).toBe('spam');
    expect(openBoxMock).toHaveBeenNthCalledWith(2, '[Gmail]/Spam');
  });

  it('reports not_found when the probe is in neither folder', async () => {
    process.env['SEED_GMAIL_USER'] = 'seed@gmail.com';
    process.env['SEED_GMAIL_PASSWORD'] = 'app-password';
    delete process.env['SEED_OUTLOOK_USER'];
    delete process.env['SEED_OUTLOOK_PASSWORD'];

    searchMock.mockResolvedValue([]);

    const checkInboxPlacement = await freshCheckInboxPlacement();
    const results = await checkInboxPlacement('test-marker-4');

    expect(results['gmail']).toBe('not_found');
  });

  it('reports error rather than fabricating a placement when IMAP connect fails', async () => {
    process.env['SEED_GMAIL_USER'] = 'seed@gmail.com';
    process.env['SEED_GMAIL_PASSWORD'] = 'wrong-password';
    delete process.env['SEED_OUTLOOK_USER'];
    delete process.env['SEED_OUTLOOK_PASSWORD'];

    connectMock.mockRejectedValueOnce(new Error('Authentication failed'));

    const checkInboxPlacement = await freshCheckInboxPlacement();
    const results = await checkInboxPlacement('test-marker-5');

    expect(results['gmail']).toBe('error');
  });

  it('searches by the unique X-Continuum-Test-Id header, not by timing or subject', async () => {
    process.env['SEED_GMAIL_USER'] = 'seed@gmail.com';
    process.env['SEED_GMAIL_PASSWORD'] = 'app-password';
    delete process.env['SEED_OUTLOOK_USER'];
    delete process.env['SEED_OUTLOOK_PASSWORD'];

    searchMock.mockResolvedValue([{ id: 1 }]);

    const checkInboxPlacement = await freshCheckInboxPlacement();
    await checkInboxPlacement('unique-marker-xyz');

    expect(searchMock).toHaveBeenCalledWith(
      [['HEADER', 'X-Continuum-Test-Id', 'unique-marker-xyz']],
      expect.objectContaining({ markSeen: false }),
    );
  });
});
