import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { COCKPIT_TERMINAL_HISTORY_DIR } from "../../../shared/config";

const DEFAULT_MAX_BYTES_PER_SESSION = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 8192;
const REPLAY_SEGMENT_CHARS = 65536;

interface RingChunk {
  readonly data: string;
  readonly bytes: number;
}

interface SessionRing {
  chunks: RingChunk[];
  bytes: number;
}

export class CockpitTerminalHistoryStore {
  private readonly rings = new Map<string, SessionRing>();

  constructor(
    private readonly dir: string = COCKPIT_TERMINAL_HISTORY_DIR,
    private readonly maxBytesPerSession = DEFAULT_MAX_BYTES_PER_SESSION,
  ) {}

  append(sessionId: string, data: string): void {
    if (data.length === 0 || this.maxBytesPerSession <= 0) return;
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = { chunks: [], bytes: 0 };
      this.rings.set(sessionId, ring);
    }
    const bytes = Buffer.byteLength(data, "utf8");
    ring.chunks.push({ data, bytes });
    ring.bytes += bytes;
    this.evict(ring);
  }

  private evict(ring: SessionRing): void {
    while (ring.bytes > this.maxBytesPerSession) {
      const head = ring.chunks[0]!;
      const excess = ring.bytes - this.maxBytesPerSession;
      if (head.bytes <= excess) {
        ring.chunks.shift();
        ring.bytes -= head.bytes;
        continue;
      }
      const kept = sliceTailBytes(head.data, head.bytes - excess);
      ring.bytes -= head.bytes - kept.bytes;
      ring.chunks[0] = kept;
    }
  }

  *read(sessionId: string): Iterable<string> {
    const ring = this.rings.get(sessionId);
    if (ring && ring.chunks.length > 0) {
      const all = ring.chunks.map((c) => c.data).join("");
      for (let i = 0; i < all.length; i += REPLAY_SEGMENT_CHARS) {
        yield all.slice(i, i + REPLAY_SEGMENT_CHARS);
      }
      return;
    }
    yield* this.readFile(sessionId);
  }

  private *readFile(sessionId: string): Iterable<string> {
    const file = this.fileFor(sessionId);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      let position = Math.max(0, size - this.maxBytesPerSession);
      let skipBoundary = position > 0;
      const decoder = new StringDecoder("utf8");
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let read = fs.readSync(fd, buf, 0, buf.length, position);
      while (read > 0) {
        position += read;
        let chunk = buf.subarray(0, read);
        if (skipBoundary) {
          chunk = chunk.subarray(firstUtf8Boundary(chunk));
          skipBoundary = false;
        }
        const decoded = decoder.write(chunk);
        if (decoded.length > 0) yield decoded;
        read = fs.readSync(fd, buf, 0, buf.length, position);
      }
      const trailing = decoder.end();
      if (trailing.length > 0) yield trailing;
    } finally {
      fs.closeSync(fd);
    }
  }

  persistSession(sessionId: string): void {
    const ring = this.rings.get(sessionId);
    if (!ring || ring.chunks.length === 0) return;
    const payload = ring.chunks.map((c) => c.data).join("");
    void this.writeAtomicAsync(sessionId, payload);
  }

  flushAll(): void {
    for (const [sessionId, ring] of this.rings) {
      if (ring.chunks.length === 0) continue;
      this.writeAtomicSync(sessionId, ring.chunks.map((c) => c.data).join(""));
    }
  }

  delete(sessionId: string): void {
    this.rings.delete(sessionId);
    try {
      fs.unlinkSync(this.fileFor(sessionId));
    } catch {}
  }

  private async writeAtomicAsync(sessionId: string, payload: string): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const file = this.fileFor(sessionId);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, payload, "utf8");
      await fs.promises.rename(tmp, file);
    } catch {}
  }

  private writeAtomicSync(sessionId: string, payload: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(sessionId);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, file);
    } catch {}
  }

  private fileFor(sessionId: string): string {
    const name = crypto.createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.dir, `${name}.log`);
  }
}

const sliceTailBytes = (data: string, maxBytes: number): RingChunk => {
  const buf = Buffer.from(data, "utf8");
  if (buf.length <= maxBytes) return { data, bytes: buf.length };
  const tail = buf.subarray(buf.length - maxBytes);
  const aligned = tail.subarray(firstUtf8Boundary(tail));
  return { data: aligned.toString("utf8"), bytes: aligned.length };
};

const firstUtf8Boundary = (buf: Buffer): number => {
  let i = 0;
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
};
