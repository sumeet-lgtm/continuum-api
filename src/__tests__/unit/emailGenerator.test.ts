import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CampaignSegment } from '../../lib/campaignSegments.js';

vi.mock('../../lib/emailKnowledgeBase.js', () => ({
  getEmailKnowledgeBase: () => 'CONDENSED TEST KNOWLEDGE BASE — never use "leverage" or "seamless".',
}));

import { generateSegmentEmail } from '../../lib/emailGenerator.js';

const originalFetch = global.fetch;

function makeSegment(overrides: Partial<CampaignSegment> = {}): CampaignSegment {
  return {
    label: 'Security Engineering',
    matchCount: 40,
    matchPct: 40,
    signalSummary: 'Segment "Security Engineering" — 40% of this list (40 of 100 contacts); common titles: Security Engineer, CISO.',
    sampleTitles: ['Security Engineer', 'CISO'],
    contacts: [],
    ...overrides,
  };
}

function jsonResponse(obj: unknown) {
  return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(obj) }] }) };
}

afterEach(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateSegmentEmail', () => {
  it('runs a draft pass then a critique pass, returning the revised copy', async () => {
    const draftResponse = jsonResponse({
      subject: 'quick one',
      textBody: 'hey — saw your team leverages seamless synergy. draft body.',
      htmlBody: '<p>hey — draft body.</p>',
      hookUsed: 'CISO title match',
    });
    const revisedResponse = jsonResponse({
      subject: 'quick one',
      textBody: 'hey — saw your team is scaling security eng. revised body.',
      htmlBody: '<p>hey — revised body.</p>',
      changed: true,
      notes: 'removed banned words leverage/seamless/synergy',
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(draftResponse)
      .mockResolvedValueOnce(revisedResponse);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateSegmentEmail('test-key', {
      about: 'a pentesting tool for security teams',
      segment: makeSegment(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.textBody).toBe('hey — saw your team is scaling security eng. revised body.');
    expect(result.revised).toBe(true);
    expect(result.hookUsed).toBe('CISO title match');
    expect(result.segmentLabel).toBe('Security Engineering');
    expect(result.matchPct).toBe(40);
  });

  it('reports changed:false when the draft already passes the critique unmodified', async () => {
    const draft = {
      subject: 'clean subject',
      textBody: 'already good body.',
      htmlBody: '<p>already good body.</p>',
      hookUsed: 'funding round trigger',
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(draft))
      .mockResolvedValueOnce(jsonResponse({ ...draft, changed: false })) as unknown as typeof fetch;

    const result = await generateSegmentEmail('test-key', {
      about: 'an offer',
      segment: makeSegment(),
    });

    expect(result.revised).toBe(false);
    expect(result.textBody).toBe('already good body.');
  });

  it('falls back to the unrevised draft when the critique pass itself fails', async () => {
    const draft = {
      subject: 'draft subject',
      textBody: 'draft body that never got critiqued.',
      htmlBody: '<p>draft body.</p>',
      hookUsed: 'a real signal',
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(draft))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' }) as unknown as typeof fetch;

    const result = await generateSegmentEmail('test-key', {
      about: 'an offer',
      segment: makeSegment(),
    });

    // Draft is still returned — a best-effort second pass failing must not
    // fail the whole generation.
    expect(result.textBody).toBe('draft body that never got critiqued.');
    expect(result.revised).toBe(false);
  });

  it('sends the real segment signal summary (not a placeholder) in the draft prompt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ subject: 's', textBody: 't', htmlBody: '<p>t</p>', hookUsed: 'h' }))
      .mockResolvedValueOnce(jsonResponse({ subject: 's', textBody: 't', htmlBody: '<p>t</p>', changed: false }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const segment = makeSegment({ signalSummary: 'UNIQUE_TEST_SIGNAL_MARKER_12345' });
    await generateSegmentEmail('test-key', { about: 'an offer', segment });

    const firstCallBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstCallBody.messages[0].content).toContain('UNIQUE_TEST_SIGNAL_MARKER_12345');
    // The knowledge base itself must be the system prompt, not just a mention of it.
    expect(firstCallBody.system).toContain('CONDENSED TEST KNOWLEDGE BASE');
  });

  it('uses the sonnet model, not haiku, given the density of instructions the knowledge base carries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ subject: 's', textBody: 't', htmlBody: '<p>t</p>', hookUsed: 'h' }))
      .mockResolvedValueOnce(jsonResponse({ subject: 's', textBody: 't', htmlBody: '<p>t</p>', changed: false }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await generateSegmentEmail('test-key', { about: 'an offer', segment: makeSegment() });

    const firstCallBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstCallBody.model).toBe('claude-sonnet-5');
  });
});
