import { describe, it, expect, vi, beforeEach } from 'vitest';

// logAudit previously no-op'd entirely whenever orgId was null or
// WORKOS_API_KEY was unset — meaning any customer not on the org/SSO flow
// (the majority) got zero audit trail. This pins down that a local row is
// now written unconditionally, and that the WorkOS mirror stays additive
// and best-effort on top of it.

const { auditLogCreateMock, workosCreateEventMock } = vi.hoisted(() => ({
  auditLogCreateMock: vi.fn().mockResolvedValue({ id: 'log-1' }),
  workosCreateEventMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { auditLog: { create: auditLogCreateMock } },
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn().mockImplementation(function FakeWorkOS(this: { auditLogs: unknown }) {
    this.auditLogs = { createEvent: workosCreateEventMock };
  }),
}));

async function freshLogAudit(env: { WORKOS_API_KEY?: string }) {
  vi.resetModules();
  if (env.WORKOS_API_KEY) process.env['WORKOS_API_KEY'] = env.WORKOS_API_KEY;
  else delete process.env['WORKOS_API_KEY'];
  const mod = await import('../../lib/audit.js');
  return mod.logAudit;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logAudit', () => {
  it('writes a local record even with no orgId and no WorkOS configured (previously a total no-op)', async () => {
    const logAudit = await freshLogAudit({});
    await logAudit(null, 'api_key.created', { id: 'key-1', email: 'k1', ip: '1.2.3.4' }, [{ type: 'api_key', id: 'key-1' }], 'key-1');

    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: {
        orgId: null, apiKeyId: 'key-1', action: 'api_key.created',
        actorId: 'key-1', actorEmail: 'k1', actorIp: '1.2.3.4',
        targets: [{ type: 'api_key', id: 'key-1' }],
      },
    });
    expect(workosCreateEventMock).not.toHaveBeenCalled();
  });

  it('writes a local record for an org-scoped action too', async () => {
    const logAudit = await freshLogAudit({ WORKOS_API_KEY: 'sk_test_123' });
    await logAudit('org-1', 'member.invited', { id: 'user-1', email: 'a@example.com' }, [{ type: 'user', id: 'b@example.com' }]);

    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ orgId: 'org-1', apiKeyId: null, action: 'member.invited' }),
    }));
  });

  it('additionally mirrors to WorkOS only when both orgId and WORKOS_API_KEY are present', async () => {
    const logAudit = await freshLogAudit({ WORKOS_API_KEY: 'sk_test_123' });
    await logAudit('org-1', 'member.invited', { id: 'user-1', email: 'a@example.com' }, [{ type: 'user', id: 'b@example.com' }]);

    expect(workosCreateEventMock).toHaveBeenCalledTimes(1);
  });

  it('does not mirror to WorkOS when orgId is set but WORKOS_API_KEY is not', async () => {
    const logAudit = await freshLogAudit({});
    await logAudit('org-1', 'member.invited', { id: 'user-1', email: 'a@example.com' }, [{ type: 'user', id: 'b@example.com' }]);

    expect(auditLogCreateMock).toHaveBeenCalled();
    expect(workosCreateEventMock).not.toHaveBeenCalled();
  });

  it('never throws when the local write itself fails (fire-and-forget)', async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error('db down'));
    const logAudit = await freshLogAudit({});

    await expect(logAudit(null, 'account.deleted', { id: 'key-1', email: 'k1' }, [])).resolves.toBeUndefined();
  });
});
