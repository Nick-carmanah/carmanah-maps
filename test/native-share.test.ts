// @vitest-environment jsdom
/**
 * Sharing inside the crew app's store build (src/lib/export.ts,
 * shareNatively): the file goes to Cache through the Filesystem plugin, its
 * URI to the Share plugin, and the copy is deleted afterwards. The plugins
 * are faked here; the real ones were run in the iOS simulator
 * (docs/crew-app-handoff.md).
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shareNatively, shareOrDownload } from '../src/lib/export'

interface Call {
  method: string
  options: Record<string, unknown>
}

function fakeCapacitor(opts: { shareError?: Error; native?: boolean; bridgeOnly?: boolean } = {}) {
  const calls: Call[] = []
  const files = new Map<string, string>()
  const record = (method: string) => async (options: Record<string, unknown>) => {
    calls.push({ method, options })
    if (method === 'writeFile') files.set(options.path as string, options.data as string)
    if (method === 'appendFile') files.set(options.path as string, files.get(options.path as string)! + '|' + options.data)
    if (method === 'writeFile') return { uri: `file:///cache/${options.path}` }
    if (method === 'share' && opts.shareError) throw opts.shareError
    return {}
  }
  const Filesystem = {
    writeFile: record('writeFile'),
    appendFile: record('appendFile'),
    rmdir: record('rmdir'),
  }
  const Share = { share: record('share') }
  const registered: string[] = []
  const plugins: Record<string, Record<string, (o: Record<string, unknown>) => Promise<unknown>>> = { Filesystem, Share }
  ;(globalThis as Record<string, unknown>).Capacitor = {
    isNativePlatform: () => opts.native ?? true,
    convertFileSrc: (uri: string) => uri,
    PluginHeaders: [{ name: 'Filesystem' }, { name: 'Share' }],
    // The crew app's /capacitor.js registers nothing: plugins come from registerPlugin.
    Plugins: {},
    ...(opts.bridgeOnly
      ? {
          // No /capacitor.js: only the native bridge's call.
          nativePromise: (plugin: string, method: string, options: Record<string, unknown>) =>
            plugins[plugin][method](options),
        }
      : {
          registerPlugin: (name: string) => {
            registered.push(name)
            return plugins[name]
          },
        }),
  }
  return { calls, files, registered }
}

const decode = (b64: string) => atob(b64)

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).Capacitor
})

describe('shareNatively', () => {
  it('is null outside the store app', async () => {
    expect(await shareNatively(new File(['x'], 'a.kmz'))).toBeNull()
    fakeCapacitor({ native: false })
    expect(await shareNatively(new File(['x'], 'a.kmz'))).toBeNull()
  })

  it('writes to Cache, shares the URI, and removes the copy two minutes after a share', async () => {
    const { calls, files, registered } = fakeCapacitor()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const outcome = await shareNatively(new File(['<kml/>'], 'Fire edge.kml', { type: 'application/vnd.google-earth.kml+xml' }))
    expect(outcome).toBe('shared')
    expect(registered).toEqual(['Filesystem', 'Share'])

    const write = calls.find((c) => c.method === 'writeFile')!
    expect(write.options).toMatchObject({ directory: 'CACHE', recursive: true })
    expect(write.options.path).toMatch(/^shared\/maps-[0-9a-f]{24}\/Fire edge\.kml$/)
    expect(decode(files.get(write.options.path as string)!)).toBe('<kml/>')

    const share = calls.find((c) => c.method === 'share')!
    expect(share.options).toEqual({ title: 'Fire edge.kml', files: [`file:///cache/${write.options.path}`] })

    expect(calls.some((c) => c.method === 'rmdir')).toBe(false)
    const later = timers.mock.calls.find(([, ms]) => ms === 2 * 60 * 1000)
    expect(later).toBeDefined()
    ;(later![0] as () => void)()
    await Promise.resolve()
    const folder = (write.options.path as string).split('/').slice(0, 2).join('/')
    expect(calls.filter((c) => c.method === 'rmdir').map((c) => c.options)).toEqual([
      { path: folder, directory: 'CACHE', recursive: true },
    ])
  })

  it('removes the copy at once when the share is cancelled', async () => {
    const { calls } = fakeCapacitor({ shareError: new Error('Share canceled') })
    expect(await shareNatively(new File(['x'], 'a.gpx'))).toBe('cancelled')
    await Promise.resolve()
    expect(calls.map((c) => c.method)).toEqual(['writeFile', 'share', 'rmdir'])
  })

  it('removes the copy and throws when sharing fails', async () => {
    const { calls } = fakeCapacitor({ shareError: new Error('No activity found') })
    await expect(shareNatively(new File(['x'], 'a.csv'))).rejects.toThrow('No activity found')
    await Promise.resolve()
    expect(calls.map((c) => c.method)).toEqual(['writeFile', 'share', 'rmdir'])
  })

  it('writes a large file in pieces, each its own base64', async () => {
    const { calls, files } = fakeCapacitor()
    const size = 3 * 1024 * 1024 * 2 + 5
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) % 251
    await shareNatively(new File([bytes], 'map.pdf', { type: 'application/pdf' }))
    expect(calls.filter((c) => c.method === 'writeFile')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'appendFile')).toHaveLength(2)
    const stored = [...files.values()][0].split('|').map(decode).join('')
    expect(stored.length).toBe(size)
    expect(stored.charCodeAt(size - 1)).toBe(bytes[size - 1])
    expect(stored.charCodeAt(3 * 1024 * 1024)).toBe(bytes[3 * 1024 * 1024])
  })

  it('works through the native bridge alone, without /capacitor.js', async () => {
    const { calls } = fakeCapacitor({ bridgeOnly: true, shareError: new Error('Share canceled') })
    expect(await shareNatively(new File(['x'], 'a.kmz'))).toBe('cancelled')
    await Promise.resolve()
    expect(calls.map((c) => c.method)).toEqual(['writeFile', 'share', 'rmdir'])
  })

  it('makes a name the phone’s file system takes', async () => {
    const { calls } = fakeCapacitor()
    await shareNatively(new File(['x'], 'K61067: day 3/4?.kmz'))
    expect(calls[0].options.path).toMatch(/\/K61067- day 3-4-\.kmz$/)
  })
})

describe('shareOrDownload in the store app', () => {
  it('uses the native share sheet, not Web Share', async () => {
    const webShare = vi.fn()
    Object.assign(navigator, { share: webShare, canShare: () => true })
    const { calls } = fakeCapacitor()
    expect(await shareOrDownload('layer.kmz', 'application/vnd.google-earth.kmz', 'x')).toBe('shared')
    expect(webShare).not.toHaveBeenCalled()
    expect(calls.map((c) => c.method)).toEqual(['writeFile', 'share'])
  })
})
