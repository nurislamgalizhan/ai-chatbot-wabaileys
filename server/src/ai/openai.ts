import OpenAI, { toFile } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Config } from "../config.ts";

export interface AgentReply {
  reply: string;
  handoff: boolean;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", description: "Сообщение клиенту в WhatsApp" },
    handoff: {
      type: "boolean",
      description: "true — диалог нужно передать живому менеджеру",
    },
  },
  required: ["reply", "handoff"],
} as const;

const isReasoningFamily = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model);

/**
 * Thin wrapper around the official SDK. The model gets no tools: it can
 * only produce text, so customer messages and KB content cannot make it
 * act on data, files or the network.
 */
export class Ai {
  private readonly client: OpenAI | null;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.client = cfg.OPENAI_API_KEY
      ? new OpenAI({
          apiKey: cfg.OPENAI_API_KEY,
          ...(cfg.OPENAI_BASE_URL ? { baseURL: cfg.OPENAI_BASE_URL } : {}),
          timeout: 60_000,
          maxRetries: 2,
        })
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  modelFor(quality: string): string {
    return quality === "quality" ? this.cfg.OPENAI_MODEL_QUALITY : this.cfg.OPENAI_MODEL;
  }

  private need(): OpenAI {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured");
    return this.client;
  }

  async reply(
    model: string,
    messages: ChatCompletionMessageParam[],
    verbosity: "low" | "medium" | "high",
  ): Promise<AgentReply> {
    const reasoning = isReasoningFamily(model);
    const res = await this.need().chat.completions.create({
      model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "whatsapp_reply", strict: true, schema: REPLY_SCHEMA },
      },
      max_completion_tokens: reasoning ? 4000 : 1200,
      ...(reasoning ? { verbosity } : {}),
      ...(reasoning && this.cfg.OPENAI_REASONING_EFFORT
        ? { reasoning_effort: this.cfg.OPENAI_REASONING_EFFORT }
        : {}),
    });
    const choice = res.choices[0];
    const raw = choice?.message?.content ?? "";
    let parsed: { reply?: unknown; handoff?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error(`model returned non-JSON output (finish_reason=${choice?.finish_reason})`);
    }
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    return {
      reply,
      handoff: parsed.handoff === true,
      model: res.model,
      tokensIn: res.usage?.prompt_tokens ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await this.need().embeddings.create({
        model: this.cfg.OPENAI_EMBEDDING_MODEL,
        input: batch,
      });
      for (const item of res.data.sort((a, b) => a.index - b.index)) {
        out.push(Float32Array.from(item.embedding));
      }
    }
    return out;
  }

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : mime.includes("mp4") ? "m4a" : "ogg";
    const file = await toFile(audio, `voice.${ext}`, { type: mime || "audio/ogg" });
    const res = await this.need().audio.transcriptions.create({
      model: this.cfg.OPENAI_TRANSCRIBE_MODEL,
      file,
    });
    return (res.text ?? "").trim();
  }
}
