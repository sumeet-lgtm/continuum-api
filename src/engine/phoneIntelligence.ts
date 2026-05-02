/**
 * Phone Intelligence Engine
 * 
 * Uses libphonenumber-js for:
 * - Format validation
 * - Country detection
 * - Number type (mobile/landline/voip/toll-free)
 * - E.164 formatting
 * - National/international format
 * 
 * 100% free — no external API needed.
 */

import {
  parsePhoneNumber,
  isValidPhoneNumber,
  isPossiblePhoneNumber,
  parsePhoneNumberWithError,
  type CountryCode,
} from 'libphonenumber-js';
import { logger } from '../lib/logger.js';

export interface PhoneIntelligenceResult {
  phone:              string;
  valid:              boolean;
  possible:           boolean;
  // Formatting
  e164:               string | null;
  national:           string | null;
  international:      string | null;
  // Location
  country:            string | null;
  countryCode:        string | null;
  // Type
  lineType:           'mobile' | 'landline' | 'voip' | 'toll_free' | 'premium_rate' | 'shared_cost' | 'personal' | 'pager' | 'uan' | 'voicemail' | 'unknown';
  isMobile:           boolean;
  isLandline:         boolean;
  isVoip:             boolean;
  isTollFree:         boolean;
  // Carrier (from prefix — approximate)
  carrierHint:        string | null;
  // Risk signals
  isPremiumRate:      boolean;
  riskLevel:          'low' | 'medium' | 'high';
  // Meta
  checkedAt:          string;
  durationMs:         number;
}

// Line type mapping from libphonenumber
const LINE_TYPE_MAP: Record<number, PhoneIntelligenceResult['lineType']> = {
  0:  'mobile',
  1:  'landline',
  2:  'landline', // FIXED_LINE_OR_MOBILE
  3:  'toll_free',
  4:  'premium_rate',
  5:  'shared_cost',
  6:  'voip',
  7:  'personal',
  8:  'pager',
  9:  'uan',
  10: 'voicemail',
};

// Major carrier prefixes for India (approximate)
const IN_CARRIER_PREFIXES: Record<string, string> = {
  '98': 'Airtel', '97': 'Airtel', '70': 'Airtel', '89': 'Airtel',
  '90': 'Airtel', '91': 'Airtel', '92': 'Airtel', '93': 'Airtel',
  '99': 'Vodafone Idea', '95': 'Vodafone Idea', '96': 'Vodafone Idea',
  '80': 'Jio', '85': 'Jio', '86': 'Jio', '87': 'Jio', '88': 'Jio',
  '62': 'BSNL', '94': 'BSNL',
};

function getCarrierHint(phone: string, countryCode: string | null): string | null {
  if (countryCode !== 'IN') return null;
  
  // Extract first 2 digits of subscriber number (after country code +91)
  const digits = phone.replace(/\D/g, '');
  const subscriber = digits.startsWith('91') ? digits.slice(2) : digits;
  const prefix = subscriber.slice(0, 2);
  
  return IN_CARRIER_PREFIXES[prefix] ?? null;
}

export async function checkPhoneIntelligence(
  phone: string,
  defaultCountry?: string,
): Promise<PhoneIntelligenceResult> {
  const start = Date.now();
  const country = (defaultCountry?.toUpperCase() ?? 'IN') as CountryCode;

  try {
    // Check if possible (loose check)
    const possible = isPossiblePhoneNumber(phone, country);
    
    if (!possible && !phone.startsWith('+')) {
      return invalidResult(phone, start, false);
    }

    // Parse the number
    let parsed;
    try {
      parsed = parsePhoneNumberWithError(phone, country);
    } catch {
      return invalidResult(phone, start, possible);
    }

    const valid = parsed.isValid();
    const typeNum = parsed.getType();
    const lineType = typeNum !== undefined ? (LINE_TYPE_MAP[typeNum as unknown as number] ?? 'unknown') : 'unknown';

    const isMobile    = lineType === 'mobile';
    const isLandline  = lineType === 'landline';
    const isVoip      = lineType === 'voip';
    const isTollFree  = lineType === 'toll_free';
    const isPremiumRate = lineType === 'premium_rate';

    const countryCode = parsed.country ?? null;
    const carrierHint = getCarrierHint(phone, countryCode);

    // Risk assessment
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (isPremiumRate) riskLevel = 'high';
    else if (lineType === 'pager' || lineType === 'shared_cost') riskLevel = 'medium';
    else if (!valid) riskLevel = 'medium';

    return {
      phone,
      valid,
      possible,
      e164:          parsed.format('E.164'),
      national:      parsed.formatNational(),
      international: parsed.formatInternational(),
      country:       countryCode ? getCountryName(countryCode) : null,
      countryCode,
      lineType,
      isMobile,
      isLandline,
      isVoip,
      isTollFree,
      isPremiumRate,
      carrierHint,
      riskLevel,
      checkedAt:  new Date().toISOString(),
      durationMs: Date.now() - start,
    };

  } catch (err) {
    logger.error({ err, phone }, 'Phone intelligence check failed');
    return invalidResult(phone, start, false);
  }
}

function invalidResult(phone: string, start: number, possible: boolean): PhoneIntelligenceResult {
  return {
    phone,
    valid:         false,
    possible,
    e164:          null,
    national:      null,
    international: null,
    country:       null,
    countryCode:   null,
    lineType:      'unknown',
    isMobile:      false,
    isLandline:    false,
    isVoip:        false,
    isTollFree:    false,
    isPremiumRate: false,
    carrierHint:   null,
    riskLevel:     'medium',
    checkedAt:     new Date().toISOString(),
    durationMs:    Date.now() - start,
  };
}

// Basic country name lookup for common countries
function getCountryName(code: string): string {
  const names: Record<string, string> = {
    IN: 'India', US: 'United States', GB: 'United Kingdom',
    AU: 'Australia', CA: 'Canada', SG: 'Singapore',
    AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar',
    KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', PK: 'Pakistan',
    BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal', DE: 'Germany',
    FR: 'France', NL: 'Netherlands', SE: 'Sweden', NO: 'Norway',
    DK: 'Denmark', FI: 'Finland', IT: 'Italy', ES: 'Spain',
    PT: 'Portugal', BE: 'Belgium', CH: 'Switzerland', AT: 'Austria',
    PL: 'Poland', RU: 'Russia', JP: 'Japan', CN: 'China',
    KR: 'South Korea', MY: 'Malaysia', ID: 'Indonesia', TH: 'Thailand',
    PH: 'Philippines', VN: 'Vietnam', ZA: 'South Africa',
    NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', EG: 'Egypt',
    BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CO: 'Colombia',
  };
  return names[code] ?? code;
}
