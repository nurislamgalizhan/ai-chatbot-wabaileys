import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { BufferJSON, downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import type { FastifyBaseLogger } from "fastify";
import type { Sealer } from "../security/crypto.ts";

type MediaCtx = NonNullable<Parameters<typeof downloadMediaMessage>[3]>;

/** Types we are willing to render inline in the browser — decided by the
 *  file's own bytes, never by the mimetype the sender claims. */
export const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
]);

export function sniff(buf: Buffer): string {
  const b = buf;
  const ascii = (start: number, s: string) => b.length >= start + s.length && b.toString("latin1", start, start + s.length) === s;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "ID3") || (b.length > 1 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(4, "ftyp")) {
    const brand = b.toString("latin1", 8, 12);
    return brand.startsWith("M4A") ? "audio/mp4" : "video/mp4";
  }
  if (ascii(0, "%PDF-")) return "application/pdf";
  return "application/octet-stream";
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

const FILE_RE = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

export class MediaStore {
  private readonly root: string;
  private readonly sealer: Sealer;
  private readonly log: FastifyBaseLogger;
  readonly maxBytes: number;

  constructor(opts: { dataDir: string; sealer: Sealer; log: FastifyBaseLogger; maxMb: number }) {
    this.root = resolve(opts.dataDir, "media");
    this.sealer = opts.sealer;
    this.log = opts.log;
    this.maxBytes = opts.maxMb * 1024 * 1024;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private userDir(userId: number): string {
    return join(this.root, `u${Math.trunc(userId)}`);
  }

  /** Server-generated names only; anything else is refused (no traversal). */
  path(userId: number, file: string): string | null {
    if (!FILE_RE.test(file)) return null;
    const p = resolve(this.userDir(userId), file);
    return p.startsWith(this.userDir(userId) + sep) ? p : null;
  }

  save(userId: number, buf: Buffer): { file: string; mime: string; size: number } {
    const mime = sniff(buf);
    const dir = this.userDir(userId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${randomBytes(16).toString("hex")}.${EXT[mime] ?? "bin"}`;
    writeFileSync(join(dir, file), buf, { mode: 0o600 });
    return { file, mime, size: buf.length };
  }

  remove(userId: number, file: string | null) {
    const p = file ? this.path(userId, file) : null;
    if (p) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }

  removeUser(userId: number) {
    rmSync(this.userDir(userId), { recursive: true, force: true });
  }

  size(userId: number, file: string): number | null {
    const p = this.path(userId, file);
    if (!p) return null;
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  }

  /** The WhatsApp message (incl. media keys) for downloading later — sealed. */
  sealRef(msg: WAMessage): Uint8Array {
    const minimal = { key: msg.key, message: msg.message, messageTimestamp: msg.messageTimestamp };
    return this.sealer.seal(Buffer.from(JSON.stringify(minimal, BufferJSON.replacer), "utf8"));
  }

  openRef(blob: Uint8Array): WAMessage | null {
    try {
      return JSON.parse(this.sealer.open(blob).toString("utf8"), BufferJSON.reviver) as WAMessage;
    } catch {
      return null;
    }
  }

  /** Download from WhatsApp (asking the phone to re-upload expired media). */
  async download(sock: WASocket, msg: WAMessage): Promise<Buffer> {
    const buf = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: this.log as unknown as MediaCtx["logger"], reuploadRequest: sock.updateMediaMessage },
    );
    if (buf.length > this.maxBytes) throw new Error("media too large");
    return buf;
  }
}
