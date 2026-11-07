import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.ts";
import { hasAiAccess } from "../services/access.ts";
import type { Ai } from "./openai.ts";

/** Below this size the whole knowledge base fits the prompt: no retrieval
 *  mistakes, and still cheap. Above it we switch to embedding search. */
export const FULL_CONTEXT_CHARS = 14_000;
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 120;
const TOP_K = 6;

export interface KbSnippet {
  entry_id: number;
  title: string;
  content: string;
}

export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const paragraphs = clean.split(/\n\n/);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const p of paragraphs) {
    if (p.length > CHUNK_CHARS) {
      flush();
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        chunks.push(p.slice(i, i + CHUNK_CHARS).trim());
      }
      continue;
    }
    if (current.length + p.length + 2 > CHUNK_CHARS) {
      const tail = current.slice(-CHUNK_OVERLAP);
      flush();
      current = tail ? `${tail}\n\n` : "";
    }
    current += `${p}\n\n`;
  }
  flush();
  return chunks;
}

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(Uint8Array.from(b).buffer);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

export class KnowledgeBase {
  private readonly db: Db;
  private readonly ai: Ai;
  private readonly log: FastifyBaseLogger;
  private readonly cache = new Map<number, { chunks: { entry_id: number; title: string; content: string; vec: Float32Array | null }[] }>();

  constructor(db: Db, ai: Ai, log: FastifyBaseLogger) {
    this.db = db;
    this.ai = ai;
    this.log = log;
  }

  invalidate(userId: number) {
    this.cache.delete(userId);
  }

  /** Re-chunks and re-embeds one entry. Safe to call fire-and-forget. */
  async index(userId: number, entryId: number): Promise<void> {
    const entry = this.db.get<{ title: string; content: string; kind: string; updated_at: number }>(
      "SELECT title, content, kind, updated_at FROM kb_entries WHERE id = ? AND user_id = ?",
      entryId,
      userId,
    );
    if (!entry) return;
    const base = entry.kind === "faq" ? `Вопрос: ${entry.title}\nОтвет: ${entry.content}` : entry.content;
    const pieces = chunkText(base).map((c) => (entry.kind === "doc" ? `${entry.title}\n${c}` : c));
    let vectors: (Float32Array | null)[] = pieces.map(() => null);
    let state = "ready";
    // Embeddings are a paid OpenAI call: only for accounts with AI access.
    // Without it the entry is still searchable by keywords.
    if (this.ai.enabled && pieces.length > 0 && hasAiAccess(this.db, userId)) {
      try {
        vectors = await this.ai.embed(pieces);
      } catch (err) {
        this.log.warn({ err, entryId }, "embedding failed; keyword search fallback");
        state = "error";
      }
    }
    this.db.tx(() => {
      // The entry may have been edited while we were embedding.
      const still = this.db.get<{ updated_at: number }>(
        "SELECT updated_at FROM kb_entries WHERE id = ? AND user_id = ?",
        entryId,
        userId,
      );
      if (!still || still.updated_at !== entry.updated_at) return;
      this.db.run("DELETE FROM kb_chunks WHERE entry_id = ?", entryId);
      pieces.forEach((content, idx) => {
        const vec = vectors[idx];
        this.db.run(
          "INSERT INTO kb_chunks (entry_id, user_id, idx, content, embedding) VALUES (?, ?, ?, ?, ?)",
          entryId,
          userId,
          idx,
          content,
          vec ? toBlob(vec) : null,
        );
      });
      this.db.run("UPDATE kb_entries SET index_state = ? WHERE id = ?", state, entryId);
    });
    this.invalidate(userId);
  }

  /** After access is granted: embed entries that were saved without it. */
  async reindexMissing(userId: number): Promise<void> {
    const rows = this.db.all<{ id: number }>(
      `SELECT DISTINCT e.id FROM kb_entries e
         LEFT JOIN kb_chunks c ON c.entry_id = e.id
        WHERE e.user_id = ? AND (c.id IS NULL OR c.embedding IS NULL)`,
      userId,
    );
    for (const r of rows) await this.index(userId, r.id);
  }

  /** Context for one question: everything when small, top-k otherwise. */
  async retrieve(userId: number, query: string): Promise<KbSnippet[]> {
    const entries = this.db.all<{ id: number; kind: string; title: string; content: string }>(
      "SELECT id, kind, title, content FROM kb_entries WHERE user_id = ? AND is_active = 1 ORDER BY kind DESC, id",
      userId,
    );
    const total = entries.reduce((n, e) => n + e.title.length + e.content.length, 0);
    if (total <= FULL_CONTEXT_CHARS) {
      return entries.map((e) => ({ entry_id: e.id, title: e.title, content: e.content }));
    }

    let cached = this.cache.get(userId);
    if (!cached) {
      const rows = this.db.all<{ entry_id: number; title: string; content: string; embedding: Uint8Array | null }>(
        `SELECT c.entry_id, e.title, c.content, c.embedding
           FROM kb_chunks c JOIN kb_entries e ON e.id = c.entry_id
          WHERE c.user_id = ? AND e.is_active = 1`,
        userId,
      );
      cached = {
        chunks: rows.map((r) => ({
          entry_id: r.entry_id,
          title: r.title,
          content: r.content,
          vec: r.embedding ? fromBlob(r.embedding) : null,
        })),
      };
      this.cache.set(userId, cached);
    }

    let scored: { score: number; c: (typeof cached.chunks)[number] }[] = [];
    const withVectors = cached.chunks.filter((c) => c.vec);
    if (this.ai.enabled && withVectors.length > 0) {
      try {
        const [q] = await this.ai.embed([query.slice(0, 2000)]);
        if (q) scored = withVectors.map((c) => ({ score: cosine(q, c.vec!), c }));
      } catch (err) {
        this.log.warn({ err }, "query embedding failed; keyword fallback");
      }
    }
    if (scored.length === 0) {
      const words = new Set(tokenize(query));
      scored = cached.chunks.map((c) => {
        const tokens = tokenize(c.content);
        const hits = tokens.filter((t) => words.has(t)).length;
        return { score: hits / Math.sqrt(tokens.length + 1), c };
      });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(({ c }) => ({ entry_id: c.entry_id, title: c.title, content: c.content }));
  }
}
