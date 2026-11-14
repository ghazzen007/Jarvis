import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { state, commit, uid, type Effort, type Profile, type Session } from "./store";
import { TOOLS, TOOL_LABELS, runTool, type ToolUI } from "./tools";
import { buildSystemPrompt, contextMessage } from "./prompt";

type MsgParam = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — smartest (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — fast & capable" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — fastest & cheapest" },
];

// Server-side refusal fallback is available on these models.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const MAX_MESSAGES = 140;
const MAX_LOOPS = 14;

let client: Anthropic | null = null;
let clientKey = "";

function getClient(): Anthropic {
  const key = state.settings.apiKey.trim();
  if (!key) throw new NoKeyError();
  if (!client || key !== clientKey) {
    // Personal app: the key lives only on this device and goes straight to Anthropic.
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

export class NoKeyError extends Error {
  constructor() {
    super("No API key yet. Open Profile → Settings and paste your Claude API key.");
  }
}

function newSession(extraSystem = ""): Session {
  return {
    id: uid(),
    system: buildSystemPrompt() + extraSystem,
    messages: [],
    display: state.session?.display.slice(-200) ?? [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Starts a fresh conversation (the visible log is kept). */
export function resetSession(clearLog = false) {
  state.session = newSession();
  if (clearLog) state.session.display = [];
  commit("session");
}

function ensureSession(): Session {
  const s = state.session;
  if (!s || Date.now() - s.updatedAt > SESSION_IDLE_MS) {
    state.session = newSession();
    commit("session");
  }
  return state.session!;
}

/** Profile edits mid-session are appended (never rewritten) so the cached prefix and thinking stay valid. */
export function noteProfileChanged() {
  const s = state.session;
  if (!s || s.messages.length === 0) {
    if (s) s.system = buildSystemPrompt();
    return;
  }
  pendingSystemNotes.push("The user updated their profile. Use this from now on:\n" + buildSystemPrompt().split("# The user's profile")[1]);
}
const pendingSystemNotes: string[] = [];

export interface AskHooks {
  ui: ToolUI;
  onText(delta: string): void;
  onActivity(label: string | null): void;
  onSources(items: { title: string; url: string }[]): void;
}

let controller: { abort(): void } | null = null;

export function interrupt() {
  controller?.abort();
}

export function isBusy() {
  return controller !== null;
}

function requestParams(s: Session, effort: Effort) {
  const model = state.settings.model;
  const betas: Anthropic.Beta.AnthropicBeta[] = ["thinking-binding-controls-2026-08-01"];
  const extra: { fallbacks?: "default" } = {};
  if (FALLBACK_MODELS.has(model)) {
    betas.push("server-side-fallback-2026-07-01");
    extra.fallbacks = "default"; // re-runs on a suitable model if a safety classifier declines
  }
  return {
    model,
    max_tokens: effort === "high" ? 48000 : 20000,
    system: [{ type: "text" as const, text: s.system, cache_control: { type: "ephemeral" as const } }],
    tools: TOOLS,
    messages: s.messages,
    cache_control: { type: "ephemeral" as const },
    // Thinking is always on; effort sets depth. If an old thinking block can't be
    // verified, drop it instead of failing the request.
    thinking: { type: "adaptive" as const, block_binding: { prefix_mismatch_behavior: "drop_block" as const } },
    output_config: { effort },
    betas,
    ...extra,
  };
}

async function compactIfNeeded(s: Session): Promise<Session> {
  if (s.messages.length < MAX_MESSAGES) return s;
  // Simple compaction: summarise the whole conversation into the next session's system prompt.
  const transcript = s.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join(" ");
      return `${m.role.toUpperCase()}: ${c}`;
    })
    .join("\n")
    .slice(-60000);
  let summary = "";
  try {
    const r = await getClient().messages.create({
      model: state.settings.model,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `Summarise this conversation between a user and their assistant JARVIS so JARVIS can continue seamlessly. Keep commitments, open questions, names, numbers, dates and decisions. Under 300 words.\n\n${transcript}`,
        },
      ],
    });
    summary = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  } catch {
    summary = "(Earlier conversation could not be summarised.)";
  }
  state.session = newSession(`\n\n# Earlier in this conversation\n${summary}`);
  commit("session");
  return state.session;
}

/**
 * Send one user turn and run the tool loop to completion, streaming text.
 * Returns the final visible text.
 */
export async function ask(content: string | Block[], hooks: AskHooks, effortOverride?: Effort): Promise<string> {
  const api = getClient();
  let s = await compactIfNeeded(ensureSession());
  const effort = effortOverride ?? state.settings.effort;
  const start = s.messages.length;

  const userBlocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  s.messages.push({ role: "user", content: userBlocks });
  const notes = pendingSystemNotes.splice(0).join("\n\n");
  // Volatile context goes in an appended system message, never into the frozen prompt.
  s.messages.push({ role: "system", content: (notes ? notes + "\n\n" : "") + contextMessage() } as MsgParam);

  let finalText = "";
  const sources = new Map<string, string>();
  let aborted = false;
  try {
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const stream = api.beta.messages.stream(requestParams(s, effort));
      controller = { abort: () => ((aborted = true), stream.abort()) };
      hooks.onActivity("Processing");

      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b.type === "tool_use" || b.type === "server_tool_use") hooks.onActivity(TOOL_LABELS[b.name] ?? "Working");
          else if (b.type === "text") hooks.onActivity(null);
          else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
            for (const r of b.content) if (r.type === "web_search_result") sources.set(r.url, r.title);
          }
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          finalText += ev.delta.text;
          hooks.onText(ev.delta.text);
        }
      }
      const msg = await stream.finalMessage();

      if (msg.stop_reason === "refusal") {
        s.messages.length = start; // keep history clean
        const t = "I'm afraid that's one request I can't help with.";
        hooks.onText(t);
        return t;
      }
      if (msg.stop_reason === "pause_turn") {
        s.messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length && msg.stop_reason === "max_tokens") throw new Error("The reply was cut short — please try again.");
      s.messages.push({ role: "assistant", content: msg.content });
      if (!toolUses.length) break;

      // Run client tools (in parallel), return all results in one user message.
      if (finalText && !/\s$/.test(finalText)) {
        finalText += "\n\n";
        hooks.onText("\n\n");
      }
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          hooks.onActivity(TOOL_LABELS[tu.name] ?? "Working");
          const r = await runTool(tu.name, tu.input, hooks.ui);
          return { type: "tool_result" as const, tool_use_id: tu.id, content: r.content, is_error: r.isError || undefined };
        }),
      );
      s.messages.push({ role: "user", content: results });
    }
    s.updatedAt = Date.now();
    commit("session");
    if (sources.size) hooks.onSources([...sources].slice(0, 6).map(([url, title]) => ({ url, title })));
    return finalText;
  } catch (err) {
    s.messages.length = start; // roll back the incomplete turn
    if (aborted) return finalText;
    throw friendlyError(err);
  } finally {
    controller = null;
    hooks.onActivity(null);
  }
}

function friendlyError(err: unknown): Error {
  if (err instanceof NoKeyError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new Error("Your Claude API key was rejected. Check it in Profile → Settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return new Error("This API key doesn't have access to that model.");
  if (err instanceof Anthropic.RateLimitError) return new Error("Rate limited by the API — give me a moment and try again.");
  if (err instanceof Anthropic.BadRequestError) {
    // Show the API's own explanation, not the raw JSON envelope.
    const body = err.error as { error?: { message?: string } } | undefined;
    const msg = body?.error?.message ?? err.message;
    if (/credit balance/i.test(msg))
      return new Error("Your Claude API account has no credits left. Add credits at platform.claude.com → Settings → Billing, then try again.");
    return new Error(`Request rejected: ${msg}`);
  }
  if (err instanceof Anthropic.APIConnectionError) return new Error("I can't reach the network right now.");
  if (err instanceof Anthropic.APIError) return new Error(`The AI service had a problem (${err.status}). Try again shortly.`);
  return err instanceof Error ? err : new Error(String(err));
}

/* ---------------------------------------------------------------- *
 *  CV → profile extraction (structured output)                      *
 * ---------------------------------------------------------------- */

const ProfileSchema = z.object({
  name: z.string(),
  headline: z.string().describe("One line, e.g. 'Software engineering student & full-stack developer'"),
  location: z.string(),
  languages: z.array(z.string()),
  education: z.array(z.string()),
  experience: z.array(z.string()).describe("Short lines: role — organisation (dates)"),
  skills: z.array(z.string()),
  tools: z.array(z.string()).describe("Frameworks, software, platforms and methods they know"),
  interests: z.array(z.string()),
  dailyRoutines: z.array(z.string()).describe("Likely recurring daily/weekly tasks inferred from their profile (studying X, coding, emailing professors, job applications…)"),
  goals: z.array(z.string()).describe("Plausible near-term goals inferred from the CV"),
});

export async function extractProfileFromCV(input: { pdfBase64?: string; imageBase64?: string; imageType?: string; text?: string }): Promise<Partial<Profile>> {
  const content: Anthropic.ContentBlockParam[] = [];
  if (input.pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } });
  if (input.imageBase64)
    content.push({ type: "image", source: { type: "base64", media_type: (input.imageType ?? "image/jpeg") as "image/jpeg", data: input.imageBase64 } });
  content.push({
    type: "text",
    text: `${input.text ? `CV text:\n${input.text}\n\n` : ""}Extract this person's profile from their CV for their personal assistant. Be faithful to the CV for facts; for dailyRoutines and goals, infer sensibly from their field and experience. Keep each item short.`,
  });
  const r = await getClient().messages.parse({
    model: state.settings.model,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(ProfileSchema) },
    messages: [{ role: "user", content }],
  });
  if (!r.parsed_output) throw new Error("Couldn't read the CV. Try a clearer PDF or paste the text.");
  return r.parsed_output;
}
