/**
 * Role account detection.
 *
 * Role accounts belong to a function or team rather than a specific person.
 * Sending outbound to them has poor deliverability and high abuse-report risk:
 *   - "abuse@", "postmaster@"    → monitored for complaints, never for sales
 *   - "noreply@", "mailer@"      → auto-responders that may loop or bounce
 *   - "info@", "hello@", "hr@"   → shared inboxes, low engagement, wrong person
 *
 * Detection layers:
 *   1. Exact match against the canonical role-prefix set
 *   2. Numeric-suffix stripping: "support1", "admin2" → try the root
 *   3. Regex patterns for compound forms and localized role names
 */

// ─── Exact prefix set ─────────────────────────────────────────────────────────

const ROLE_EXACT = new Set<string>([
  // ── RFC 2142 mandatory mailboxes ──────────────────────────────────────────
  'postmaster', 'hostmaster', 'webmaster', 'abuse', 'security',
  'usenet', 'news', 'uucp', 'ftp',

  // ── Infrastructure / transactional ───────────────────────────────────────
  'noreply', 'no-reply', 'no_reply',
  'donotreply', 'do-not-reply', 'do_not_reply', 'donot-reply',
  'mailer', 'mailer-daemon', 'mailerdaemon', 'daemon',
  'bounce', 'bounces', 'bounce-handler', 'return', 'returns',
  'notifications', 'notify', 'notification',
  'automated', 'automailer', 'auto',
  'robot', 'autoresponder', 'auto-responder',
  'system', 'sys', 'root',

  // ── Generic contact ───────────────────────────────────────────────────────
  'info', 'information', 'informacao',      // PT
  'contact', 'contacts', 'contacto',        // ES/PT
  'kontakt', 'kontakte',                    // DE
  'hello', 'hi', 'hey',
  'general', 'enquiries', 'enquiry',
  'inquiries', 'inquiry', 'inquery',
  'query', 'queries',

  // ── Support & customer service ────────────────────────────────────────────
  'support', 'supports',
  'help', 'helpdesk', 'help-desk', 'helpdesk', 'helpline',
  'assist', 'assistance',
  'care', 'customercare', 'customer-care',
  'service', 'services',
  'customerservice', 'customer-service', 'customer_service',
  'customersupport', 'customer-support',
  'clientservices', 'client-services',
  'clients', 'client',
  'techsupport', 'tech-support',
  'itsupport', 'it-support',

  // ── Sales & business development ──────────────────────────────────────────
  'sales', 'salesteam', 'sale',
  'marketing', 'mkt',
  'advertise', 'advertising', 'ads', 'advert',
  'promo', 'promotions', 'promotion',
  'newsletter', 'newsletters',
  'subscribe', 'subscriptions', 'subscription',
  'unsubscribe', 'optout', 'opt-out',
  'list', 'lists', 'listserv', 'listserve', 'mailing',
  'bulk', 'mass',
  'campaigns', 'campaign',
  'partnerships', 'partners', 'partner',
  'business', 'biz',
  'deals', 'offers',

  // ── Administrative ────────────────────────────────────────────────────────
  'admin', 'administrator', 'administration',
  'office', 'reception', 'receptionist',
  'frontdesk', 'front-desk',
  'it', 'hr', 'humanresources', 'human-resources',
  'legal', 'compliance',
  'accounts', 'accounting', 'finance', 'billing',
  'invoice', 'invoices', 'invoicing',
  'payment', 'payments', 'payroll',
  'procurement', 'purchasing',
  'orders', 'order', 'ordering',
  'logistics', 'shipping',
  'operations', 'ops',
  'facilities',

  // ── Technical / DevOps ────────────────────────────────────────────────────
  'dev', 'developer', 'developers', 'development',
  'devops', 'sre', 'platform',
  'sysadmin', 'infrastructure', 'infra',
  'network', 'networking', 'noc',
  'monitoring', 'alerts', 'alarm', 'alarms',
  'reports', 'reporting', 'logs', 'logging',
  'errors', 'error', 'bugs', 'bug', 'issues',
  'status', 'uptime',
  'api', 'webhook', 'webhooks',

  // ── Privacy / compliance ──────────────────────────────────────────────────
  'privacy', 'gdpr', 'dpo', 'ccpa',
  'dmca', 'copyright', 'takedowns',
  'security-alert', 'securityalert',
  'phishing', 'fraud', 'abuse-report',

  // ── Recruiting / HR ───────────────────────────────────────────────────────
  'jobs', 'careers', 'career',
  'hiring', 'recruitment', 'recruiter',
  'apply', 'applications', 'applicants',
  'cvs', 'resumes',

  // ── Media / communications ────────────────────────────────────────────────
  'press', 'media', 'pr', 'publicrelations', 'public-relations',
  'news', 'editorial', 'editor',
  'team', 'staff', 'crew',

  // ── Events ───────────────────────────────────────────────────────────────
  'events', 'event', 'conference', 'conferences',
  'webinar', 'webinars', 'seminar', 'workshop',

  // ── Feedback / community ──────────────────────────────────────────────────
  'feedback', 'reviews', 'review',
  'suggestions', 'suggestion', 'ideas',
  'community', 'forum',

  // ── Vendor / supplier ─────────────────────────────────────────────────────
  'vendors', 'vendor', 'supplier', 'suppliers',

  // ── Localized common role names ───────────────────────────────────────────
  // French
  'contact', 'bonjour', 'aide', 'assistance', 'ventes',
  // German
  'kontakt', 'hilfe', 'verwaltung', 'verkauf', 'anfrage',
  // Spanish
  'contacto', 'soporte', 'ventas', 'consulta', 'ayuda',
  // Portuguese
  'suporte', 'vendas', 'contato',
  // Italian
  'contatti', 'assistenza', 'vendite',
]);

// ─── Compound / pattern matching ─────────────────────────────────────────────

const ROLE_PATTERNS: RegExp[] = [
  // No-reply variants (most common and most important to catch)
  /^no[-_.]?reply/i,
  /^do[-_.]?not[-_.]?reply/i,
  /noreply/i,

  // Bounce/return variants
  /^bounce[sd]?[-_.]?/i,
  /^return[-_.]?path/i,

  // Mailer daemon
  /^mailer[-_.]?daemon/i,

  // Compound role at end: "team-support", "it-helpdesk", "contact-us"
  /[-_.](support|help|info|admin|sales|contact|team|service|noreply|billing)$/i,

  // Compound role at start: "support-dept", "admin-team", "info-eu"
  /^(support|help|info|admin|sales|contact|team|service|noreply|billing)[-_.]/i,

  // "customer*" or "*service" catchalls
  /^customer[-_.]/i,
  /[-_.]service$/i,

  // Anything ending in -dept, -department, -group, -team
  /[-_.](dept|department|group|team|office)$/i,

  // Automated sending patterns
  /^(automated?|automailer|robot|do-not-reply)/i,
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the local part of an email is a role account.
 * @param local - the local part (before @), need not be pre-lowercased
 */
export function isRoleAccount(local: string): boolean {
  const normalized = local.toLowerCase().trim();

  // 1. Exact match
  if (ROLE_EXACT.has(normalized)) return true;

  // 2. Strip trailing digits and try again: "admin2", "info123", "support01"
  const withoutDigits = normalized.replace(/\d+$/, '');
  if (withoutDigits.length > 1 && ROLE_EXACT.has(withoutDigits)) return true;

  // 3. Regex patterns for compound / localized forms
  for (const pattern of ROLE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  return false;
}
