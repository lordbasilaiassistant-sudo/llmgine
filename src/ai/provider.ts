/**
 * Provider-agnostic inference layer.
 *
 * The engine never asks for a model by name — it asks for a TIER:
 *   fast   — high-frequency cognition: NPC chatter, reactions (cheap/free)
 *   smart  — rare deep reasoning: boss tactics, quest generation
 *   vision — multimodal perception (pixel Eyes)
 * A game maps tiers → models once. Default mapping targets z.ai GLM
 * (OpenAI-compatible), but any OpenAI-compatible endpoint works: OpenAI,
 * Ollama, LM Studio, vLLM, llama.cpp server, etc.
 */

export type ModelTier = "fast" | "smart" | "vision";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments object ({} if the model emitted unparseable args). */
  args: Record<string, any>;
}

export interface ChatRequest {
  tier: ModelTier;
  messages: ChatMessage[];
  /** OpenAI-style tool definitions (see ActionRegistry.toToolSchema). */
  tools?: any[];
  temperature?: number;
  maxTokens?: number;
  /** Hint that the reply must be a single JSON value. */
  json?: boolean;
  /**
   * Allow extended reasoning ("thinking") on models that support it.
   * Default false — game cognition needs low latency, and reasoning models
   * (e.g. GLM flash) otherwise burn the token budget on hidden thought.
   */
  thinking?: boolean;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
}

export interface ChatProvider {
  readonly supportsVision: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface OpenAICompatibleConfig {
  /** e.g. https://api.z.ai/api/paas/v4 (default), https://api.openai.com/v1, http://localhost:11434/v1 */
  baseUrl?: string;
  apiKey?: string;
  models?: Partial<Record<ModelTier, string>>;
  /** Request timeout ms. Default 30000. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /**
   * Send the GLM/Zhipu `thinking` control field. Default: auto (true when the
   * baseUrl looks like z.ai/bigmodel, else false — other providers may reject
   * unknown fields).
   */
  thinkingControl?: boolean;
}

export const GLM_DEFAULTS: Record<ModelTier, string> = {
  fast: "glm-4.5-flash", // free tier on z.ai
  smart: "glm-4.5-flash", // upgrade to glm-4.6 etc. if your plan allows
  vision: "glm-4.5v",
};

const env = (k: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[k] : undefined;

/**
 * The single built-in provider: plain fetch against any OpenAI-compatible
 * /chat/completions endpoint. No SDKs.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly supportsVision = true;
  private baseUrl: string;
  private apiKey: string;
  private models: Record<ModelTier, string>;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private thinkingControl: boolean;

  constructor(cfg: OpenAICompatibleConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? env("LLM_BASE_URL") ?? "https://api.z.ai/api/paas/v4").replace(/\/$/, "");
    this.apiKey = cfg.apiKey ?? env("LLM_API_KEY") ?? env("ZAI_API_KEY") ?? "";
    this.models = { ...GLM_DEFAULTS, ...cfg.models };
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    // bind: calling window.fetch through a field throws "Illegal invocation" in browsers
    this.fetchFn = cfg.fetchFn ?? fetch.bind(globalThis);
    this.thinkingControl =
      cfg.thinkingControl ?? (/z\.ai|bigmodel/.test(this.baseUrl) ? true : false);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: this.models[req.tier],
      messages: req.messages,
      temperature: req.temperature ?? 0.8,
      max_tokens: req.maxTokens ?? 512,
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    if (req.json) body.response_format = { type: "json_object" };
    if (this.thinkingControl) {
      body.thinking = { type: req.thinking ? "enabled" : "disabled" };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data: any = await res.json();
      const choice = data.choices?.[0];
      const msg = choice?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          /* leave {} — repair below may still recover */
        }
        const repaired = repairToolCall(tc.function?.name ?? "", args, req.tools);
        return { id: tc.id ?? "", ...repaired };
      });
      // reasoning models may leave content empty and answer in reasoning_content
      const text =
        (typeof msg.content === "string" && msg.content.trim()) ||
        (typeof msg.reasoning_content === "string" ? msg.reasoning_content : "") ||
        "";
      return {
        text,
        toolCalls,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
        model: data.model ?? body.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Repair malformed tool calls. GLM flash sometimes crams the arguments into
 * the function NAME as XML, e.g. name: "say\n<arg_value>Halt!</arg_value>",
 * arguments: "{}". Recover the real name, and map <arg_key>/<arg_value> pairs
 * (or a single bare <arg_value> onto the tool's first required parameter,
 * resolved from the request's own tool schema).
 */
export function repairToolCall(
  rawName: string,
  args: Record<string, any>,
  tools?: any[],
): { name: string; args: Record<string, any> } {
  if (!/[<\n]/.test(rawName)) return { name: rawName, args };
  const name = (rawName.match(/^[\w-]+/) ?? [""])[0];
  const keys = [...rawName.matchAll(/<arg_key>([^<]*)<\/arg_key>/g)].map((m) => m[1].trim());
  const vals = [...rawName.matchAll(/<arg_value>([\s\S]*?)<\/arg_value>/g)].map((m) => m[1].trim());
  const out = { ...args };
  if (keys.length && keys.length === vals.length) {
    keys.forEach((k, i) => (out[k] = coerce(vals[i])));
  } else if (vals.length === 1) {
    const tool = tools?.find((t) => t?.function?.name === name);
    const param: string | undefined =
      tool?.function?.parameters?.required?.[0] ??
      Object.keys(tool?.function?.parameters?.properties ?? {})[0];
    if (param) out[param] = coerce(vals[0]);
  }
  return { name, args: out };
}

function coerce(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  return v !== "" && !isNaN(Number(v)) ? Number(v) : v;
}

/** Deterministic scripted provider for unit tests and offline demos. */
export class MockProvider implements ChatProvider {
  readonly supportsVision = false;
  calls: ChatRequest[] = [];
  private script: Array<Partial<ChatResponse> | Error>;

  constructor(script: Array<Partial<ChatResponse> | Error> = []) {
    this.script = script;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return {
      text: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      model: "mock",
      ...next,
    };
  }
}
