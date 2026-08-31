import { describe, it, expect, beforeEach, vi } from 'vitest';

// sendViaSes builds a raw MIME message via string interpolation whenever a
// send has attachments or custom headers — this suite pins down that no
// caller-supplied field can inject an extra header or break out of a MIME
// attribute via an embedded CRLF or quote.

const sendMock = vi.fn().mockResolvedValue({ MessageId: 'ses-test-message-id' });

vi.mock('@aws-sdk/client-sesv2', () => {
  class FakeSESv2Client {
    send = sendMock;
  }
  class FakeSendEmailCommand {
    constructor(public input: unknown) {}
  }
  return { SESv2Client: FakeSESv2Client, SendEmailCommand: FakeSendEmailCommand };
});

async function freshSendViaSes() {
  vi.resetModules();
  process.env['AWS_REGION'] = 'us-east-1';
  process.env['AWS_ACCESS_KEY_ID'] = 'test-access-key';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'test-secret-key';
  const mod = await import('../../lib/ses.js');
  return mod.sendViaSes;
}

function rawMessageFromLastCall(): string {
  const command = sendMock.mock.calls.at(-1)?.[0] as { input: { Content: { Raw: { Data: Buffer } } } };
  return Buffer.from(command.input.Content.Raw.Data).toString('utf-8');
}

beforeEach(() => {
  sendMock.mockClear();
});

describe('sendViaSes header injection resistance (raw MIME path)', () => {
  it('strips an embedded CRLF from the subject instead of letting it start a new header', async () => {
    const sendViaSes = await freshSendViaSes();
    await sendViaSes({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Hello\r\nBcc: attacker@evil.com',
      textBody: 'body',
      headers: { 'X-Test': 'yes' }, // force the raw-message path
    });
    const raw = rawMessageFromLastCall();
    expect(raw).not.toMatch(/\r\nBcc:/i);
    expect(raw).toContain('Subject: Hello Bcc: attacker@evil.com');
  });

  it('strips an embedded CRLF from a custom header value', async () => {
    const sendViaSes = await freshSendViaSes();
    await sendViaSes({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Hello',
      textBody: 'body',
      headers: { 'X-Custom': 'value\r\nBcc: attacker@evil.com' },
    });
    const raw = rawMessageFromLastCall();
    expect(raw).not.toMatch(/\r\nBcc:/i);
  });

  it('rejects a custom header name that is not a plain token', async () => {
    const sendViaSes = await freshSendViaSes();
    await expect(
      sendViaSes({
        to: 'recipient@example.com',
        from: 'sender@example.com',
        subject: 'Hello',
        textBody: 'body',
        headers: { 'X-Evil\r\nBcc': 'attacker@evil.com' },
      }),
    ).rejects.toThrow(/Invalid header name/);
  });

  it('strips CRLF and quotes from attachment filename/content-type', async () => {
    const sendViaSes = await freshSendViaSes();
    await sendViaSes({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Hello',
      textBody: 'body',
      attachments: [{
        filename: 'evil".pdf\r\nContent-Type: text/html',
        content: Buffer.from('data').toString('base64'),
        content_type: 'application/pdf"\r\nX-Injected: yes',
      }],
    });
    const raw = rawMessageFromLastCall();
    expect(raw).not.toMatch(/\r\nContent-Type: text\/html/);
    expect(raw).not.toMatch(/\r\nX-Injected:/);
    expect(raw).not.toContain('"pdf');
  });

  it('still sends a normal message unmodified through the raw MIME path', async () => {
    const sendViaSes = await freshSendViaSes();
    const result = await sendViaSes({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Welcome to Continuum',
      textBody: 'Hi there',
      headers: { 'X-Campaign-Id': 'abc123' },
    });
    expect(result.sesMessageId).toBe('ses-test-message-id');
    const raw = rawMessageFromLastCall();
    expect(raw).toContain('Subject: Welcome to Continuum');
    expect(raw).toContain('X-Campaign-Id: abc123');
  });
});
