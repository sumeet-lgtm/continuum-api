/**
 * Bot/prefetch classification for open and click tracking events.
 *
 * Industry data (M3AAWG) puts non-human clicks at 20-80% of raw B2B email
 * click volume — Apple Mail Privacy Protection alone prefetches every
 * tracking pixel for every MPP-enabled recipient regardless of whether the
 * message is ever actually opened, and corporate security gateways
 * (Mimecast, Proofpoint, Microsoft Defender/SafeLinks, Barracuda) fetch
 * every link before a message reaches an inbox at all, as part of scanning
 * it for malware. Every open/click is still recorded — this only adds a
 * confidence signal for whoever reads the data back, and lets behavioral
 * logic (sequence stop_on_open, if_opened conditions) tell an inflated
 * pixel-load apart from a real human engaging.
 *
 * Layered cheapest-and-most-certain first — each check runs in-process
 * with no external API call, since this sits in the hot path of every
 * single tracking pixel/redirect request. checkIpFanout below is the one
 * exception (it needs a DB round trip) — kept as a separate function so
 * classifyTrackingEvent stays a pure, dependency-free unit under test.
 */

import { prisma } from '../lib/prisma.js';

// Apple's Mail Privacy Protection proxy egresses from Apple's own
// allocated 17.0.0.0/8 block — never a residential or mobile ISP range —
// so this single check alone accounts for the largest share of inflated
// opens on any list with real iOS/macOS Mail users.
function isAppleMppIp(ip: string | null): boolean {
  return !!ip && ip.startsWith('17.');
}

// Known automation/security-scanner signatures and empty/placeholder
// user-agents. Not exhaustive — corporate gateways frequently don't
// self-identify at all — but catches the common, low-effort cases for
// free: bare HTTP clients, headless browsers, and generic crawlers.
const BOT_USER_AGENT_PATTERNS: RegExp[] = [
  /curl\//i,
  /python-requests/i,
  /go-http-client/i,
  /okhttp/i,
  /libwww-perl/i,
  /^wget\//i,
  /headlesschrome/i,
  /phantomjs/i,
  /googlebot/i,
  /bingbot/i,
  /\bbot\b/i,
  /crawler/i,
  /spider/i,
  /scanner/i,
  /^java\//i,
  /^apache-httpclient/i,
];

function hasBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent || !userAgent.trim()) return true; // missing UA is itself suspicious for a real mail client
  return BOT_USER_AGENT_PATTERNS.some((p) => p.test(userAgent));
}

// A corporate security gateway fetches every link/image before the
// message ever reaches an inbox — within the first couple of seconds
// after send, far faster than any human could receive, read, and act on
// an email. A genuine MPP prefetch also tends to land within this window,
// so this is a second, independent signal even for IPs outside 17.0.0.0/8
// (Apple sometimes proxies through non-17.x ranges depending on region).
const PREFETCH_WINDOW_MS = 3_000;

export interface TrackingClassificationInput {
  ip: string | null;
  userAgent: string | null;
  sentAt: Date | null;
  occurredAt: Date;
}

export type BotReason = 'apple_mpp' | 'bot_user_agent' | 'prefetch_timing' | 'ip_fanout';

export interface TrackingClassification {
  isLikelyBot: boolean;
  botReason: BotReason | null;
}

export function classifyTrackingEvent(input: TrackingClassificationInput): TrackingClassification {
  if (isAppleMppIp(input.ip)) {
    return { isLikelyBot: true, botReason: 'apple_mpp' };
  }

  if (hasBotUserAgent(input.userAgent)) {
    return { isLikelyBot: true, botReason: 'bot_user_agent' };
  }

  if (input.sentAt) {
    const msSinceSend = input.occurredAt.getTime() - input.sentAt.getTime();
    if (msSinceSend >= 0 && msSinceSend < PREFETCH_WINDOW_MS) {
      return { isLikelyBot: true, botReason: 'prefetch_timing' };
    }
  }

  return { isLikelyBot: false, botReason: null };
}

// A single human never touches more than a handful of *different* people's
// tracking links in a tight window — but a shared corporate security
// gateway or scanning proxy does exactly that, fanning out across an
// entire campaign's recipient list from one IP shortly after send. This is
// the pattern behind "why do all our opens/clicks come from one server" —
// one IP hitting many distinct messages in a short window, independent of
// user-agent or IP block, so it catches scanners the checks above miss
// entirely (a gateway that sends a normal browser UA and isn't in a known
// range). Deliberately windowed + thresholded rather than "any repeat IP":
// a real company's shared NAT/VPN gateway also produces genuine human
// opens from one IP, but those spread across a whole business day — a
// scanner's fanout compresses into minutes, not hours.
const FANOUT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const FANOUT_DISTINCT_THRESHOLD = 8; // distinct messages from one IP within the window

export async function checkIpFanout(ip: string | null, occurredAt: Date): Promise<boolean> {
  if (!ip) return false;
  try {
    const recent = await prisma.trackingEvent.findMany({
      where: {
        ip,
        occurredAt: { gte: new Date(occurredAt.getTime() - FANOUT_WINDOW_MS) },
      },
      distinct: ['sendMessageId'],
      select: { sendMessageId: true },
      take: FANOUT_DISTINCT_THRESHOLD,
    });
    return recent.length >= FANOUT_DISTINCT_THRESHOLD;
  } catch {
    return false; // fail open — a DB hiccup here shouldn't block a real tracking event
  }
}
