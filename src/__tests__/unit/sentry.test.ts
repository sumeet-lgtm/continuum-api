import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sentryInitMock, captureExceptionMock, flushMock } = vi.hoisted(() => ({
  sentryInitMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  flushMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('@sentry/node', () => ({
  init: sentryInitMock,
  captureException: captureExceptionMock,
  flush: flushMock,
}));

async function freshSentryModule(dsn: string | undefined) {
  vi.resetModules();
  if (dsn) process.env['SENTRY_DSN'] = dsn;
  else delete process.env['SENTRY_DSN'];
  return import('../../lib/sentry.js');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sentry helper — off by default', () => {
  it('never calls Sentry.init when SENTRY_DSN is unset', async () => {
    const { initSentry } = await freshSentryModule(undefined);
    initSentry('api');
    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it('captureException is a no-op without SENTRY_DSN, even after initSentry() is called', async () => {
    const { initSentry, captureException } = await freshSentryModule(undefined);
    initSentry('api');
    captureException(new Error('boom'));
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('flushSentry resolves without calling Sentry.flush when unconfigured', async () => {
    const { initSentry, flushSentry } = await freshSentryModule(undefined);
    initSentry('api');
    await flushSentry();
    expect(flushMock).not.toHaveBeenCalled();
  });
});

describe('sentry helper — configured with a DSN', () => {
  it('initializes Sentry with the DSN and service name', async () => {
    const { initSentry } = await freshSentryModule('https://key@sentry.example.com/1');
    initSentry('worker-send');
    expect(sentryInitMock).toHaveBeenCalledWith(expect.objectContaining({
      dsn: 'https://key@sentry.example.com/1',
      serverName: 'worker-send',
    }));
  });

  it('forwards captureException to Sentry once initialized', async () => {
    const { initSentry, captureException } = await freshSentryModule('https://key@sentry.example.com/1');
    initSentry('api');
    const err = new Error('boom');
    captureException(err, { requestId: 'req-1' });
    expect(captureExceptionMock).toHaveBeenCalledWith(err, { extra: { requestId: 'req-1' } });
  });

  it('captureException before initSentry() is still a no-op (init order matters)', async () => {
    const { captureException } = await freshSentryModule('https://key@sentry.example.com/1');
    captureException(new Error('too early'));
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captureIfServerError only reports 5xx, not 4xx', async () => {
    const { initSentry, captureIfServerError } = await freshSentryModule('https://key@sentry.example.com/1');
    initSentry('api');

    captureIfServerError(404, new Error('not found'));
    expect(captureExceptionMock).not.toHaveBeenCalled();

    captureIfServerError(500, new Error('server error'));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('flushSentry calls Sentry.flush once configured', async () => {
    const { initSentry, flushSentry } = await freshSentryModule('https://key@sentry.example.com/1');
    initSentry('api');
    await flushSentry(1234);
    expect(flushMock).toHaveBeenCalledWith(1234);
  });
});
