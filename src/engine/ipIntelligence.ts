/**
 * IP Intelligence Engine
 * 
 * Uses ip-api.com (free, 45 req/min) for:
 * - Geolocation (country, city, region, lat/lng)
 * - ISP/Organization detection
 * - VPN/proxy/TOR detection
 * - Mobile detection
 * 
 * Falls back gracefully if API is unavailable.
 */

import { logger } from '../lib/logger.js';

export interface IpIntelligenceResult {
  ip:           string;
  valid:        boolean;
  // Geolocation
  country:      string | null;
  countryCode:  string | null;
  region:       string | null;
  regionName:   string | null;
  city:         string | null;
  zip:          string | null;
  lat:          number | null;
  lon:          number | null;
  timezone:     string | null;
  // Network
  isp:          string | null;
  org:          string | null;
  as:           string | null;
  // Risk
  isProxy:      boolean;
  isVpn:        boolean;
  isTor:        boolean;
  isMobile:     boolean;
  isHosting:    boolean;
  riskScore:    number; // 0-100, higher = more risky
  riskLevel:    'low' | 'medium' | 'high';
  // Meta
  checkedAt:    string;
  durationMs:   number;
}

// Known hosting/datacenter ASN prefixes
const HOSTING_KEYWORDS = [
  'amazon', 'google', 'microsoft', 'digitalocean', 'linode', 'vultr',
  'hetzner', 'ovh', 'cloudflare', 'fastly', 'akamai', 'rackspace',
  'aws', 'azure', 'gcp', 'datacenter', 'hosting', 'server', 'cloud',
];

function isHostingIsp(isp: string, org: string): boolean {
  const combined = `${isp} ${org}`.toLowerCase();
  return HOSTING_KEYWORDS.some(k => combined.includes(k));
}

function calculateRiskScore(data: {
  isProxy: boolean;
  isVpn: boolean;
  isTor: boolean;
  isHosting: boolean;
  isMobile: boolean;
  countryCode: string | null;
}): { score: number; level: 'low' | 'medium' | 'high' } {
  let score = 0;

  if (data.isTor)     score += 90;
  if (data.isProxy)   score += 70;
  if (data.isVpn)     score += 50;
  if (data.isHosting) score += 30;

  score = Math.min(100, score);

  const level = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
  return { score, level };
}

export async function checkIpIntelligence(ip: string): Promise<IpIntelligenceResult> {
  const start = Date.now();

  // Basic IP validation
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^[0-9a-fA-F:]+$/;
  
  if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
    return invalidResult(ip, 'Invalid IP format', start);
  }

  // Block private IPs
  if (isPrivateIp(ip)) {
    return {
      ip, valid: false,
      country: null, countryCode: null, region: null, regionName: null,
      city: null, zip: null, lat: null, lon: null, timezone: null,
      isp: 'Private Network', org: 'Private Network', as: null,
      isProxy: false, isVpn: false, isTor: false, isMobile: false, isHosting: false,
      riskScore: 0, riskLevel: 'low',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
  }

  try {
    // ip-api.com free tier — 45 requests/minute, no key needed
    const fields = 'status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,mobile,query';
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=${fields}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!res.ok) {
      logger.warn({ ip, status: res.status }, 'ip-api.com returned error');
      return invalidResult(ip, 'IP lookup service unavailable', start);
    }

    const data = await res.json() as {
      status: string;
      message?: string;
      country?: string;
      countryCode?: string;
      region?: string;
      regionName?: string;
      city?: string;
      zip?: string;
      lat?: number;
      lon?: number;
      timezone?: string;
      isp?: string;
      org?: string;
      as?: string;
      proxy?: boolean;
      hosting?: boolean;
      mobile?: boolean;
      query?: string;
    };

    if (data.status !== 'success') {
      return invalidResult(ip, data.message ?? 'Lookup failed', start);
    }

    const isProxy   = data.proxy ?? false;
    const isHosting = data.hosting ?? isHostingIsp(data.isp ?? '', data.org ?? '');
    const isMobile  = data.mobile ?? false;
    const isVpn     = isProxy && isHosting; // VPN = proxy on hosting infrastructure
    const isTor     = false; // ip-api free doesn't detect TOR — would need paid plan

    const { score, level } = calculateRiskScore({
      isProxy, isVpn, isTor, isHosting, isMobile,
      countryCode: data.countryCode ?? null,
    });

    return {
      ip: data.query ?? ip,
      valid: true,
      country:     data.country     ?? null,
      countryCode: data.countryCode ?? null,
      region:      data.region      ?? null,
      regionName:  data.regionName  ?? null,
      city:        data.city        ?? null,
      zip:         data.zip         ?? null,
      lat:         data.lat         ?? null,
      lon:         data.lon         ?? null,
      timezone:    data.timezone    ?? null,
      isp:         data.isp         ?? null,
      org:         data.org         ?? null,
      as:          data.as          ?? null,
      isProxy, isVpn, isTor, isMobile, isHosting,
      riskScore:   score,
      riskLevel:   level,
      checkedAt:   new Date().toISOString(),
      durationMs:  Date.now() - start,
    };

  } catch (err) {
    logger.error({ err, ip }, 'IP intelligence check failed');
    return invalidResult(ip, 'Lookup failed', start);
  }
}

function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return false;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    a === 0
  );
}

function invalidResult(ip: string, error: string, start: number): IpIntelligenceResult {
  return {
    ip, valid: false,
    country: null, countryCode: null, region: null, regionName: null,
    city: null, zip: null, lat: null, lon: null, timezone: null,
    isp: null, org: null, as: null,
    isProxy: false, isVpn: false, isTor: false, isMobile: false, isHosting: false,
    riskScore: 0, riskLevel: 'low',
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}
