// jsdom (a dev dependency, used by the tests) ships no types. The pack
// builder only needs its XML parser to read KML perimeters.
declare module 'jsdom' {
  export class JSDOM {
    constructor(text: string, options?: { contentType?: string })
    window: { document: unknown }
  }
}
