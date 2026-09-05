/**
 * Shared domain-verification logic — used by both the manual
 * POST /v1/domains/:id/verify route and domainVerifyWorker.ts's periodic
 * background recheck.
 *
 * Why the background recheck exists: DKIM verification isn't something we
 * check via our own DNS lookup — it's Amazon SES independently polling for
 * the DKIM record on its own schedule, which can take anywhere from
 * minutes to hours even after the DNS record is already live and correct.
 * Before this worker existed, "verified" only ever happened if the
 * customer manually clicked Re-verify again later — the dashboard claimed
 * "verification happens automatically once DNS propagates" but nothing
 * backed that claim; a self-serve customer who added their DNS records and
 * walked away would have a domain stuck on "pending" forever with no
 * notification, no retry, nothing.
 */
import { SESv2Client, GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { prisma } from './prisma.js';
import { config } from '../config.js';
import { getDomainHealth } from './deliverability.js';
import { logAudit } from './audit.js';
import { dispatchWebhook, buildEventId } from './webhooks.js';
import { logger } from './logger.js';

let _sesClient: SESv2Client | null = null;
function getSesClient(region: string): SESv2Client {
  if (!_sesClient) {
    const clientConfig = config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
      ? {
          region: region ?? config.AWS_REGION ?? 'us-east-1',
          credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
        }
      : { region: region ?? config.AWS_REGION ?? 'us-east-1' };
    _sesClient = new SESv2Client(clientConfig);
  }
  return _sesClient;
}

export interface DomainToVerify {
  id: string;
  apiKeyId: string;
  name: string;
  region: string;
  dkimStatus: string;
  verifiedAt: Date | null;
}

export async function verifyDomain(domain: DomainToVerify) {
  const health = await getDomainHealth(domain.name, domain.dkimStatus === 'verified');

  let sesDkimVerified = domain.dkimStatus === 'verified';
  if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
    try {
      const ses = getSesClient(domain.region);
      const sesIdentity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain.name }));
      const dkimStatus = sesIdentity.DkimAttributes?.Status;
      if (dkimStatus === 'SUCCESS') sesDkimVerified = true;
    } catch (err) {
      // Was silently swallowed with no visibility at all — a domain whose
      // SES identity creation failed (or was never registered) looked
      // identical to one still waiting on normal DNS propagation, forever,
      // with nothing in our own logs pointing at the real cause either.
      logger.debug({ err, domainId: domain.id, domain: domain.name }, 'SES GetEmailIdentity failed — domain identity may not be registered yet');
    }
  }

  const allVerified = health.spf.valid && (health.dkim.valid || sesDkimVerified) && health.dmarc.valid;

  const updated = await prisma.sendingDomain.update({
    where: { id: domain.id },
    data: {
      spfStatus: health.spf.valid ? 'verified' : 'pending',
      dkimStatus: (health.dkim.valid || sesDkimVerified) ? 'verified' : 'pending',
      status: allVerified ? 'verified' : 'pending',
      ...(allVerified ? { verifiedAt: new Date() } : {}),
    },
    select: { id: true, name: true, status: true, spfStatus: true, dkimStatus: true, returnPathStatus: true, verifiedAt: true },
  });

  const justVerified = allVerified && !domain.verifiedAt;
  if (justVerified) {
    void logAudit(null, 'sending_domain.verified', { id: domain.apiKeyId, email: 'api', ip: undefined }, [{ type: 'domain', id: domain.id, name: domain.name }], domain.apiKeyId);
    void dispatchWebhook({
      apiKeyId: domain.apiKeyId,
      event: 'domain.verified',
      eventId: buildEventId('domain.verified', domain.id),
      payload: { event: 'domain.verified', domain_id: domain.id, domain: domain.name, apiVersion: '2' },
    }).catch((err) => logger.warn({ err, domainId: domain.id }, 'Failed to dispatch domain.verified webhook (non-fatal)'));
  }

  return { updated, health, justVerified };
}
