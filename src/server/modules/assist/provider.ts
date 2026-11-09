import "server-only";

/**
 * The language-model provider behind the hiring and helpdesk assistants. One interface, one real implementation
 * (Anthropic's Messages API over HTTPS), and a clear "not configured" state when ANTHROPIC_API_KEY is missing: every
 * caller then uses its rule-based fallback, so the features keep working offline.
 *
 * Calls are made outside database transactions (they can take several seconds) and always time out.
 */
export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** One request, one structured JSON answer that matches `schema`. Throws LlmError on any failure. */
  json<T>(req: { system: string; prompt: string; schema: JsonSchema; maxTokens?: number }): Promise<T>;
}

export class LlmError extends Error {
  constructor(message: string, readonly kind: "http" | "timeout" | "refusal" | "truncated" | "parse") { super(message); }
}

export const CLAUDE_MODEL = "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 45_000;

type MessagesResponse = { content?: { type: string; text?: string }[]; stop_reason?: string; error?: { message?: string } };

export class ClaudeProvider implements LlmProvider {
  readonly name = "Claude";
  constructor(private apiKey: string, readonly model = CLAUDE_MODEL, private fetchImpl: typeof fetch = fetch) {}

  async json<T>(req: { system: string; prompt: string; schema: JsonSchema; maxTokens?: number }): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 4000,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
          output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new LlmError(timeout ? "The AI service took too long to answer." : "Couldn't reach the AI service.", timeout ? "timeout" : "http");
    }
    const body = (await res.json().catch(() => ({}))) as MessagesResponse;
    if (!res.ok) throw new LlmError(`The AI service answered ${res.status}${body.error?.message ? `: ${body.error.message.slice(0, 200)}` : ""}.`, "http");
    if (body.stop_reason === "refusal") throw new LlmError("The AI service declined this request.", "refusal");
    if (body.stop_reason === "max_tokens") throw new LlmError("The AI answer was cut short.", "truncated");
    const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    try { return JSON.parse(text) as T; } catch { throw new LlmError("The AI answer wasn't in the expected shape.", "parse"); }
  }
}

declare global { var __erpLlm: LlmProvider | null | undefined }

/** The configured provider, or null when no API key is set (callers fall back to rules). Tests can swap it in. */
export function llm(): LlmProvider | null {
  if (globalThis.__erpLlm !== undefined) return globalThis.__erpLlm;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? new ClaudeProvider(key) : null;
}

/** For smoke tests: force a provider (or null for "not configured"); undefined restores the env-based default. */
export function setLlmForTesting(p: LlmProvider | null | undefined) { globalThis.__erpLlm = p; }

export const aiConfigured = () => llm() !== null;
