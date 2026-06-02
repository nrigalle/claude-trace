import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { COCKPIT_TERMINAL_HISTORY_DIR } from "../../../shared/config";

const DEFAULT_MAX_BYTES_PER_SESSION = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 8192;

export class CockpitTerminalHistoryStore {
  constructor(
    private readonly dir: string = COCKPIT_TERMINAL_HISTORY_DIR,
    private readonly maxBytesPerSession = DEFAULT_MAX_BYTES_PER_SESSION,
  ) {}

  append(sessionId: string, data: string): void {
    if (data.length === 0 || this.maxBytesPerSession <= 0) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(sessionId);
    fs.appendFileSync(file, data, "utf8");
    this.trim(file);
  }

  *read(sessionId: string): Iterable<string> {
    const file = this.fileFor(sessionId);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return;
    }
    try {
      const decoder = new StringDecoder("utf8");
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let read = fs.readSync(fd, buf, 0, buf.length, null);
      while (read > 0) {
        const decoded = decoder.write(buf.subarray(0, read));
        if (decoded.length > 0) yield decoded;
        read = fs.readSync(fd, buf, 0, buf.length, null);
      }
      const trailing = decoder.end();
      if (trailing.length > 0) yield trailing;
    } finally {
      fs.closeSync(fd);
    }
  }

  delete(sessionId: string): void {
    try {
      fs.unlinkSync(this.fileFor(sessionId));
    } catch {}
  }

  private trim(file: string): void {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= this.maxBytesPerSession) return;
    const keepBytes = Math.max(0, this.maxBytesPerSession);
    const buf = Buffer.allocUnsafe(keepBytes);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, keepBytes, size - keepBytes);
    } finally {
      fs.closeSync(fd);
    }
    const trimmed = buf.subarray(firstUtf8Boundary(buf));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, trimmed);
    fs.renameSync(tmp, file);
  }

  private fileFor(sessionId: string): string {
    const name = crypto.createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.dir, `${name}.log`);
  }
}

const firstUtf8Boundary = (buf: Buffer): number => {
  let i = 0;
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
};
