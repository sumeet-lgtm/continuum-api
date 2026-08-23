import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifySnsMessage, type SnsMessage } from '../../lib/snsVerify.js';

const base: SnsMessage = {
  Type: 'Notification',
  MessageId: 'msg-1',
  TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
  Message: '{}',
  Timestamp: '2026-08-23T00:00:00.000Z',
  SignatureVersion: '1',
  Signature: 'irrelevant-for-these-cases',
  SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('verifySnsMessage', () => {
  it('rejects a SigningCertURL that is not an amazonaws.com SNS cert (SSRF guard)', async () => {
    const ok = await verifySnsMessage({ ...base, SigningCertURL: 'https://evil.example.com/fake.pem' });
    expect(ok).toBe(false);
  });

  it('rejects an http (non-https) cert URL', async () => {
    const ok = await verifySnsMessage({ ...base, SigningCertURL: 'http://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem' });
    expect(ok).toBe(false);
  });

  it('rejects an unsupported SignatureVersion', async () => {
    const ok = await verifySnsMessage({ ...base, SignatureVersion: '3' });
    expect(ok).toBe(false);
  });

  it('never throws, even if cert fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(verifySnsMessage(base)).resolves.toBe(false);
  });
});
