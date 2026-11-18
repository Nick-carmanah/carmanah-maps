/**
 * Who owns the maps on this page, and where their files may go. Both guard
 * shared phones: one person must never read another's maps, and nothing in a
 * hand-off or a stored path may reach outside `maps/<ownerId>/`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GUEST_OWNER, MAPS_CONTEXT_KEY, parseMapsContext, readMapsContext } from '../src/lib/storage/owner'
import { pathSegments } from '../src/lib/storage/files'

const handOff = (value: unknown) => JSON.stringify(value)

describe('parseMapsContext', () => {
  it('reads the owner and fire from a good hand-off', () => {
    expect(parseMapsContext(handOff({ ownerId: 'u123', fireNumber: 'K61067', callSign: '2P14' }))).toEqual({
      ownerId: 'u123',
      fireNumber: 'K61067',
    })
  })

  it('accepts every file-name-safe owner id up to 64 characters', () => {
    for (const id of ['guest', 'u1', 'A-b_9', 'x'.repeat(64)]) {
      expect(parseMapsContext(handOff({ ownerId: id })).ownerId).toBe(id)
    }
  })

  it('takes the fire number from the other spellings, trimmed and clipped', () => {
    expect(parseMapsContext(handOff({ ownerId: 'u1', fire_number: 'V12345' })).fireNumber).toBe('V12345')
    expect(parseMapsContext(handOff({ ownerId: 'u1', fire: '  G70422  ' })).fireNumber).toBe('G70422')
    expect(parseMapsContext(handOff({ ownerId: 'u1', fireNumber: 'F'.repeat(100) })).fireNumber).toBe('F'.repeat(40))
  })

  it('leaves the fire out when it is blank or not text', () => {
    for (const fireNumber of ['', '   ', 42, null, ['K1'], { n: 'K1' }]) {
      expect(parseMapsContext(handOff({ ownerId: 'u1', fireNumber })).fireNumber).toBeUndefined()
    }
  })

  it('runs as guest with no hand-off', () => {
    expect(parseMapsContext(null)).toEqual({ ownerId: GUEST_OWNER, fireNumber: undefined })
    expect(parseMapsContext('')).toEqual({ ownerId: GUEST_OWNER, fireNumber: undefined })
  })

  it('runs as guest when the hand-off is not a JSON object', () => {
    for (const raw of ['not json', '{', 'null', '42', '"u123"', '["u123"]', 'true']) {
      expect(parseMapsContext(raw).ownerId, raw).toBe(GUEST_OWNER)
    }
  })

  it('runs as guest when the owner id is missing or unsafe', () => {
    const bad: unknown[] = [
      undefined,
      123,
      null,
      '',
      'x'.repeat(65),
      '..',
      '.',
      '../u123',
      'u123/..',
      'a/b',
      'a\\b',
      'u 123',
      'u123\n',
      'ü123',
      '%2e%2e',
      { id: 'u1' },
    ]
    for (const ownerId of bad) {
      expect(parseMapsContext(handOff({ ownerId, fireNumber: 'K1' })).ownerId, String(ownerId)).toBe(GUEST_OWNER)
    }
  })

  it('keeps a valid fire number even when the owner falls back to guest', () => {
    expect(parseMapsContext(handOff({ ownerId: '../x', fireNumber: 'K1' }))).toEqual({ ownerId: GUEST_OWNER, fireNumber: 'K1' })
  })
})

describe('readMapsContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the crew app key', () => {
    const getItem = vi.fn(() => handOff({ ownerId: 'u7' }))
    vi.stubGlobal('localStorage', { getItem })
    expect(readMapsContext().ownerId).toBe('u7')
    expect(getItem).toHaveBeenCalledWith(MAPS_CONTEXT_KEY)
  })

  it('runs as guest when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(readMapsContext().ownerId).toBe(GUEST_OWNER)
  })
})

describe('pathSegments', () => {
  it('splits a normal path', () => {
    expect(pathSegments('library/maps/abc-123/map.pmtiles')).toEqual(['library', 'maps', 'abc-123', 'map.pmtiles'])
    expect(pathSegments('library/originals/9f2c_x.pdf')).toEqual(['library', 'originals', '9f2c_x.pdf'])
  })

  it('rejects parent and current directory segments', () => {
    for (const path of ['..', '.', '../x', 'x/..', 'library/../../u2/library', 'library/./maps', 'a/../b']) {
      expect(() => pathSegments(path), path).toThrow(/bad storage path/)
    }
  })

  it('rejects empty segments (empty path, leading, trailing or double slash)', () => {
    for (const path of ['', '/', '/library', 'library/', 'library//maps']) {
      expect(() => pathSegments(path), JSON.stringify(path)).toThrow(/bad storage path/)
    }
  })

  it('rejects anything outside letters, digits, dot, dash and underscore', () => {
    for (const path of ['a\\..\\b', 'my map.pdf', 'a:b', 'ü.pdf', 'a\0b', '%2e%2e/x', 'a?b', '~/x']) {
      expect(() => pathSegments(path), JSON.stringify(path)).toThrow(/bad storage path/)
    }
  })
})
