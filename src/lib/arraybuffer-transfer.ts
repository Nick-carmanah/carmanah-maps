// ArrayBuffer.prototype.transfer / transferToFixedLength for Safari < 17.4
// (iOS 16.4–17.3; iPhone 8, 8 Plus and X can't go past iOS 16.7).
//
// pdf.js's legacy worker calls buffer.transferToFixedLength() for every font
// it hands to the page, and doesn't polyfill it. On older Safari that call
// throws, pdf.js swallows the error as a warning, and the map is saved with
// its text missing. pdfjs-worker-setup.ts installs this inside the worker
// before pdf.js loads. (pdf.js 6.2 doesn't call .transfer(); it's here because
// it shares the code and a pdf.js update could start using it.)

const byteLengthOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!

/** The spec's ToIndex: a whole number from 0 to 2^53 − 1, else RangeError. */
function toIndex(value: unknown): number {
  const n = Math.trunc(Number(value)) || 0
  if (n < 0 || n > Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid array buffer length')
  return n
}

/** The spec's ArrayBufferCopyAndDetach. */
function copyAndDetach(buffer: ArrayBuffer, newLength: unknown, keepResizable: boolean): ArrayBuffer {
  // Throws TypeError, as the native methods do, unless `buffer` is a
  // (non-shared) ArrayBuffer.
  const oldLength: number = byteLengthOf.call(buffer)
  const length = newLength === undefined ? oldLength : toIndex(newLength)
  // Throws TypeError if `buffer` is already detached.
  const source = new Uint8Array(buffer)
  const { resizable, maxByteLength } = buffer as ArrayBuffer & { resizable?: boolean; maxByteLength?: number }
  const result =
    keepResizable && resizable
      ? new (ArrayBuffer as new (n: number, o: { maxByteLength?: number }) => ArrayBuffer)(length, { maxByteLength })
      : new ArrayBuffer(length)
  new Uint8Array(result).set(length < oldLength ? source.subarray(0, length) : source)
  // Detach the original, as the native methods do. Callers only rely on the
  // returned copy, so if this ever fails the result is still correct.
  try {
    structuredClone(buffer, { transfer: [buffer] })
  } catch {
    /* best effort */
  }
  return result
}

/** Adds the methods where they're missing; returns the names it added. */
export function installArrayBufferTransfer(): string[] {
  const added: string[] = []
  const methods = {
    transfer(this: ArrayBuffer, ...args: unknown[]) {
      return copyAndDetach(this, args[0], true)
    },
    transferToFixedLength(this: ArrayBuffer, ...args: unknown[]) {
      return copyAndDetach(this, args[0], false)
    },
  }
  for (const [name, fn] of Object.entries(methods)) {
    if (typeof (ArrayBuffer.prototype as unknown as Record<string, unknown>)[name] === 'function') continue
    // Same shape as a built-in method: writable, configurable, not enumerable.
    Object.defineProperty(ArrayBuffer.prototype, name, { value: fn, writable: true, configurable: true })
    added.push(name)
  }
  return added
}
