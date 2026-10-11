// Minimal typings for yazl 3.x (the package ships none) — only the surface
// routes/folder-zip.ts uses.
declare module 'yazl' {
  import type { Readable } from 'node:stream'

  interface EntryOptions {
    mtime?: Date
    mode?: number
    compress?: boolean
  }

  export class ZipFile {
    readonly outputStream: Readable
    addReadStreamLazy(
      metadataPath: string,
      options: EntryOptions,
      getReadStream: (cb: (err: Error | null, stream: Readable) => void) => void,
    ): void
    addBuffer(buffer: Buffer, metadataPath: string, options?: EntryOptions): void
    addEmptyDirectory(metadataPath: string, options?: Omit<EntryOptions, 'compress'>): void
    end(): void
    on(event: 'error', listener: (err: Error) => void): this
  }
}
