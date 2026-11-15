import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { state, loadState, onChange } from "./core/store";
import { Orb } from "./visual/orb";
import * as voice from "./core/voice";
import { startScheduler } from "./core/scheduler";
import { mountHome, send, startListening, refreshReadout, setFocusStarter, rerenderFeed } from "./ui/home";
import { mountTasks, render as renderTasks } from "./ui/tasks";
import { mountComms, render as renderComms, openClients } from "./ui/comms";
import { mountStudy, render as renderStudy, startFocus, openDeck } from "./ui/study";
import { mountProfile, render as renderProfile, showOnboarding, setSettingsListener, hasKey } from "./ui/profile";
import { initOverlays, toast } from "./ui/overlay";
import { cardActions } from "./ui/cards";
import { icon } from "./ui/icons";
import { h, todayKey } from "./core/util";

type View = "core" | "tasks" | "comms" | "study" | "profile";
const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "core", label: "Core", icon: "core" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "comms", label: "Comms", icon: "comms" },
  { id: "study", label: "Study", icon: "study" },
  { id: "profile", label: "Profile", icon: "user" },
];
const renderers: Record<View, () => void> = {
  core: refreshReadout,
  tasks: renderTasks,
  comms: renderComms,
  study: renderStudy,
  profile: renderProfile,
};

let orb: Orb;
let current: View = "core";
const sections = {} as Record<View, HTMLElement>;
const tabs = {} as Record<View, HTMLButtonElement>;
let indicator: HTMLElement;

function moveIndicator() {
  const t = tabs[current];
  indicator.style.width = `${t.offsetWidth}px`;
  indicator.style.transform = `translateX(${t.offsetLeft - 6}px)`;
}

function goto(v: View) {
  if (!sections[v]) return;
  if (v !== current) {
    const prev = sections[current];
    prev.classList.add("leaving");
    prev.classList.remove("active");
    setTimeout(() => prev.classList.remove("leaving"), 600);
  }
  current = v;
  renderers[v]();
  sections[v].classList.add("active");
  Object.entries(tabs).forEach(([k, b]) => b.classList.toggle("on", k === v));
  document.body.dataset.view = v;
  orb.setLayout(v === "core" ? "hero" : "ambient");
  moveIndicator();
  if (navigator.vibrate) navigator.vibrate(6);
}

function buildShell() {
  const main = document.getElementById("views")!;
  const nav = document.getElementById("tabbar")!;
  indicator = h("div", { class: "tab-ind" });
  nav.append(indicator);
  for (const v of VIEWS) {
    const sec = h("section", { class: `view ${v.id}`, "data-view": v.id });
    sections[v.id] = sec;
    main.append(sec);
    const b = h("button", { type: "button", "aria-label": v.label }) as HTMLButtonElement;
    b.innerHTML = `${icon(v.icon)}<span>${v.label}</span>`;
    b.addEventListener("click", () => goto(v.id));
    tabs[v.id] = b;
    nav.append(b);
  }
  addEventListener("resize", moveIndicator);
}

function clock() {
  const t = document.getElementById("clock-time")!;
  const d = document.getElementById("clock-date")!;
  const upd = () => {
    const now = new Date();
    t.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    d.textContent = now.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" });
  };
  upd();
  setInterval(upd, 1000 * 15);
}

function greeting(): string {
  const hr = new Date().getHours();
  const who = state.profile.addressAs || "sir";
  if (hr < 5) return `Working late again, ${who}? All systems are online.`;
  if (hr < 12) return `Good morning, ${who}. All systems are online.`;
  if (hr < 18) return `Good afternoon, ${who}. Systems online and ready.`;
  return `Good evening, ${who}. All systems are online.`;
}

function applyWake() {
  if (state.settings.wakeWord && voice.canListen) {
    voice.startWake((cmd) => {
      goto("core");
      if (cmd) void send(cmd);
      else {
        voice.speak(`Yes, ${state.profile.addressAs || "sir"}?`);
        setTimeout(() => startListening(), 900);
      }
    });
  } else voice.disableWake();
}

async function boot() {
  const lines = Array.from(document.querySelectorAll<HTMLElement>(".boot-lines div"));
  const bar = document.querySelector<HTMLElement>(".boot-bar i")!;
  const loaded = loadState();
  for (let i = 0; i < lines.length; i++) {
    await new Promise((r) => setTimeout(r, 230 + Math.random() * 160));
    lines[i].classList.add("on");
    bar.style.width = `${((i + 1) / lines.length) * 100}%`;
  }
  await loaded;
  return new Promise<boolean>((resolve) => {
    const cta = document.querySelector<HTMLElement>(".boot-cta")!;
    cta.classList.add("on");
    const bootEl = document.getElementById("boot")!;
    const auto = setTimeout(() => resolve(false), 3500);
    bootEl.addEventListener(
      "click",
      () => {
        clearTimeout(auto);
        resolve(true);
      },
      { once: true },
    );
  });
}

async function start() {
  registerSW({ immediate: true });
  initOverlays();
  const tapped = await boot();

  orb = new Orb(document.getElementById("orb") as HTMLCanvasElement, state.settings.reducedMotion);
  orb.setLevelSource(voice.voiceLevel);
  buildShell();
  mountHome(sections.core, orb);
  mountTasks(sections.tasks);
  mountComms(sections.comms);
  mountStudy(sections.study);
  mountProfile(sections.profile);
  setFocusStarter(startFocus);
  clock();

  cardActions.ask = (text) => {
    goto("core");
    void send(text);
  };
  cardActions.openDeck = openDeck;
  cardActions.openClients = () => {
    openClients();
    goto("comms");
  };
  cardActions.goto = (v) => goto(v as View);
  const w = window as unknown as { jarvisGoto(v: string): void; jarvisRefresh(): void };
  w.jarvisGoto = (v) => goto(v as View);
  w.jarvisRefresh = () => rerenderFeed();

  // keep visible views fresh when data changes (e.g. Jarvis adds a task by voice)
  onChange((key) => {
    if (key === "tasks" || key === "reminders" || key === "notes") current === "tasks" ? renderTasks() : refreshReadout();
    if ((key === "contacts" || key === "leads") && current === "comms") renderComms();
    if (key === "decks" && current === "study") renderStudy();
    if (key === "focus" || key === "profile") refreshReadout();
  });
  setSettingsListener(() => {
    applyWake();
    refreshReadout();
  });

  goto("core");
  document.getElementById("boot")!.classList.add("gone");
  document.body.classList.add("ready");
  setTimeout(() => orb.assembleIn(), 150);

  startScheduler((title, body) => {
    toast(title, body, 9000);
    voice.speak(`Pardon the interruption, ${state.profile.addressAs || "sir"}. ${title === "Reminder" ? "A reminder" : "This task is now due"}: ${body}`);
  });
  applyWake();
  voice.onVoiceIssue((msg) => toast("Voice", msg, 7000));

  // Morning nudge for the daily client hunt (once the user has started using it).
  const hs = state.settings.hunter;
  const todayStr = todayKey();
  if ((state.leads.length || hs.area) && hs.lastHunt !== todayStr && new Date().getHours() >= 8)
    setTimeout(() => toast("Client hunt", "Today's hunt hasn't run yet — Comms → Clients, or say “run today's client hunt”.", 9000), 4000);

  const action = new URLSearchParams(location.search).get("action");
  if (!hasKey()) setTimeout(showOnboarding, 1600);
  else if (action === "listen") setTimeout(() => startListening(), 1200);
  else if (action === "brief") setTimeout(() => void send("Give me my briefing: weather, today's calendar, important unread email, and tasks due today. Keep it tight."), 1200);
  else if (tapped) setTimeout(() => voice.speak(greeting()), 900);
}

void start();
