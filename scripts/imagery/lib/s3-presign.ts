// AWS Signature Version 4 presigned GET URLs (query-string auth), for the
// Copernicus Data Space S3 endpoint (eodata.dataspace.copernicus.eu). Only
// the host header is signed, so the reader can add any Range header.
//
// Keys come from the caller (read from the environment by build-satellite.ts)
// and are never logged; a presigned URL holds a signature, not the secret.

import { createHash, createHmac } from 'node:crypto'

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface PresignOptions {
  /** e.g. https://eodata.dataspace.copernicus.eu */
  endpoint: string
  /** Path-style: /<bucket>/<key> */
  bucket: string
  key: string
  region: string
  credentials: S3Credentials
  expiresSeconds: number
  /** For tests; defaults to now. */
  date?: Date
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest()

/** RFC 3986 encoding as SigV4 wants it (keeps / in paths when asked). */
export function uriEncode(s: string, keepSlash: boolean): string {
  let out = ''
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) out += ch
    else for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

function amzDate(d: Date): { stamp: string; day: string } {
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { stamp, day: stamp.slice(0, 8) }
}

export function presignGetUrl(o: PresignOptions): string {
  const url = new URL(o.endpoint)
  const host = url.host
  const path = `/${o.bucket ? `${o.bucket}/` : ''}${o.key}`.replace(/\/+/g, '/')
  const canonicalUri = uriEncode(path, true)
  const { stamp, day } = amzDate(o.date ?? new Date())
  const scope = `${day}/${o.region}/s3/aws4_request`
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(o.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${o.credentials.secretAccessKey}`, day)
  const kRegion = hmac(kDate, o.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  return `${url.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** s3://bucket/key → { bucket, key } */
export function parseS3Url(s3Url: string): { bucket: string; key: string } {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3Url)
  if (!m) throw new Error(`not an s3:// URL: ${s3Url}`)
  return { bucket: m[1], key: m[2] }
}
