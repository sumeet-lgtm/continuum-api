import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkIpIntelligence } from '../../engine/ipIntelligence.js';

const mockIpApiResponse = {
  status: 'success',
  country: 'United States',
  countryCode: 'US',
  region: 'CA',
  regionName: 'California',
  city: 'San Francisco',
  zip: '94103',
  lat: 37.77,
  lon: -122.41,
  timezone: 'America/Los_Angeles',
  isp: 'Cloudflare',
  org: 'Cloudflare, Inc',
  as: 'AS13335',
  proxy: false,
  hosting: true,
  mobile: false,
  query: '1.1.1.1',
};

describe('checkIpIntelligence caching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('only calls ip-api.com once for repeated lookups of the same IP', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockIpApiResponse,
    } as Response);

    const first = await checkIpIntelligence('1.1.1.1');
    const second = await checkIpIntelligence('1.1.1.1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.country).toBe('United States');
    expect(second.country).toBe('United States');
    expect(second.isHosting).toBe(true);
  });

  it('calls ip-api.com again for a different, not-yet-cached IP', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockIpApiResponse, query: '8.8.8.8' }),
    } as Response);

    await checkIpIntelligence('8.8.8.8');
    await checkIpIntelligence('9.9.9.9');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cache or call the API for a private IP', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await checkIpIntelligence('192.168.1.50');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.isp).toBe('Private Network');
  });

  it('does not cache an invalid IP format', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await checkIpIntelligence('not-an-ip');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.valid).toBe(false);
  });
});
