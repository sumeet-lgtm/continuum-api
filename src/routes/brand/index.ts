import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

export async function brandRoutes(fastify: FastifyInstance): Promise<void> {

  // ─── Brand Kit CRUD ────────────────────────────────────────────────────────

  /** GET /v1/brand-kit — returns the brand kit for the authenticated key */
  fastify.get('/brand-kit', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const kit = await prisma.brand_kits.findUnique({ where: { api_key_id: apiKeyId } });
    return reply.send(kit ?? {});
  });

  /** PATCH /v1/brand-kit — upsert brand kit settings */
  fastify.patch('/brand-kit', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const body = request.body as {
      logo_url?: string | null;
      primary_color?: string;
      font_family?: string;
      company_name?: string | null;
      from_name?: string | null;
      footer_text?: string | null;
      website_url?: string | null;
    };

    const data: Record<string, unknown> = { updated_at: new Date() };
    if ('logo_url'      in body) data.logo_url      = body.logo_url      ?? null;
    if ('primary_color' in body) data.primary_color = body.primary_color ?? '#000000';
    if ('font_family'   in body) data.font_family   = body.font_family   ?? 'Arial, sans-serif';
    if ('company_name'  in body) data.company_name  = body.company_name  ?? null;
    if ('from_name'     in body) data.from_name     = body.from_name     ?? null;
    if ('footer_text'   in body) data.footer_text   = body.footer_text   ?? null;
    if ('website_url'   in body) data.website_url   = body.website_url   ?? null;

    const kit = await prisma.brand_kits.upsert({
      where:  { api_key_id: apiKeyId },
      create: { api_key_id: apiKeyId, ...data } as Parameters<typeof prisma.brand_kits.create>[0]['data'],
      update: data as Parameters<typeof prisma.brand_kits.update>[0]['data'],
    });

    return reply.send(kit);
  });

  // ─── Brand Extract (auto-detect from website URL) ─────────────────────────

  /** POST /v1/brand/extract — scrape logo, colors, font from a URL */
  fastify.post('/brand/extract', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { url?: string };
    if (!body.url?.trim()) throw Errors.validationFailed([{ field: 'url', message: 'url is required' }]);

    let targetUrl = body.url.trim();
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    let html: string;
    try {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContinuumBot/1.0; +https://continuumapi.com)', Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Fetch returned ${res.status}`);
      html = await res.text();
    } catch (err) {
      throw Errors.validationFailed([{ field: 'url', message: `Could not fetch the URL: ${(err as Error).message}` }]);
    }

    const ogImage    = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
    const touchIcon  = html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const faviconSvg = html.match(/<link[^>]+type=["']image\/svg\+xml["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const favicon    = html.match(/<link[^>]+rel=["'][^"']*(?:shortcut )?icon[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const rawLogo    = ogImage ?? touchIcon ?? faviconSvg ?? favicon ?? null;
    let logo: string | null = null;
    if (rawLogo) { try { logo = new URL(rawLogo, targetUrl).href; } catch { logo = rawLogo; } }

    const gfMatch    = html.match(/fonts\.googleapis\.com\/css[^"']*[?&]family=([^&"'|:]+)/i);
    const googleFont = gfMatch?.[1]?.split(':')[0]?.replace(/\+/g, ' ').trim() ?? null;
    const bodyFont   = html.match(/body\s*\{[^}]*font-family\s*:\s*([^;},]+)/i)?.[1]?.trim().split(',')[0]?.replace(/['"]/g, '').trim() ?? null;
    const fontFamily = googleFont ?? bodyFont ?? null;

    const themeColor    = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,6})["']/i)?.[1]?.toLowerCase() ?? null;
    const hexMatches    = [...html.matchAll(/(?:color|background(?:-color)?)\s*:\s*(#[0-9a-fA-F]{6})\b/gi)].map(m => m[1]?.toLowerCase()).filter((c): c is string => c != null);
    const freq: Record<string, number> = {};
    for (const c of hexMatches) {
      if (!['#ffffff','#000000','#eeeeee','#dddddd'].includes(c)) freq[c] = (freq[c] ?? 0) + 1;
    }
    const dominantColors = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c);
    const primaryColor   = themeColor ?? dominantColors[0] ?? null;

    const ogSiteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
    const titleTag   = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.split(/[|\-–•]/)[0]?.trim();
    const companyName = ogSiteName?.trim() ?? titleTag ?? null;

    return reply.send({ logo, primaryColor, colors: dominantColors, fontFamily, companyName, sourceUrl: targetUrl });
  });
}
