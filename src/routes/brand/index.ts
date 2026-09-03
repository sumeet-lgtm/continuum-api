import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { Errors } from '../../plugins/errorHandler.js';

export async function brandRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/brand/extract — extract brand assets from a customer website URL
  fastify.post('/brand/extract', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { url?: string };
    if (!body.url?.trim()) throw Errors.validationFailed([{ field: 'url', message: 'url is required' }]);

    let targetUrl = body.url.trim();
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    let html: string;
    try {
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ContinuumBot/1.0; +https://continuumapi.com)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Fetch returned ${res.status}`);
      html = await res.text();
    } catch (err) {
      throw Errors.validationFailed([{ field: 'url', message: `Could not fetch the URL: ${(err as Error).message}` }]);
    }

    // Logo: og:image → apple-touch-icon → favicon
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
    const touchIcon = html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const faviconSvg = html.match(/<link[^>]+type=["']image\/svg\+xml["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const favicon = html.match(/<link[^>]+rel=["'][^"']*(?:shortcut )?icon[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const rawLogo = ogImage ?? touchIcon ?? faviconSvg ?? favicon ?? null;
    let logo: string | null = null;
    if (rawLogo) {
      try { logo = new URL(rawLogo, targetUrl).href; } catch { logo = rawLogo; }
    }

    // Font: Google Fonts link → CSS body font-family
    const gfMatch = html.match(/fonts\.googleapis\.com\/css[^"']*[?&]family=([^&"'|:]+)/i);
    const googleFont = gfMatch?.[1]?.split(':')[0]?.replace(/\+/g, ' ').trim() ?? null;
    const bodyFontCss = html.match(/body\s*\{[^}]*font-family\s*:\s*([^;},]+)/i)?.[1]?.trim().split(',')[0].replace(/['"]/g, '').trim() ?? null;
    const fontFamily = googleFont ?? bodyFontCss ?? null;

    // Colors: theme-color meta → CSS hex colors (deduplicated, most frequent)
    const themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,6})["']/i)?.[1]?.toLowerCase() ?? null;
    const hexMatches = [...html.matchAll(/(?:color|background(?:-color)?)\s*:\s*(#[0-9a-fA-F]{6})\b/gi)].map(m => m[1].toLowerCase());
    const freq: Record<string, number> = {};
    for (const c of hexMatches) {
      if (c !== '#ffffff' && c !== '#000000' && c !== '#eeeeee' && c !== '#dddddd') {
        freq[c] = (freq[c] ?? 0) + 1;
      }
    }
    const dominantColors = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c);
    const primaryColor = themeColor ?? dominantColors[0] ?? null;
    const secondaryColor = dominantColors.find(c => c !== primaryColor) ?? null;

    // Company name: og:site_name → title tag first segment
    const ogSiteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.split(/[|\-–•]/)[0].trim();
    const companyName = ogSiteName?.trim() ?? titleTag ?? null;

    return reply.status(200).send({
      logo,
      primaryColor,
      secondaryColor,
      colors: dominantColors,
      fontFamily,
      companyName,
      sourceUrl: targetUrl,
    });
  });
}
