import { state, commit, type Deck } from "../core/store";
import { h, esc, todayKey } from "../core/util";
import { speak } from "../core/voice";
import { icon } from "./icons";
import { openSheet, closeSheet, toast, askText } from "./overlay";
import { cardActions } from "./cards";

let root: HTMLElement;
const R = 96;
const C = 2 * Math.PI * R;

interface Timer { total: number; endAt: number; remaining: number; running: boolean; label: string }
let timer: Timer = loadTimer();
let tickId = 0;
let ringEls: { prog: SVGCircleElement; time: HTMLElement; label: HTMLElement; wrap: HTMLElement; toggle: HTMLButtonElement } | null = null;

function loadTimer(): Timer {
  try {
    const t = JSON.parse(localStorage.getItem("jarvis:timer") || "null") as Timer | null;
    if (t) return t;
  } catch {
    /* ignore */
  }
  return { total: 25 * 60, endAt: 0, remaining: 25 * 60, running: false, label: "Focus" };
}
function saveTimer() {
  try {
    localStorage.setItem("jarvis:timer", JSON.stringify(timer));
  } catch {
    /* ignore */
  }
}

function remaining(): number {
  return timer.running ? Math.max(0, Math.round((timer.endAt - Date.now()) / 1000)) : timer.remaining;
}

function logFocus(minutes: number) {
  const k = todayKey();
  const f = state.focus.find((x) => x.date === k);
  if (f) f.minutes += minutes;
  else state.focus.push({ date: k, minutes });
  if (state.focus.length > 60) state.focus.shift();
  commit("focus");
}

function tick() {
  const r = remaining();
  if (timer.running && r <= 0) {
    timer.running = false;
    timer.remaining = timer.total;
    saveTimer();
    logFocus(Math.round(timer.total / 60));
    toast("Focus complete", `${Math.round(timer.total / 60)} minutes of ${timer.label}. Take a short break.`, 8000);
    speak(`Focus session complete. ${Math.round(timer.total / 60)} minutes well spent. I suggest a five minute break.`);
    if ("Notification" in window && Notification.permission === "granted")
      void navigator.serviceWorker?.getRegistration().then((reg) => reg?.showNotification("Jarvis · Focus complete", { body: "Time for a short break.", icon: "icons/icon-192.png" }));
  }
  paint();
}

function paint() {
  if (!ringEls) return;
  const r = remaining();
  const frac = timer.total ? r / timer.total : 0;
  ringEls.prog.style.strokeDashoffset = String(C * (1 - frac));
  ringEls.time.textContent = `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
  ringEls.label.textContent = timer.running ? timer.label : r === timer.total ? "Ready" : "Paused";
  ringEls.wrap.classList.toggle("running", timer.running);
  ringEls.toggle.innerHTML = `${icon(timer.running ? "pause" : "play")}<span>${timer.running ? "Pause" : "Start"}</span>`;
}

export function startFocus(minutes: number, label = "Focus") {
  timer = { total: minutes * 60, remaining: minutes * 60, endAt: Date.now() + minutes * 60 * 1000, running: true, label };
  saveTimer();
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  paint();
}

function toggle() {
  if (timer.running) {
    timer.remaining = remaining();
    timer.running = false;
  } else {
    timer.endAt = Date.now() + timer.remaining * 1000;
    timer.running = true;
  }
  saveTimer();
  paint();
}

function reset(min?: number) {
  const t = (min ?? timer.total / 60) * 60;
  timer = { ...timer, total: t, remaining: t, running: false };
  saveTimer();
  paint();
}

/* ---------------------------- flashcards ---------------------------- */
const INTERVALS = [0, 86400000, 3 * 86400000, 7 * 86400000, 16 * 86400000];

export function openDeck(id: string) {
  const deck = state.decks.find((d) => d.id === id);
  if (!deck) return;
  const now = Date.now();
  const queue = deck.cards.map((c, i) => ({ c, i })).filter(({ c }) => c.due <= now);
  if (!queue.length) queue.push(...deck.cards.map((c, i) => ({ c, i })));
  let pos = 0;
  let correct = 0;
  const wrap = h("div", {});
  const show = () => {
    if (pos >= queue.length) {
      wrap.replaceChildren(
        h("div", { class: "view-title" }, "Session complete"),
        h("p", { class: "view-sub" }, `${correct}/${queue.length} recalled. Cards you missed will come back sooner.`),
        h("button", { class: "btn primary block", type: "button", onclick: () => closeSheet() }, "Done"),
      );
      speak(`Deck complete. You recalled ${correct} of ${queue.length}.`);
      return;
    }
    const { c } = queue[pos];
    const flash = h("div", { class: "flash" });
    const front = h("div", { class: "side front panel" }, h("small", {}, "QUESTION"));
    front.append(h("div", {}, c.q));
    const back = h("div", { class: "side back panel" }, h("small", {}, "ANSWER"));
    back.append(h("div", {}, c.a));
    flash.append(front, back);
    flash.addEventListener("click", () => flash.classList.toggle("flipped"));
    const grade = (g: 0 | 1 | 2) => {
      c.box = g === 0 ? 0 : Math.min(4, c.box + g);
      c.due = Date.now() + (g === 0 ? 60000 : INTERVALS[c.box]);
      if (g) correct++;
      commit("decks");
      pos++;
      wrap.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-30px)" }], { duration: 220, easing: "ease-in" }).onfinish = show;
    };
    const btns = h(
      "div",
      { class: "row" },
      h("button", { class: "btn danger grow", type: "button", onclick: () => grade(0) }, "Again"),
      h("button", { class: "btn grow", type: "button", onclick: () => grade(1) }, "Good"),
      h("button", { class: "btn primary grow", type: "button", onclick: () => grade(2) }, "Easy"),
    );
    wrap.replaceChildren(
      h("div", { class: "row" }, h("div", { class: "view-title grow", style: "font-size:16px" }, deck.name), h("span", { class: "mono small muted" }, `${pos + 1}/${queue.length}`)),
      h("div", { class: "flash-stage" }, flash),
      h("p", { class: "hint", style: "text-align:center;margin-bottom:12px" }, "Tap the card to flip"),
      btns,
    );
    wrap.animate([{ opacity: 0, transform: "translateX(30px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  };
  show();
  openSheet(wrap, () => render());
}

function deckItem(d: Deck, i: number) {
  const due = d.cards.filter((c) => c.due <= Date.now()).length;
  const mastered = d.cards.filter((c) => c.box >= 3).length;
  const el = h("div", { class: "item", style: `--i:${i};cursor:pointer` });
  el.innerHTML = `<div class="avatar">${icon("cards")}</div><div class="grow"><div class="title">${esc(d.name)}</div><div class="meta"><span>${d.cards.length} cards</span><span style="color:var(--cyan)">${due} due</span><span>${Math.round((mastered / Math.max(1, d.cards.length)) * 100)}% mastered</span></div></div>`;
  el.querySelector(".avatar svg")?.setAttribute("style", "width:18px;height:18px");
  const del = h("button", { class: "icon-btn", type: "button", "aria-label": "Delete deck" });
  del.innerHTML = icon("trash");
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    state.decks = state.decks.filter((x) => x.id !== d.id);
    commit("decks");
    render();
  });
  el.append(del);
  el.addEventListener("click", () => openDeck(d.id));
  return el;
}

export function render() {
  if (!root) return;
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * Math.PI * 2;
    const r1 = i % 5 ? 108 : 104;
    return `<line x1="${110 + Math.cos(a) * r1}" y1="${110 + Math.sin(a) * r1}" x2="${110 + Math.cos(a) * 112}" y2="${110 + Math.sin(a) * 112}"/>`;
  }).join("");
  const ring = h("div", { class: "focus-ring" });
  ring.innerHTML = `<svg viewBox="0 0 220 220"><defs><linearGradient id="focusGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ee6ff"/><stop offset="1" stop-color="#a093ff"/></linearGradient></defs><g class="ticks" stroke-width="1.2">${ticks}</g><circle class="track" cx="110" cy="110" r="${R}" fill="none" stroke-width="6"/><circle class="prog" cx="110" cy="110" r="${R}" fill="none" stroke-width="6" stroke-dasharray="${C}" stroke-dashoffset="0"/><g class="spinner"><circle cx="110" cy="110" r="84" fill="none" stroke="rgba(94,230,255,.25)" stroke-dasharray="2 8"/></g></svg><div class="center"><div><div class="time">25:00</div><div class="lbl2">Ready</div></div></div>`;
  const tg = h("button", { class: "btn primary", type: "button" }) as HTMLButtonElement;
  tg.addEventListener("click", toggle);
  const rs = h("button", { class: "icon-btn", type: "button", "aria-label": "Reset timer" });
  rs.innerHTML = icon("reset");
  rs.addEventListener("click", () => reset());
  const presets = h("div", { class: "row", style: "justify-content:center;margin-top:10px" });
  for (const m of [15, 25, 50, 90]) {
    const b = h("button", { class: "chip", type: "button" }, `${m} min`);
    b.addEventListener("click", () => reset(m));
    presets.append(b);
  }
  ringEls = {
    prog: ring.querySelector(".prog")!,
    time: ring.querySelector(".time")!,
    label: ring.querySelector(".lbl2")!,
    wrap: ring,
    toggle: tg,
  };
  const today = state.focus.find((f) => f.date === todayKey())?.minutes ?? 0;
  const week = state.focus.filter((f) => Date.now() - new Date(f.date).getTime() < 7 * 86400000).reduce((s, f) => s + f.minutes, 0);

  const focusPanel = h(
    "div",
    { class: "panel" },
    h("div", { class: "row" }, h("div", { class: "section-label grow", style: "margin:0" }, "Focus protocol"), h("span", { class: "mono small muted" }, `Today ${today}m · Week ${week}m`)),
    h("div", { class: "focus-wrap" }, ring),
    h("div", { class: "row", style: "justify-content:center" }, tg, rs),
    presets,
  );

  const tools = h("div", { class: "stagger", style: "display:grid;grid-template-columns:1fr 1fr;gap:10px" });
  const tool = (ic: string, title: string, sub: string, fn: () => void | Promise<void>) => {
    const b = h("button", { class: "panel", type: "button", style: "text-align:left;margin:0" });
    b.innerHTML = `<div style="color:var(--cyan);margin-bottom:8px">${icon(ic)}</div><b style="font:700 13px/1.2 var(--hud);letter-spacing:.12em;text-transform:uppercase">${title}</b><div class="small muted" style="margin-top:4px">${sub}</div>`;
    b.querySelector("svg")?.setAttribute("style", "width:22px;height:22px");
    b.addEventListener("click", () => void fn());
    tools.append(b);
  };
  tool("brain", "Explain", "Any concept, at your level", async () => {
    const t = await askText("What should Jarvis explain?", "e.g. eigenvectors, React hooks, TCP handshake");
    if (t) cardActions.ask(`Explain ${t} clearly at my level, with an example and a quick check question at the end.`);
  });
  tool("spark", "Quiz me", "Active recall, 5 questions", async () => {
    const t = await askText("Quiz topic?", "e.g. SQL joins");
    if (t) cardActions.ask(`Quiz me on ${t}: ask 5 questions one at a time, wait for my answer, then give feedback.`);
  });
  tool("cards", "Flashcards", "Generate a deck", async () => {
    const t = await askText("Flashcards about?", "e.g. Spring Boot annotations");
    if (t) cardActions.ask(`Create a flashcard deck (15-20 cards) on ${t}, focusing on what's most likely to be examined.`);
  });
  tool("upload", "Summarise", "Upload a PDF or photo", () => {
    cardActions.goto("core");
    setTimeout(() => (document.querySelector('.dock input[type="file"]') as HTMLInputElement | null)?.click(), 400);
    toast("Summarise", "Attach your course PDF or a photo of your notes, then send.");
  });
  tool("cal", "Study plan", "Exam countdown plan", async () => {
    const t = await askText("Which exam, and when?", "e.g. Networks exam on Dec 3");
    if (t) cardActions.ask(`Build me a day-by-day study plan for: ${t}. Add the sessions as tasks with due dates.`);
  });
  tool("timer", "Deep work", "Start 50 min session", () => {
    startFocus(50, "Deep work");
    toast("Focus", "50-minute deep work session started.");
  });

  const decks = h("div", { class: "stagger" });
  if (!state.decks.length) {
    const e = h("div", { class: "empty" });
    e.innerHTML = '<b>No decks yet</b>Ask: "Jarvis, make flashcards on photosynthesis".';
    decks.append(e);
  }
  state.decks.forEach((d, i) => decks.append(deckItem(d, i)));

  root.replaceChildren(
    h("div", { class: "view-title" }, "Study Lab", h("small", {}, "learn · focus · recall")),
    h("p", { class: "view-sub" }, "Your tutor, timer and memory trainer."),
    focusPanel,
    h("div", { class: "section-label" }, "Tutor tools"),
    tools,
    h("div", { class: "section-label" }, "Flashcard decks"),
    decks,
  );
  paint();
}

export function mountStudy(el: HTMLElement) {
  root = el;
  render();
  clearInterval(tickId);
  tickId = window.setInterval(tick, 1000);
}
