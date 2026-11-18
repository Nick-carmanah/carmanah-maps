// Upload files to the tile bucket with the right headers (layout.ts), using
// rclone and the R2 remote Nick sets up on his Mac (docs/hosting-r2.md).
//
//   node scripts/packs/upload.ts <file> <key>          one object, e.g. catalog.json
//   node scripts/packs/upload.ts --pack <dir>          a built pack: packs/<id>/…, pack.json last
//
// Credentials come only from rclone's own config (or its RCLONE_CONFIG_*
// environment variables). This script never reads, asks for, prints or
// stores a key. Remote and bucket names can be changed with R2_REMOTE and
// R2_BUCKET (defaults carmanah-r2 and carmanah-maps).
//
// Immutable keys (everything but catalog.json, LICENSE.txt and imagery JSON)
// are never overwritten: if the key exists with the same size it's skipped,
// with a different size the upload stops. Publish a new build under a new key.

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { objectHeaders } from './layout.ts'

const REMOTE = process.env.R2_REMOTE || 'carmanah-r2'
const BUCKET = process.env.R2_BUCKET || 'carmanah-maps'

function rclone(args: string[], inherit = false): string {
  const out = spawnSync('rclone', args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' })
  if (out.error) throw new Error(`rclone isn't installed (brew install rclone): ${out.error.message}`)
  if (out.status !== 0) throw new Error(`rclone ${args[0]} failed${out.stderr ? `: ${out.stderr.trim().split('\n').pop()}` : ''}`)
  return out.stdout ?? ''
}

function checkRemote(): void {
  const remotes = rclone(['listremotes']).split('\n').map((s) => s.trim())
  if (!remotes.includes(`${REMOTE}:`)) {
    throw new Error(`No rclone remote "${REMOTE}". Set it up as in docs/hosting-r2.md §5 (or set R2_REMOTE).`)
  }
}

/** Size of an object in the bucket, or null if there isn't one. */
function remoteSize(key: string): number | null {
  const slash = key.lastIndexOf('/')
  const dir = slash < 0 ? '' : key.slice(0, slash)
  const name = key.slice(slash + 1)
  let listing: { Name: string; Size: number }[] = []
  try {
    listing = JSON.parse(rclone(['lsjson', '--files-only', '--no-modtime', '--no-mimetype', `${REMOTE}:${BUCKET}/${dir}`]))
  } catch {
    return null // folder doesn't exist yet
  }
  return listing.find((o) => o.Name === name)?.Size ?? null
}

export function uploadOne(file: string, key: string): 'uploaded' | 'skipped' {
  const headers = objectHeaders(key)
  if (!headers) throw new Error(`${key} isn't a key in the bucket layout (docs/hosting-r2.md §2)`)
  const size = statSync(file).size
  if (headers.immutable) {
    const there = remoteSize(key)
    if (there === size) {
      console.log(`skip    ${key} (already uploaded, ${size} bytes)`)
      return 'skipped'
    }
    if (there !== null) {
      throw new Error(`${key} already exists with a different size (${there} bytes). Immutable keys are never replaced: publish under a new name.`)
    }
  }
  console.log(`upload  ${key} (${(size / 1e6).toFixed(1)} MB, ${headers.cacheControl})`)
  rclone(
    [
      'copyto',
      file,
      `${REMOTE}:${BUCKET}/${key}`,
      '--s3-no-check-bucket',
      '--header-upload',
      `Cache-Control: ${headers.cacheControl}`,
      '--header-upload',
      `Content-Type: ${headers.contentType}`,
      '--stats-one-line',
      '--stats=10s',
    ],
    true,
  )
  const there = remoteSize(key)
  if (there !== size) throw new Error(`${key}: the bucket has ${there} bytes, expected ${size}`)
  return 'uploaded'
}

/** Upload a built pack folder: its PMTiles first, pack.json last (a reader never sees a manifest before its files). */
export function uploadPack(dir: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) as { id?: string; files?: { name: string }[] }
  if (!manifest.id) throw new Error(`${dir}/pack.json has no id`)
  const names = manifest.files?.map((f) => f.name) ?? readdirSync(dir).filter((n) => n.endsWith('.pmtiles'))
  for (const name of names) uploadOne(join(dir, name), `packs/${manifest.id}/${basename(name)}`)
  uploadOne(join(dir, 'pack.json'), `packs/${manifest.id}/pack.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' })
  } catch {
    console.error('rclone not found. Install it with: brew install rclone')
    process.exit(2)
  }
  try {
    checkRemote()
    if (args[0] === '--pack' && args[1]) uploadPack(args[1])
    else if (args.length === 2) uploadOne(args[0], args[1])
    else {
      console.error('usage: node scripts/packs/upload.ts <file> <key>  |  --pack <pack folder>')
      process.exit(2)
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
