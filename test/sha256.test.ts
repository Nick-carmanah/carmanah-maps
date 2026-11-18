import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Sha256, sha256Hex } from '../src/lib/sha256'

describe('incremental sha256', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('matches node:crypto for every size around block edges, fed in odd pieces', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 70_001]) {
      const data = new Uint8Array(n)
      for (let i = 0; i < n; i++) data[i] = (i * 131 + n) & 0xff
      const h = new Sha256()
      for (let at = 0; at < n; at += 37) h.update(data.subarray(at, at + 37))
      expect(h.hex(), `n=${n}`).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })
})
