/**
 * Strips sensitive query-parameter VALUES out of a URL before it's logged.
 *
 * request.url is logged verbatim on every request/response (see server.ts).
 * Several public, unauthenticated routes carry a signed capability token as
 * a query param instead of a header — /track/open and /track/click use
 * ?t=/?token=, /unsubscribe and /confirm use ?token= — so without this,
 * every one of those tokens lands in plaintext in centralized logs, where
 * anyone with log access could replay the unsubscribe/confirm/open action
 * it authorizes.
 */

const SENSITIVE_QUERY_PARAMS = new Set(['token', 't']);

export function redactUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;

  const path = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  if (!query) return url;

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const [key, ...rest] = pair.split('=');
      if (key && SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) && rest.length > 0) {
        return `${key}=[REDACTED]`;
      }
      return pair;
    })
    .join('&');

  return `${path}?${redactedQuery}`;
}
