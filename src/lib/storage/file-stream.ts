/**
 * A file as a web ReadableStream that reads only when the reader asks for more (pull-based). Node's Readable.toWeb
 * doesn't hold back: it reads the whole file into memory as fast as the disk allows, whatever the browser consumes —
 * a 200 MB film watched slowly then fills the server's memory and the container is killed mid-film. Server-only.
 */
import { open, type FileHandle } from "node:fs/promises";

const CHUNK = 256 * 1024;

/** Bytes start..end (inclusive), or the whole file. Closes the file when done or when the reader goes away. */
export function fileStream(file: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  let fh: FileHandle | null = null;
  let pos = range?.start ?? 0;
  const last = range?.end ?? Number.POSITIVE_INFINITY;
  const close = async () => { const h = fh; fh = null; await h?.close().catch(() => {}); };
  return new ReadableStream<Uint8Array>({
    async start() {
      fh = await open(file, "r");
    },
    async pull(controller) {
      try {
        if (!fh) return controller.close();
        const want = Math.min(CHUNK, last - pos + 1);
        if (want <= 0) { await close(); return controller.close(); }
        const buf = new Uint8Array(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead === 0) { await close(); return controller.close(); }
        pos += bytesRead;
        controller.enqueue(bytesRead === want ? buf : buf.subarray(0, bytesRead));
      } catch (e) {
        await close();
        controller.error(e);
      }
    },
    async cancel() {
      await close();
    },
  }, { highWaterMark: 4 }); // at most ~1 MB read ahead
}
