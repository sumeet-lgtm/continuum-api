import dns from 'dns/promises';

export interface DomainHealth {
  spf: { valid: boolean; record: string | null };
  dkim: { valid: boolean };
  dmarc: { valid: boolean; record: string | null };
  blacklisted: boolean;
  blacklistHits: string[];
  score: number;
}

export async function checkDmarc(domain: string): Promise<{ valid: boolean; record: string | null }> {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    const record = records.flat().find(r => r.startsWith('v=DMARC1'));
    return { valid: !!record, record: record ?? null };
  } catch {
    return { valid: false, record: null };
  }
}

export async function checkSpf(domain: string): Promise<{ valid: boolean; record: string | null }> {
  try {
    const records = await dns.resolveTxt(domain);
    const record = records.flat().find(r => r.startsWith('v=spf1'));
    return { valid: !!record, record: record ?? null };
  } catch {
    return { valid: false, record: null };
  }
}

// Check top blacklists via DNS lookup
const BLACKLISTS = [
  'zen.spamhaus.org',
  'bl.spamcop.net',
  'dnsbl.sorbs.net',
  'b.barracudacentral.org',
  'dnsbl-1.uceprotect.net',
];

export async function checkBlacklists(ip: string): Promise<{ blacklisted: boolean; hits: string[] }> {
  const reversed = ip.split('.').reverse().join('.');
  const hits: string[] = [];

  await Promise.allSettled(
    BLACKLISTS.map(async (bl) => {
      try {
        await dns.resolve4(`${reversed}.${bl}`);
        hits.push(bl);
      } catch { /* not listed */ }
    }),
  );

  return { blacklisted: hits.length > 0, hits };
}

export async function getDomainHealth(
  domain: string,
  dkimValid: boolean,
  ip?: string,
): Promise<DomainHealth> {
  const [spf, dmarc, bl] = await Promise.all([
    checkSpf(domain),
    checkDmarc(domain),
    ip ? checkBlacklists(ip) : Promise.resolve({ blacklisted: false, hits: [] }),
  ]);

  let score = 0;
  if (spf.valid) score += 25;
  if (dkimValid) score += 30;
  if (dmarc.valid) score += 25;
  if (!bl.blacklisted) score += 20;

  return {
    spf,
    dkim: { valid: dkimValid },
    dmarc,
    blacklisted: bl.blacklisted,
    blacklistHits: bl.hits,
    score,
  };
}
