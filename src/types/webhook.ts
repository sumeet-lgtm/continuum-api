/**
 * Webhook types for Phase 5.
 *
 * Event name convention: Phase 5 introduces dot-namespaced names.
 * The legacy underscore names from Phase 1-4 are kept as aliases
 * so existing integrations are not broken.
 */

// ─── Event enum ───────────────────────────────────────────────────────────────

// Phase 5 canonical names
export type WebhookEventV2 =
  | 'verification.completed'
  | 'email.status_changed'
  | 'bulk_job.completed'
  // Phase 6 (Send)
  | 'email.sent'
  | 'email.delivered'
  | 'email.bounced'
  | 'email.complained'
  | 'email.send_failed'
  // Campaign events
  | 'campaign.sent'
  | 'campaign.failed'
  | 'campaign.paused_bounce';

// Legacy aliases (Phase 1-4 code paths still emit these)
export type WebhookEventLegacy =
  | 'verification_complete'
  | 'bulk_job_complete'
  | 'monitor_status_change';

// Union used everywhere internally
export type WebhookEvent = WebhookEventV2 | WebhookEventLegacy;

// All valid event strings for validation
export const ALL_WEBHOOK_EVENTS: WebhookEvent[] = [
  'verification.completed',
  'email.status_changed',
  'bulk_job.completed',
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.send_failed',
  'campaign.sent',
  'campaign.failed',
  'campaign.paused_bounce',
  // Legacy aliases
  'verification_complete',
  'bulk_job_complete',
  'monitor_status_change',
];

// ─── Queue payload (what the worker receives) ────────────────────────────────

export interface WebhookDeliveryPayload {
  deliveryId:    string;
  webhookId:     string;
  webhookUrl:    string;
  webhookSecret: string;
  event:         WebhookEvent;
  eventId:       string;         // idempotency key "<event>:<sourceId>"
  payload:       WebhookEventPayload;
  attemptNumber: number;
}

// ─── Event payload shapes ─────────────────────────────────────────────────────

export type WebhookEventPayload =
  | VerificationCompletedPayload
  | EmailStatusChangedPayload
  | BulkJobCompletedPayload
  | EmailSentPayload
  | EmailDeliveredPayload
  | EmailBouncedPayload
  | EmailComplainedPayload
  | EmailSendFailedPayload
  | CampaignSentPayload
  | CampaignFailedPayload
  | CampaignPausedBouncePayload
  // Legacy aliases
  | VerificationCompletePayload
  | BulkJobCompletePayload
  | MonitorStatusChangePayload;

/** verification.completed */
export interface VerificationCompletedPayload {
  event:     'verification.completed';
  id:        string;
  email:     string;
  domain:    string;
  status:    string;
  subStatus: string | null;
  score:     number;
  checks: {
    syntaxValid:   boolean;
    mxFound:       boolean;
    isDisposable:  boolean;
    isRoleAccount: boolean;
    smtpChecked:   boolean;
    smtpReachable: boolean | null;
    isCatchAll:    boolean | null;
    greylisted:    boolean;
  };
  apiKeyId:   string;
  checkedAt:  string;
  apiVersion: '2';
}

/** email.status_changed (monitor status change) */
export interface EmailStatusChangedPayload {
  event:          'email.status_changed';
  monitorId:      string;
  email:          string;
  previousStatus: string | null;
  newStatus:      string;
  source:         string;  // "scheduled" | "manual_recheck"
  checkedAt:      string;
  apiVersion:     '2';
}

/** bulk_job.completed */
export interface BulkJobCompletedPayload {
  event:        'bulk_job.completed';
  jobId:        string;
  fileName:     string;
  totalEmails:  number;
  validCount:   number;
  invalidCount: number;
  riskyCount:   number;
  unknownCount: number;
  duplicateCount: number;
  errorCount:   number;
  completedAt:  string;
  apiVersion:   '2';
}

/** email.sent */
export interface EmailSentPayload {
  event:        'email.sent';
  id:           string; // SendMessage id
  to:           string;
  subject:      string;
  sesMessageId: string | null;
  apiKeyId:     string;
  sentAt:       string;
  apiVersion:   '2';
}

/** email.delivered */
export interface EmailDeliveredPayload {
  event:      'email.delivered';
  id:         string;
  to:         string;
  apiKeyId:   string;
  occurredAt: string;
  apiVersion: '2';
}

/** email.bounced */
export interface EmailBouncedPayload {
  event:       'email.bounced';
  id:          string;
  to:          string;
  bounceType:  string | null;
  apiKeyId:    string;
  occurredAt:  string;
  apiVersion:  '2';
}

/** email.complained */
export interface EmailComplainedPayload {
  event:      'email.complained';
  id:         string;
  to:         string;
  apiKeyId:   string;
  occurredAt: string;
  apiVersion: '2';
}

/** email.send_failed */
export interface EmailSendFailedPayload {
  event:        'email.send_failed';
  id:           string;
  to:           string;
  errorMessage: string | null;
  apiKeyId:     string;
  apiVersion:   '2';
}

// ─── Legacy payload shapes (v1 — kept for backwards compat) ──────────────────

export interface VerificationCompletePayload {
  event:     'verification_complete';
  id:        string;
  email:     string;
  status:    string;
  checkedAt: string;
}

export interface BulkJobCompletePayload {
  event:        'bulk_job_complete';
  jobId:        string;
  fileName:     string;
  totalEmails:  number;
  validCount:   number;
  invalidCount: number;
  riskyCount:   number;
  unknownCount: number;
  completedAt:  string;
}

export interface MonitorStatusChangePayload {
  event:          'monitor_status_change';
  monitorId:      string;
  email:          string;
  previousStatus: string | null;
  newStatus:      string;
  checkedAt:      string;
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface WebhookRecord {
  id:             string;
  url:            string;
  label:          string | null;
  description:    string | null;
  events:         string[];
  isActive:       boolean;
  createdAt:      string;
  lastPingAt:     string | null;
  lastPingOk:     boolean | null;
  totalDeliveries: number;
  successCount:   number;
  failureCount:   number;
}

export interface DeliveryRecord {
  id:                string;
  webhookId:         string;
  event:             string;
  eventId:           string | null;
  attempts:          number;
  maxAttempts:       number;
  delivered:         boolean;
  failedPermanently: boolean;
  nextRetryAt:       string | null;
  lastAttemptAt:     string | null;
  statusCode:        number | null;
  errorMessage:      string | null;
  createdAt:         string;
}

export interface AttemptRecord {
  id:            string;
  deliveryId:    string;
  attemptNumber: number;
  requestedAt:   string;
  respondedAt:   string | null;
  durationMs:    number | null;
  statusCode:    number | null;
  responseBody:  string | null;
  errorType:     string | null;
  errorMessage:  string | null;
  success:       boolean;
}

/** campaign.sent */
export interface CampaignSentPayload {
  event:            'campaign.sent';
  campaign_id:      string;
  name:             string;
  subject:          string;
  from_email:       string;
  total_recipients: number;
  sent_count:       number;
  sent_at:          string | undefined;
  apiVersion:       '2';
}

/** campaign.failed */
export interface CampaignFailedPayload {
  event:       'campaign.failed';
  campaign_id: string;
  name:        string;
  subject:     string;
  error:       string;
  apiVersion:  '2';
}

/** campaign.paused_bounce */
export interface CampaignPausedBouncePayload {
  event:       'campaign.paused_bounce';
  campaign_id: string;
  bounce_pct:  number;
  apiVersion:  '2';
}

// ─── Dispatch helper input ────────────────────────────────────────────────────

export interface DispatchInput {
  apiKeyId:  string;
  event:     WebhookEvent;
  eventId:   string;       // "<event>:<sourceId>" — deduplication key
  payload:   WebhookEventPayload;
}
