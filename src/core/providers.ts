// Free AI providers: Google Gemini (AI Studio free tier) and Groq (free tier).
// Called straight from the browser with the user's own keys — no backend.
import type Anthropic from "@anthropic-ai/sdk";
import { state, commit, type Effort, type Profile, type Provider, type Session } from "./store";
import { CLIENT_TOOLS, TOOL_LABELS, runTool } from "./tools";
import { contextMessage } from "./prompt";
import type { AskHooks } from "./brain";
import { NoKeyError } from "./errors";

type Block = Anthropic.Beta.BetaContentBlockParam;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const GROQ = "https://api.groq.com/openai/v1";
const MAX_LOOPS = 10;
const MAX_HISTORY = 60;

export const PROVIDER_INFO: Record<Exclude<Provider, "claude">, { label: string; keyUrl: string; keyHint: string }> = {
  gemini: { label: "Gemini", keyUrl: "https://aistudio.google.com/apikey", keyHint: "Free key from Google AI Studio — no card needed." },
  groq: { label: "Groq", keyUrl: "https://console.groq.com/keys", keyHint: "Free key from the Groq console — no card needed." },
};

function keyFor(p: Provider): string {
  const k = p === "gemini" ? state.settings.geminiKey : state.settings.groqKey;
  if (!k.trim()) throw new NoKeyError(`No ${p === "gemini" ? "Gemini" : "Groq"} key yet. Open Profile → AI core and paste your free key.`);
  return k.trim();
}

async function httpError(name: string, res: Response): Promise<Error> {
  let msg = "";
  try {
    const j = await res.json();
    msg = j?.error?.message ?? JSON.stringify(j).slice(0, 200);
  } catch {
    /* no body */
  }
  if (res.status === 429) return new Error(`${name} free-tier limit reached. Wait a minute (or until tomorrow for daily limits), or switch provider in Profile → AI core.`);
  if (res.status === 401 || res.status === 403) return new Error(`${name} rejected the key${msg ? `: ${msg}` : ""}. Check it in Profile → AI core.`);
  if (res.status === 404) return new Error(`${name} doesn't know that model${msg ? ` (${msg})` : ""}. Pick another in Profile → AI core.`);
  return new Error(`${name} error ${res.status}${msg ? `: ${msg}` : ""}`);
}

async function post(name: string, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`Can't reach ${name}. Check your connection${name === "Groq" ? " — if this keeps happening, your browser may be blocking Groq; try Gemini instead" : ""}.`);
  }
  if (!res.ok) throw await httpError(name, res);
  return res.json();
}

/* --------------------------------------------------------------------------
 *  Model lists (live, so new free models show up automatically)
 * ------------------------------------------------------------------------ */
export async function listModels(p: Exclude<Provider, "claude">): Promise<string[]> {
  const key = keyFor(p);
  if (p === "gemini") {
    const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    if (!res.ok) throw await httpError("Gemini", res);
    const j = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const ids = (j.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => n.startsWith("gemini") && !/embed|image|tts|audio|live|robotics|computer/i.test(n));
    return ["gemini-flash-lite-latest", "gemini-flash-latest", ...ids.filter((n) => !n.endsWith("-latest"))].filter((v, i, a) => a.indexOf(v) === i);
  }
  const res = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw await httpError("Groq", res);
  const j = (await res.json()) as { data?: { id: string; active?: boolean }[] };
  return (j.data ?? [])
    .filter((m) => m.active !== false && !/whisper|guard|tts|orpheus|playai|distil|compound/i.test(m.id))
    .map((m) => m.id)
    .sort();
}

/* --------------------------------------------------------------------------
 *  Schema conversion
 * ------------------------------------------------------------------------ */
const GEMINI_KEYS = new Set(["type", "description", "enum", "properties", "required", "items", "minItems", "maxItems", "minimum", "maximum", "nullable", "anyOf"]);

/** Gemini's `parameters` accepts an OpenAPI subset — strip what it doesn't understand. */
function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) > 1e9) continue;
    else out[k] = geminiSchema(v);
  }
  return out;
}

/* --------------------------------------------------------------------------
 *  History helpers
 * ------------------------------------------------------------------------ */
function history(s: Session, p: Provider): unknown[] {
  if (!s.alt || s.alt.provider !== p) s.alt = { provider: p, messages: [] };
  return s.alt.messages;
}

/** Drop the oldest turns, always restarting at a plain user message. */
function trim(msgs: unknown[], isPlainUser: (m: unknown) => boolean) {
  if (msgs.length <= MAX_HISTORY) return;
  let cut = msgs.length - MAX_HISTORY;
  while (cut < msgs.length && !isPlainUser(msgs[cut])) cut++;
  msgs.splice(0, cut);
}

/** Reveal a finished reply in small chunks so captions and voice feel live. */
async function reveal(text: string, hooks: AskHooks, signal: AbortSignal) {
  const parts = text.match(/\S+\s*/g) ?? [];
  for (let i = 0; i < parts.length; i += 3) {
    if (signal.aborted) return;
    hooks.onText(parts.slice(i, i + 3).join(""));
    await new Promise((r) => setTimeout(r, 18));
  }
}

function blocksToText(blocks: Block[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

/* --------------------------------------------------------------------------
 *  Gemini
 * ------------------------------------------------------------------------ */
interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
}
interface GContent {
  role: "user" | "model";
  parts: GPart[];
}

function toGeminiParts(blocks: Block[]): GPart[] {
  const parts: GPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ text: b.text });
    else if (b.type === "image" && b.source.type === "base64") parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
    else if (b.type === "document" && b.source.type === "base64") parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
  }
  return parts;
}

async function askGemini(s: Session, blocks: Block[], hooks: AskHooks, research: boolean, signal: AbortSignal): Promise<string> {
  const key = keyFor("gemini");
  const model = state.settings.geminiModel || "gemini-flash-lite-latest";
  const contents = history(s, "gemini") as GContent[];
  const start = contents.length;
  contents.push({ role: "user", parts: [{ text: contextMessage() }, ...toGeminiParts(blocks)] });

  const fnTools = [{ functionDeclarations: CLIENT_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.schema) })) }];
  let finalText = "";
  const sources = new Map<string, string>();
  try {
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      // Research turns use Google Search grounding (kept separate from function tools).
      const useSearch = research && loop === 0;
      hooks.onActivity(useSearch ? "Searching the web" : "Processing");
      const data = await post(
        "Gemini",
        `${GEMINI}/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": key },
        {
          systemInstruction: { parts: [{ text: s.system }] },
          contents,
          tools: useSearch ? [{ google_search: {} }] : fnTools,
        },
        signal,
      );
      const cand = data.candidates?.[0];
      if (!cand) {
        const why = data.promptFeedback?.blockReason;
        throw new Error(why ? `Gemini declined this request (${why}).` : "Gemini returned no answer.");
      }
      const parts: GPart[] = cand.content?.parts ?? [];
      for (const c of cand.groundingMetadata?.groundingChunks ?? []) if (c.web?.uri) sources.set(c.web.uri, c.web.title ?? c.web.uri);
      if (!parts.length) {
        if (finalText) break;
        throw new Error(`Gemini couldn't answer (${cand.finishReason ?? "empty reply"}). Try rephrasing.`);
      }
      contents.push({ role: "model", parts }); // unchanged: keeps thought signatures valid
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("");
      if (text) {
        if (finalText && !/\s$/.test(finalText)) {
          finalText += "\n\n";
          hooks.onText("\n\n");
        }
        finalText += text;
        await reveal(text, hooks, signal);
      }
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
      if (!calls.length) break;
      const responses: GPart[] = await Promise.all(
        calls.map(async (c) => {
          hooks.onActivity(TOOL_LABELS[c.name] ?? "Working");
          const r = await runTool(c.name, c.args ?? {}, hooks.ui);
          let payload: unknown = r.content;
          try {
            payload = JSON.parse(r.content);
          } catch {
            /* plain text */
          }
          return { functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: r.isError ? { error: payload } : { result: payload } } };
        }),
      );
      contents.push({ role: "user", parts: responses });
    }
  } catch (e) {
    contents.length = start;
    throw e;
  }
  trim(contents, (m) => (m as GContent).role === "user" && !(m as GContent).parts.some((p) => p.functionResponse));
  if (sources.size) hooks.onSources([...sources].slice(0, 6).map(([url, title]) => ({ url, title })));
  return finalText;
}

/* --------------------------------------------------------------------------
 *  Groq (OpenAI-compatible chat completions)
 * ------------------------------------------------------------------------ */
interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OAIMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

async function askGroq(s: Session, blocks: Block[], hooks: AskHooks, research: boolean, effort: Effort, signal: AbortSignal): Promise<string> {
  const key = keyFor("groq");
  if (blocks.some((b) => b.type === "image" || b.type === "document"))
    throw new Error("Groq can't read images or PDFs here. Switch to Gemini (free) in Profile → AI core to analyse files.");
  const msgs = history(s, "groq") as OAIMsg[];
  const start = msgs.length;
  msgs.push({ role: "user", content: `${contextMessage()}\n\n---\n${blocksToText(blocks)}` });

  const tools = CLIENT_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const model = state.settings.groqModel || "openai/gpt-oss-120b";
  let finalText = "";
  try {
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const useSearch = research && loop === 0;
      hooks.onActivity(useSearch ? "Searching the web" : "Processing");
      const body: Record<string, unknown> = useSearch
        ? { model: "groq/compound", messages: [{ role: "system", content: s.system }, ...msgs] } // built-in web search, no custom tools
        : {
            model,
            messages: [{ role: "system", content: s.system }, ...msgs],
            tools,
            tool_choice: "auto",
            ...(/gpt-oss/.test(model) ? { reasoning_effort: effort } : {}),
          };
      let data;
      try {
        data = await post("Groq", `${GROQ}/chat/completions`, { Authorization: `Bearer ${key}` }, body, signal);
      } catch (e) {
        if (useSearch && !(e instanceof Error && e.name === "AbortError")) continue; // search unavailable: answer without it
        throw e;
      }
      const m = data.choices?.[0]?.message as (OAIMsg & { reasoning?: string }) | undefined;
      if (!m) throw new Error("Groq returned no answer.");
      const clean: OAIMsg = { role: "assistant", content: m.content ?? "", ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
      msgs.push(clean);
      const text = (m.content ?? "").trim();
      if (text) {
        if (finalText && !/\s$/.test(finalText)) {
          finalText += "\n\n";
          hooks.onText("\n\n");
        }
        finalText += text;
        await reveal(text, hooks, signal);
      }
      if (!m.tool_calls?.length) break;
      const results = await Promise.all(
        m.tool_calls.map(async (tc) => {
          hooks.onActivity(TOOL_LABELS[tc.function.name] ?? "Working");
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            return { role: "tool" as const, tool_call_id: tc.id, content: "INVALID_JSON arguments; please retry." };
          }
          const r = await runTool(tc.function.name, args, hooks.ui);
          return { role: "tool" as const, tool_call_id: tc.id, content: r.content };
        }),
      );
      msgs.push(...results);
    }
  } catch (e) {
    msgs.length = start;
    throw e;
  }
  trim(msgs, (x) => (x as OAIMsg).role === "user");
  return finalText;
}

/* --------------------------------------------------------------------------
 *  Entry points used by brain.ts
 * ------------------------------------------------------------------------ */
export async function askFree(
  provider: Exclude<Provider, "claude">,
  s: Session,
  blocks: Block[],
  hooks: AskHooks,
  effort: Effort,
  signal: AbortSignal,
): Promise<string> {
  const research = effort === "high";
  const text = provider === "gemini" ? await askGemini(s, blocks, hooks, research, signal) : await askGroq(s, blocks, hooks, research, effort, signal);
  s.updatedAt = Date.now();
  commit("session");
  return text;
}

const PROFILE_PROMPT = `Extract this person's profile from their CV for their personal assistant. Reply with ONLY a JSON object with these keys:
name (string), headline (string, one line), location (string), languages, education, experience, skills, tools, interests, dailyRoutines, goals (each an array of short strings).
Be faithful to the CV for facts; for dailyRoutines and goals, infer sensibly from their field. Keep items short.`;

export async function extractProfileFree(
  provider: Exclude<Provider, "claude">,
  input: { pdfBase64?: string; imageBase64?: string; imageType?: string; text?: string },
): Promise<Partial<Profile>> {
  const ctrl = new AbortController();
  let raw = "";
  if (provider === "gemini") {
    const parts: GPart[] = [];
    if (input.pdfBase64) parts.push({ inlineData: { mimeType: "application/pdf", data: input.pdfBase64 } });
    if (input.imageBase64) parts.push({ inlineData: { mimeType: input.imageType ?? "image/jpeg", data: input.imageBase64 } });
    parts.push({ text: `${input.text ? `CV text:\n${input.text}\n\n` : ""}${PROFILE_PROMPT}` });
    const data = await post(
      "Gemini",
      `${GEMINI}/models/${encodeURIComponent(state.settings.geminiModel || "gemini-flash-lite-latest")}:generateContent`,
      { "x-goog-api-key": keyFor("gemini") },
      { contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json" } },
      ctrl.signal,
    );
    raw = (data.candidates?.[0]?.content?.parts ?? []).map((p: GPart) => (p.thought ? "" : (p.text ?? ""))).join("");
  } else {
    if (!input.text) throw new Error("With Groq, upload your CV as a .txt file (or switch to Gemini to read a PDF/photo).");
    const data = await post(
      "Groq",
      `${GROQ}/chat/completions`,
      { Authorization: `Bearer ${keyFor("groq")}` },
      {
        model: state.settings.groqModel || "openai/gpt-oss-120b",
        messages: [{ role: "user", content: `CV text:\n${input.text}\n\n${PROFILE_PROMPT}` }],
        response_format: { type: "json_object" },
      },
      ctrl.signal,
    );
    raw = data.choices?.[0]?.message?.content ?? "";
  }
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(json);
  } catch {
    throw new Error("Couldn't read the CV. Try a clearer file.");
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    name: String(p.name ?? ""),
    headline: String(p.headline ?? ""),
    location: String(p.location ?? ""),
    languages: arr(p.languages),
    education: arr(p.education),
    experience: arr(p.experience),
    skills: arr(p.skills),
    tools: arr(p.tools),
    interests: arr(p.interests),
    dailyRoutines: arr(p.dailyRoutines),
    goals: arr(p.goals),
  };
}
