import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { config, isProd } from '../../config.js';
import { sendEmail } from '../../lib/email.js';
import { logger } from '../../lib/logger.js';

// Cal.com sends a HMAC-SHA256 signature in the X-Cal-Signature-256 header.
// Set CALCOM_WEBHOOK_SECRET in Railway to the same secret you paste in Cal.com.
//
// Distinct from "signature didn't match" — an unset secret in production
// used to mean "skip verification entirely," accepting any unauthenticated
// POST. Mirrors the Dodo billing webhook's fail-closed behavior: unset in
// dev/staging is fine (nothing to compare against yet), unset in prod is a
// misconfiguration that must reject the request, not silently trust it.
type SignatureCheck = 'valid' | 'invalid' | 'not_configured_in_prod';

function verifyCalcomSignature(body: string, header: string | undefined): SignatureCheck {
  const secret = config.CALCOM_WEBHOOK_SECRET;
  if (!secret) return isProd ? 'not_configured_in_prod' : 'valid';
  if (!header) return 'invalid';
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(header, 'hex'), Buffer.from(expected, 'hex')) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

// Escapes a value before it's interpolated into the HTML email below — these
// fields (name, company, notes, ...) come straight from a public booking
// form's free-text inputs, so an attacker fully controls their content.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

export async function calcomWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Same reasoning as billing/workos webhooks: HMAC must be checked against
  // the exact raw bytes Cal.com signed, not a re-serialized JSON.stringify.
  // Scoped to this plugin only; the handler parses JSON manually as a result.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  fastify.post(
    '/webhooks/calcom',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = request.body as string;
      const sig = request.headers['x-cal-signature-256'] as string | undefined;

      const sigCheck = verifyCalcomSignature(rawBody, sig);
      if (sigCheck === 'not_configured_in_prod') {
        logger.error('Cal.com webhook rejected: CALCOM_WEBHOOK_SECRET not configured in production');
        return reply.status(500).send({ error: 'Webhook not configured' });
      }
      if (sigCheck === 'invalid') {
        fastify.log.warn('Cal.com webhook signature mismatch — ignoring');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }
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
  <tr><td style="color:#666;white-space:nowrap">Name</td><td><strong>${escapeHtml(name)}</strong></td></tr>
  <tr><td style="color:#666">Email</td><td><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
  ${company ? `<tr><td style="color:#666">Company</td><td>${escapeHtml(company)}</td></tr>` : ''}
  <tr><td style="color:#666">Event</td><td>${escapeHtml(eventTitle)}</td></tr>
  <tr><td style="color:#666">Time</td><td>${escapeHtml(startTime)}${endTime ? ` → ${escapeHtml(endTime)}` : ''}${timezone ? ` (${escapeHtml(timezone)})` : ''}</td></tr>
  ${meetingUrl ? `<tr><td style="color:#666">Join link</td><td><a href="${escapeHtml(meetingUrl)}">${escapeHtml(meetingUrl)}</a></td></tr>` : ''}
  ${notes ? `<tr><td style="color:#666;vertical-align:top">Notes</td><td style="white-space:pre-wrap">${escapeHtml(notes)}</td></tr>` : ''}
</table>
<p style="margin-top:16px;color:#888;font-size:12px;">
  Booking ID: ${escapeHtml(String(booking.uid ?? 'n/a'))} · via Cal.com webhook
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
