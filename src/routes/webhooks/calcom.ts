import { type FastifyInstance, type FastifyRequest, type FastifyReply, type FastifyContextConfig } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../../config.js';
import { sendEmail } from '../../lib/email.js';

// Cal.com sends a HMAC-SHA256 signature in the X-Cal-Signature-256 header.
// Set CALCOM_WEBHOOK_SECRET in Railway to the same secret you paste in Cal.com.
function verifyCalcomSignature(body: string, header: string | undefined): boolean {
  const secret = config.CALCOM_WEBHOOK_SECRET;
  if (!secret) return true; // secret not configured — skip verification (dev/staging)
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(header, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function fmt(dt: string | undefined): string {
  if (!dt) return 'TBD';
  try {
    return new Date(dt).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return dt;
  }
}

const routeConfig: { config: FastifyContextConfig } = { config: { rawBody: true } };

export async function calcomWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/webhooks/calcom',
    routeConfig,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
      const sig = request.headers['x-cal-signature-256'] as string | undefined;

      if (!verifyCalcomSignature(rawBody, sig)) {
        fastify.log.warn('Cal.com webhook signature mismatch — ignoring');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      const payload = request.body as Record<string, unknown>;
      const triggerEvent = (payload.triggerEvent as string) ?? '';

      // Only act on new bookings and cancellations
      if (!['BOOKING_CREATED', 'BOOKING_CANCELLED'].includes(triggerEvent)) {
        return reply.status(200).send({ ok: true, action: 'ignored' });
      }

      const booking = (payload.payload as Record<string, unknown>) ?? {};
      const attendees = (booking.attendees as Array<{ name?: string; email?: string; timeZone?: string }>) ?? [];
      const attendee = attendees[0] ?? {};
      const responses = (booking.responses as Record<string, { value?: string }>) ?? {};

      const name = attendee.name ?? 'Unknown';
      const email = attendee.email ?? 'unknown';
      const timezone = attendee.timeZone ?? '';
      const startTime = fmt(booking.startTime as string);
      const endTime = fmt(booking.endTime as string);
      const eventTitle = (booking.title as string) ?? 'Enterprise Consultation';
      const meetingUrl = (booking.videoCallData as { url?: string })?.url
        ?? (booking.location as string)
        ?? '';

      // Extra form fields the attendee may have filled in
      const company = responses.company?.value ?? responses.organization?.value ?? '';
      const notes = responses.notes?.value ?? responses.message?.value ?? '';

      const html = `
<h2>New Enterprise Call Booked 🎉</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="color:#666;white-space:nowrap">Name</td><td><strong>${name}</strong></td></tr>
  <tr><td style="color:#666">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>
  ${company ? `<tr><td style="color:#666">Company</td><td>${company}</td></tr>` : ''}
  <tr><td style="color:#666">Event</td><td>${eventTitle}</td></tr>
  <tr><td style="color:#666">Time</td><td>${startTime}${endTime ? ` → ${endTime}` : ''}${timezone ? ` (${timezone})` : ''}</td></tr>
  ${meetingUrl ? `<tr><td style="color:#666">Join link</td><td><a href="${meetingUrl}">${meetingUrl}</a></td></tr>` : ''}
  ${notes ? `<tr><td style="color:#666;vertical-align:top">Notes</td><td style="white-space:pre-wrap">${notes}</td></tr>` : ''}
</table>
<p style="margin-top:16px;color:#888;font-size:12px;">
  Booking ID: ${booking.uid ?? 'n/a'} · via Cal.com webhook
</p>`.trim();

      const isCancellation = triggerEvent === 'BOOKING_CANCELLED';
      const subject = isCancellation
        ? `❌ Enterprise call cancelled — ${name}`
        : `📅 Enterprise call booked — ${name} (${startTime})`;

      try {
        await sendEmail('sumeet@continuumapi.com', subject, html);
        fastify.log.info({ name, email, startTime, triggerEvent }, 'Cal.com booking alert sent');
      } catch (err) {
        fastify.log.error({ err }, 'Failed to send Cal.com booking alert');
        // Still return 200 so Cal.com doesn't retry
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
