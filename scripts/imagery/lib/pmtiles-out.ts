// Write a PMTiles v3 archive from tiles that arrive in any order.
//
// Tiles go to a spool file as they're made (with an index line each, so an
// interrupted build can resume); finish() then writes the archive with the
// app's own writer (src/lib/pmtiles-writer.ts): header, directories,
// metadata, then tile data in tile-id order ("clustered"), and removes the
// spool.

import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs'
import { planPack, type PackHeaderInfo } from '../../../src/lib/pmtiles-writer.ts'

interface Spooled {
  z: number
  x: number
  y: number
  offset: number
  length: number
}

const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`

export class SpoolWriter {
  readonly path: string
  private readonly spoolPath: string
  private readonly indexPath: string
  private readonly spoolFd: number
  private readonly indexFd: number
  private spoolBytes = 0
  private readonly tiles = new Map<string, Spooled>()

  /** resume: keep tiles a previous run of the same build spooled. */
  constructor(path: string, resume: boolean) {
    this.path = path
    this.spoolPath = `${path}.spool`
    this.indexPath = `${path}.spool-index`
    if (resume && existsSync(this.spoolPath) && existsSync(this.indexPath)) {
      for (const line of readFileSync(this.indexPath, 'utf8').split('\n')) {
        const [z, x, y, offset, length] = line.split(' ').map(Number)
        if (line && Number.isFinite(length)) this.tiles.set(key(z, x, y), { z, x, y, offset, length })
      }
      // Only bytes some index line points at count; a torn last write is overwritten.
      for (const t of this.tiles.values()) this.spoolBytes = Math.max(this.spoolBytes, t.offset + t.length)
      this.spoolFd = openSync(this.spoolPath, 'r+')
      this.indexFd = openSync(this.indexPath, 'a')
    } else {
      this.spoolFd = openSync(this.spoolPath, 'w+')
      this.indexFd = openSync(this.indexPath, 'w')
    }
  }

  get count(): number {
    return this.tiles.size
  }

  get bytes(): number {
    return this.spoolBytes
  }

  has(z: number, x: number, y: number): boolean {
    return this.tiles.has(key(z, x, y))
  }

  read(z: number, x: number, y: number): Uint8Array | null {
    const t = this.tiles.get(key(z, x, y))
    if (!t) return null
    const buf = new Uint8Array(t.length)
    readSync(this.spoolFd, buf, 0, t.length, t.offset)
    return buf
  }

  add(z: number, x: number, y: number, data: Uint8Array): void {
    writeSync(this.spoolFd, data, 0, data.length, this.spoolBytes)
    const t = { z, x, y, offset: this.spoolBytes, length: data.length }
    this.spoolBytes += data.length
    this.tiles.set(key(z, x, y), t)
    writeSync(this.indexFd, `${z} ${x} ${y} ${t.offset} ${t.length}\n`)
  }

  /** Write the archive and remove the spool. */
  finish(info: PackHeaderInfo): { tiles: number; bytes: number } {
    const plan = planPack([...this.tiles.values()], info)
    const byId = new Map([...this.tiles.values()].map((t) => [key(t.z, t.x, t.y), t]))
    const tmp = `${this.path}.partial`
    const out = openSync(tmp, 'w')
    let pos = 0
    pos += writeSync(out, plan.prefix, 0, plan.prefix.length, pos)
    const buf = Buffer.alloc(1 << 20)
    for (const planned of plan.tiles) {
      const t = byId.get(key(planned.z, planned.x, planned.y))!
      const data = t.length <= buf.length ? buf.subarray(0, t.length) : Buffer.alloc(t.length)
      readSync(this.spoolFd, data, 0, t.length, t.offset)
      pos += writeSync(out, data, 0, t.length, pos)
    }
    closeSync(out)
    if (pos !== plan.totalLength) throw new Error(`wrote ${pos} bytes, planned ${plan.totalLength}`)
    closeSync(this.spoolFd)
    closeSync(this.indexFd)
    renameSync(tmp, this.path)
    rmSync(this.spoolPath)
    rmSync(this.indexPath)
    return { tiles: plan.tiles.length, bytes: plan.totalLength }
  }
}
