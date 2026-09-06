import { startCampaignWorker } from './workers/campaignWorker.js';
import { startSequenceWorker, scheduleSequenceTicks } from './workers/sequenceWorker.js';
import { startWarmupWorker, scheduleWarmupTicks } from './workers/warmupWorker.js';
import { startImapWorker, scheduleImapTicks } from './workers/imapWorker.js';
import { runAutomationWorker } from './workers/automationWorker.js';
import { startSalesforceSyncWorker, scheduleSalesforceSyncTicks } from './workers/salesforceSyncWorker.js';
import { startDomainVerifyWorker, scheduleDomainVerifyTicks } from './workers/domainVerifyWorker.js';
import { sequenceQueue, warmupQueue, imapQueue, salesforceSyncQueue, domainVerifyQueue } from './lib/queue.js';
import { isSalesforceOAuthConfigured } from './lib/oauth/salesforce.js';
import * as tls from 'node:tls';

// TEMPORARY diagnostic, remove after reading the result once (user-approved
// 2026-09-06): imapWorker's real IMAP connections fail with
// DEPTH_ZERO_SELF_SIGNED_CERT and checkServerIdentity never even fires,
// meaning Node's TLS engine rejects the chain before that hook runs -- so
// there's no way to see which cert was actually offered from inside the
// real auth path. This is a bare TLS handshake to a public IMAP endpoint
// with no mailbox credentials involved at all (never authenticates, just
// connects and logs what cert comes back), specifically so it's safe to
// run with validation off for this one isolated diagnostic connection
// without touching the real credentialed IMAP path's security at all.
(function diagnoseImapTls() {
  const socket = tls.connect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com', rejectUnauthorized: false }, () => {
    const cert = socket.getPeerCertificate();
    console.log('[imap-tls-diag]', JSON.stringify({
      authorized: socket.authorized,
      authorizationError: socket.authorizationError,
      subject: cert?.subject,
      issuer: cert?.issuer,
      valid_from: cert?.valid_from,
      valid_to: cert?.valid_to,
      fingerprint: cert?.fingerprint,
    }));
    socket.end();
  });
  socket.on('error', (e) => console.log('[imap-tls-diag] error', e.message));
  socket.setTimeout(10000, () => { console.log('[imap-tls-diag] timeout'); socket.destroy(); });
})();

const closable: Array<{ close(): Promise<void> }> = [];

closable.push(startCampaignWorker());
closable.push(startSequenceWorker());

// Schedule recurring sequence ticks (every 5 minutes) — idempotent, safe to call on every restart
void scheduleSequenceTicks(sequenceQueue).catch((err: unknown) => {
  console.error('[worker-new] failed to schedule sequence ticks:', err);
});

// Unconditional (not feature-flagged like warmup/IMAP below) — every
// customer with a sending domain needs this recheck, not just an opt-in
// subset. Without a real background recheck, a pending domain only ever
// moves to verified if the customer manually clicks Re-verify again later
// — DKIM verification is Amazon SES polling on its own schedule, which can
// take minutes to hours after the DNS record is already live and correct.
closable.push(startDomainVerifyWorker());
void scheduleDomainVerifyTicks(domainVerifyQueue).catch((err: unknown) => {
  console.error('[worker-new] failed to schedule domain verify ticks:', err);
});

if (process.env['WARMUP_POOL_ENABLED'] === 'true') {
  closable.push(startWarmupWorker());

  // Schedule recurring warmup ticks (hourly) — without this the warmup
  // worker above starts and listens forever, but nothing ever enqueues a
  // job for it to process, so warmup silently never actually runs.
  // Idempotent (fixed jobId), safe to call on every restart.
  void scheduleWarmupTicks(warmupQueue).catch((err: unknown) => {
    console.error('[worker-new] failed to schedule warmup ticks:', err);
  });
}

if (process.env['IMAP_POLL_ENABLED'] === 'true') {
  closable.push(startImapWorker());

  // Same gap as warmup above: the worker starts and listens, but without
  // this nothing ever enqueues a poll job — reply detection, bounce, and
  // unsubscribe-via-IMAP silently never ran.
  void scheduleImapTicks(imapQueue).catch((err: unknown) => {
    console.error('[worker-new] failed to schedule IMAP ticks:', err);
  });
}

if (isSalesforceOAuthConfigured()) {
  closable.push(startSalesforceSyncWorker());
  void scheduleSalesforceSyncTicks(salesforceSyncQueue).catch((err: unknown) => {
    console.error('[worker-new] failed to schedule Salesforce sync ticks:', err);
  });
}

// Automation worker runs every 5 minutes via setInterval
const automationInterval = setInterval(() => {
  runAutomationWorker().catch((err: unknown) => {
    console.error('[automation-worker] error:', err);
  });
}, 5 * 60 * 1000);
// Run once immediately on startup
void runAutomationWorker().catch((err: unknown) => {
  console.error('[automation-worker] startup error:', err);
});

closable.push({ close: async () => { clearInterval(automationInterval); } });

console.log(`[worker-new] campaign + sequence + domain-verify + automation workers started (warmup:${process.env['WARMUP_POOL_ENABLED'] === 'true'} imap:${process.env['IMAP_POLL_ENABLED'] === 'true'} salesforce:${isSalesforceOAuthConfigured()})`);

const shutdown = async () => {
  console.log('[worker-new] shutting down...');
  // allSettled, not all — one worker's close() rejecting must not stop the
  // rest from closing, and must not turn a clean shutdown into a crash.
  await Promise.allSettled(closable.map(w => w.close()));
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (reason) => {
  // Log but do not exit — an unhandled rejection in a job processor must not
  // take down the entire worker process. BullMQ marks the job as failed and
  // retries it; we keep the worker alive for the next one.
  console.error('[worker-new] unhandled rejection (worker kept alive):', reason);
});

process.on('uncaughtException', (err) => {
  // Uncaught exceptions (syntax errors, startup failures) ARE fatal.
  console.error('[worker-new] uncaught exception — exiting:', err);
  process.exit(1);
});
