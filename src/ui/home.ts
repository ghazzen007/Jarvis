import type Anthropic from "@anthropic-ai/sdk";
import { state, commit, uid, type CardData, type DisplayMsg, type Effort } from "../core/store";
import { ask, interrupt, isBusy, resetSession, NoKeyError } from "../core/brain";
import * as voice from "../core/voice";
import type { ToolUI } from "../core/tools";
import { h, md, fileToBase64, todayKey } from "../core/util";
import { icon, RINGS_SVG } from "./icons";
import { renderCard } from "./cards";
import type { Orb } from "../visual/orb";

type Block = Anthropic.Beta.BetaContentBlockParam;

let orb: Orb;
let feed: HTMLElement;
let input: HTMLInputElement;
let activityEl: HTMLElement;
let interimEl: HTMLElement;
let filesEl: HTMLElement;
let micBtn: HTMLButtonElement;
let pending: { file: File; name: string }[] = [];
let busy = false;
let listening = false;
let startFocusFn: (m: number, l: string) => void = () => {};
const readout: Record<string, HTMLElement> = {};

export function setFocusStarter(fn: (m: number, l: string) => void) {
  startFocusFn = fn;
}

function updateMode() {
  const mode = listening ? "listening" : voice.isSpeaking() ? "speaking" : busy ? "thinking" : "idle";
  document.body.dataset.mode = mode;
  orb.setMode(mode);
  const label = { listening: "Listening", speaking: "Speaking", thinking: "Processing", idle: "Online" }[mode];
  document.getElementById("status")!.textContent = label;
  micBtn.innerHTML = RINGS_SVG + icon(mode === "idle" ? "mic" : mode === "listening" ? "wave" : "stop", "ico");
  micBtn.setAttribute("aria-label", mode === "idle" ? "Talk to Jarvis" : "Stop");
}

function scrollFeed() {
  requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
}

function pushDisplay(m: DisplayMsg) {
  const s = state.session;
  if (!s) return;
  s.display.push(m);
  if (s.display.length > 250) s.display.splice(0, s.display.length - 250);
  commit("session");
}

function renderMsg(m: DisplayMsg): HTMLElement {
  if (m.role === "user") {
    const el = h("div", { class: "msg user" }, m.text ?? "");
    if (m.attachments?.length) el.append(h("div", { class: "att" }, "📎 " + m.attachments.join(", ")));
    return el;
  }
  if (m.role === "card" && m.card) return h("div", { class: "msg card" }, renderCard(m.card));
  if (m.role === "error") return h("div", { class: "msg error" }, m.text ?? "");
  const el = h("div", { class: "msg jarvis" }, h("div", { class: "who" }, "J.A.R.V.I.S"));
  const body = h("div", { class: "body" });
  body.innerHTML = md(m.text ?? "");
  el.append(body);
  return el;
}

function renderFeed() {
  feed.replaceChildren();
  const list = state.session?.display ?? [];
  if (!list.length) {
    feed.append(welcome());
  } else {
    list.slice(-60).forEach((m) => feed.append(renderMsg(m)));
  }
  scrollFeed();
}

function welcome(): HTMLElement {
  const hr = new Date().getHours();
  const part = hr < 5 ? "evening" : hr < 12 ? "morning" : hr < 18 ? "afternoon" : "evening";
  const who = state.profile.name ? state.profile.name.split(" ")[0] : state.profile.addressAs || "sir";
  const el = h("div", { class: "msg jarvis" }, h("div", { class: "who" }, "J.A.R.V.I.S"));
  const b = h("div", { class: "body" });
  b.innerHTML = md(
    `Good ${part}, ${who}. All systems are online.\n\nTap the core or the microphone to speak, or type below. I can manage your tasks, mail, calls, research and studies.`,
  );
  el.append(b);
  return el;
}

function showError(text: string) {
  const m: DisplayMsg = { id: uid(), role: "error", text, ts: Date.now() };
  pushDisplay(m);
  feed.append(renderMsg(m));
  scrollFeed();
}

function addCard(card: CardData) {
  const m: DisplayMsg = { id: uid(), role: "card", card, ts: Date.now() };
  pushDisplay(m);
  feed.append(renderMsg(m));
  scrollFeed();
}

const ui: ToolUI = {
  card: addCard,
  confirm(card, prompt) {
    return new Promise<boolean>((resolve) => {
      const m: DisplayMsg = { id: uid(), role: "card", card, ts: Date.now() };
      pushDisplay(m);
      const el = h("div", { class: "msg card" }, renderCard(card, { prompt, resolve: (ok) => (commit("session"), resolve(ok)) }));
      feed.append(el);
      scrollFeed();
      voice.speak(prompt);
    });
  },
  startFocus: (m, l) => startFocusFn(m, l),
};

async function buildBlocks(text: string): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const p of pending) {
    const data = await fileToBase64(p.file);
    if (p.file.type === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: p.name });
    } else if (p.file.type.startsWith("image/")) {
      const mt = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(p.file.type) ? p.file.type : "image/jpeg") as "image/jpeg";
      blocks.push({ type: "image", source: { type: "base64", media_type: mt, data } });
    } else {
      const txt = await p.file.text();
      blocks.push({ type: "text", text: `File "${p.name}":\n${txt.slice(0, 100000)}` });
    }
  }
  blocks.push({ type: "text", text: text || "Please look at the attached file." });
  return blocks;
}

/** Send a message to Jarvis (from the dock, voice, chips or other views). */
export async function send(text: string, effort?: Effort) {
  text = text.trim();
  if ((!text && !pending.length) || busy) return;
  voice.stopSpeaking();
  const attachments = pending.map((p) => p.name);
  const um: DisplayMsg = { id: uid(), role: "user", text, attachments, ts: Date.now() };
  if (!state.session) resetSession();
  if (feed.querySelector(".msg") && !state.session!.display.length) feed.replaceChildren();
  pushDisplay(um);
  feed.append(renderMsg(um));
  scrollFeed();

  let blocks: Block[];
  try {
    blocks = await buildBlocks(text);
  } catch {
    showError("Couldn't read that file.");
    return;
  }
  pending = [];
  renderFiles();

  busy = true;
  updateMode();
  const jEl = h("div", { class: "msg jarvis streaming" }, h("div", { class: "who" }, "J.A.R.V.I.S"));
  const body = h("div", { class: "body" });
  jEl.append(body);
  let full = "";
  let raf = 0;
  const speaker = new voice.SentenceStreamer();
  const autoEffort = effort ?? (/^(research|deep|analy[sz]e|compare|study plan)\b/i.test(text) ? "high" : undefined);

  try {
    const final = await ask(
      blocks,
      {
        ui,
        onText(delta) {
          if (!jEl.isConnected) feed.append(jEl);
          full += delta;
          speaker.push(delta);
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            body.innerHTML = md(full);
            scrollFeed();
          });
        },
        onActivity(label) {
          activityEl.classList.toggle("on", !!label);
          if (label) activityEl.innerHTML = `<span class="bars"><i></i><i></i><i></i></span>${label}…`;
        },
        onSources(items) {
          addCard({ kind: "sources", items });
        },
      },
      autoEffort,
    );
    speaker.flush();
    cancelAnimationFrame(raf);
    if (final.trim()) {
      body.innerHTML = md(final);
      jEl.classList.remove("streaming");
      if (!jEl.isConnected) feed.append(jEl);
      // place the text before any cards emitted after it started? keep chronological
      pushDisplay({ id: uid(), role: "jarvis", text: final, ts: Date.now() });
    } else jEl.remove();
  } catch (e) {
    jEl.remove();
    speaker.flush();
    const msg = (e as Error).message;
    showError(msg);
    if (e instanceof NoKeyError) setTimeout(() => (window as unknown as { jarvisGoto(v: string): void }).jarvisGoto("profile"), 900);
  } finally {
    busy = false;
    updateMode();
    refreshReadout();
    scrollFeed();
  }
}

export function startListening(prefill?: string) {
  if (prefill) {
    void send(prefill);
    return;
  }
  if (busy) interrupt();
  voice.stopSpeaking();
  listening = true;
  updateMode();
  voice.listen({
    onInterim: (t) => (interimEl.textContent = t),
    onFinal: (t) => {
      interimEl.textContent = "";
      void send(t);
    },
    onEnd: () => {
      listening = false;
      interimEl.textContent = "";
      updateMode();
    },
    onError: (m) => {
      listening = false;
      updateMode();
      showError(m);
    },
  });
}

function micPressed() {
  if (listening) return voice.stopListening();
  if (busy || isBusy()) {
    interrupt();
    voice.stopSpeaking();
    return;
  }
  if (voice.isSpeaking()) return voice.stopSpeaking();
  if (input.value.trim() || pending.length) {
    const t = input.value;
    input.value = "";
    void send(t);
    return;
  }
  startListening();
}

function renderFiles() {
  filesEl.replaceChildren(
    ...pending.map((p, i) =>
      h("button", { class: "chip", type: "button", onclick: () => ((pending = pending.filter((_, j) => j !== i)), renderFiles()) }, "📎 " + p.name + "  ✕"),
    ),
  );
}

export function refreshReadout() {
  if (!readout.tasks) return;
  const open = state.tasks.filter((t) => !t.done).length;
  const doneToday = state.tasks.filter((t) => t.doneAt && todayKey(new Date(t.doneAt)) === todayKey()).length;
  const focus = state.focus.find((f) => f.date === todayKey())?.minutes ?? 0;
  readout.tasks.innerHTML = `TASKS<b>${String(open).padStart(2, "0")}</b><div class="bar"><i style="width:${Math.min(100, (doneToday / Math.max(1, doneToday + open)) * 100)}%"></i></div>`;
  readout.focus.innerHTML = `FOCUS<b>${focus}<small>m</small></b><div class="bar"><i style="width:${Math.min(100, (focus / 120) * 100)}%"></i></div>`;
  readout.mem.innerHTML = `MEMORY<b>${String(state.profile.memory.length).padStart(2, "0")}</b>`;
  readout.net.innerHTML = `UPLINK<b>${navigator.onLine ? "ON" : "OFF"}</b><div class="bar"><i style="width:${navigator.onLine ? 100 : 8}%"></i></div>`;
  readout.voice.innerHTML = `VOICE<b>${state.settings.elevenKey ? "HD" : "STD"}</b>`;
  readout.model.innerHTML = `CORE<b>${state.settings.model.split("-")[1]?.toUpperCase() ?? "AI"}</b><div class="bar"><i style="width:${{ low: 33, medium: 66, high: 100 }[state.settings.effort]}%"></i></div>`;
}

export function mountHome(root: HTMLElement, theOrb: Orb) {
  orb = theOrb;
  const space = h("div", { class: "orb-space" });
  const l = h("div", { class: "readout l" });
  const r = h("div", { class: "readout r" });
  for (const k of ["tasks", "focus", "mem"]) l.append((readout[k] = h("div")));
  for (const k of ["net", "voice", "model"]) r.append((readout[k] = h("div")));
  space.append(l, r);

  feed = h("div", { class: "feed", "aria-live": "polite" });
  activityEl = h("div", { class: "activity" });
  interimEl = h("div", { class: "interim" });

  const chips = h("div", { class: "chips" });
  const chip = (ic: string, label: string, fn: () => void) => {
    const b = h("button", { class: "chip", type: "button" });
    b.innerHTML = `${icon(ic)}${label}`;
    b.addEventListener("click", fn);
    chips.append(b);
  };
  const prefill = (t: string) => {
    input.value = t;
    input.focus();
    input.setSelectionRange(t.length, t.length);
  };
  chip("brief", "Brief me", () => void send("Give me my briefing: weather, today's calendar, important unread email, and tasks due today. Keep it tight."));
  chip("cal", "Plan my day", () => void send("Plan the rest of my day around my tasks, calendar and routines. Propose a realistic timeline."));
  chip("mail", "Check mail", () => void send("Check my inbox and tell me what actually needs my attention."));
  chip("search", "Research", () => prefill("Research "));
  chip("study", "Study", () => void send("Let's study. Ask me which subject and how I want to work — explanation, quiz or flashcards."));
  chip("phone", "Call", () => prefill("Call "));
  chip("note", "Note", () => prefill("Take a note: "));
  chip("spark", "New chat", () => {
    resetSession(true);
    renderFeed();
  });

  filesEl = h("div", { class: "files" });
  const fileInput = h("input", { type: "file", accept: "image/*,application/pdf,.txt,.md,.csv,.json", multiple: true, hidden: true }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    for (const f of Array.from(fileInput.files ?? [])) {
      if (f.size > 20 * 1024 * 1024) {
        showError(`${f.name} is larger than 20 MB.`);
        continue;
      }
      pending.push({ file: f, name: f.name });
    }
    fileInput.value = "";
    renderFiles();
  });
  const attach = h("button", { class: "icon-btn", type: "button", "aria-label": "Attach file", onclick: () => fileInput.click() });
  attach.innerHTML = icon("clip");
  input = h("input", { class: "field grow", placeholder: "Ask Jarvis anything…", enterkeyhint: "send", autocomplete: "off" }) as HTMLInputElement;
  micBtn = h("button", { class: "mic", type: "button" }) as HTMLButtonElement;
  micBtn.addEventListener("click", micPressed);
  const dock = h("form", { class: "dock" }, attach, input, micBtn, fileInput);
  dock.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = input.value;
    input.value = "";
    void send(t);
  });
  input.addEventListener("input", () => {
    if (!busy && !listening && !voice.isSpeaking()) micBtn.innerHTML = RINGS_SVG + icon(input.value.trim() ? "send" : "mic", "ico");
  });

  root.append(space, feed, activityEl, interimEl, chips, filesEl, dock);
  orb.onTap = () => micPressed();
  voice.onSpeakingChange(() => updateMode());
  updateMode();
  renderFeed();
  refreshReadout();
  addEventListener("online", refreshReadout);
  addEventListener("offline", refreshReadout);
}

export function rerenderFeed() {
  renderFeed();
}
