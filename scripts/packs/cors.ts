// The bucket's CORS policy (r2-cors.json, pasted into the R2 dashboard) and
// how R2 applies it, S3-style. The local stand-in server (serve-local.ts)
// answers with exactly these rules, so a phone or browser that works against
// it works against R2.

import { readFileSync } from 'node:fs'

export interface CorsRule {
  AllowedOrigins: string[]
  AllowedMethods: string[]
  AllowedHeaders?: string[]
  ExposeHeaders?: string[]
  MaxAgeSeconds?: number
}

export function loadCorsPolicy(path = new URL('./r2-cors.json', import.meta.url)): CorsRule[] {
  return JSON.parse(readFileSync(path, 'utf8')) as CorsRule[]
}

/** R2 origin patterns: exact, `*`, or one `*` wildcard anywhere (it may span dots). */
export function originMatches(pattern: string, origin: string): boolean {
  if (pattern === '*') return true
  const star = pattern.indexOf('*')
  if (star < 0) return pattern === origin
  const head = pattern.slice(0, star)
  const tail = pattern.slice(star + 1)
  return origin.length >= head.length + tail.length && origin.startsWith(head) && origin.endsWith(tail)
}

function headerAllowed(rule: CorsRule, header: string): boolean {
  const h = header.trim().toLowerCase()
  return (rule.AllowedHeaders ?? []).some((a) => a === '*' || a.toLowerCase() === h)
}

function matchRule(policy: CorsRule[], origin: string, method: string, requestHeaders: string[]): CorsRule | undefined {
  return policy.find(
    (r) =>
      r.AllowedOrigins.some((p) => originMatches(p, origin)) &&
      r.AllowedMethods.includes(method.toUpperCase()) &&
      requestHeaders.every((h) => !h.trim() || headerAllowed(r, h)),
  )
}

/**
 * Response headers for a cross-origin request, or null when no rule allows it
 * (R2 then answers a preflight with 403 and leaves CORS headers off a GET,
 * so the browser blocks it). `requestHeaders` is a preflight's
 * Access-Control-Request-Headers.
 */
export function corsHeaders(
  policy: CorsRule[],
  origin: string,
  method: string,
  requestHeaders: string[] = [],
): Record<string, string> | null {
  const rule = matchRule(policy, origin, method, requestHeaders)
  if (!rule) return null
  const out: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  }
  if (rule.ExposeHeaders?.length) out['Access-Control-Expose-Headers'] = rule.ExposeHeaders.join(', ')
  return out
}

/** Headers for a preflight (OPTIONS) answer, or null for 403. */
export function preflightHeaders(
  policy: CorsRule[],
  origin: string,
  method: string,
  requestHeaders: string[],
): Record<string, string> | null {
  const base = corsHeaders(policy, origin, method, requestHeaders)
  const rule = matchRule(policy, origin, method, requestHeaders)
  if (!base || !rule) return null
  const out: Record<string, string> = {
    ...base,
    'Access-Control-Allow-Methods': rule.AllowedMethods.join(', '),
  }
  const asked = requestHeaders.map((h) => h.trim()).filter(Boolean)
  if (asked.length) out['Access-Control-Allow-Headers'] = asked.join(', ')
  if (rule.MaxAgeSeconds) out['Access-Control-Max-Age'] = String(rule.MaxAgeSeconds)
  return out
}
