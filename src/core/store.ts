import type Anthropic from "@anthropic-ai/sdk";
import { kvGet, kvSet } from "./db";

export type Priority = "low" | "normal" | "high";
export type Category = "study" | "work" | "personal" | "errand" | "health";

export interface Task {
  id: string;
  title: string;
  notes?: string;
  due?: string; // ISO datetime
  priority: Priority;
  category: Category;
  done: boolean;
  createdAt: number;
  doneAt?: number;
}

export interface Reminder {
  id: string;
  message: string;
  at: string; // ISO datetime
  fired: boolean;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Contact {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  relation?: string;
}

export interface Flashcard {
  q: string;
  a: string;
  box: number; // Leitner box 0..4
  due: number; // epoch ms
}

export interface Deck {
  id: string;
  name: string;
  cards: Flashcard[];
  createdAt: number;
}

export interface Profile {
  name: string;
  addressAs: string;
  headline: string;
  location: string;
  languages: string[];
  education: string[];
  experience: string[];
  skills: string[];
  tools: string[];
  interests: string[];
  dailyRoutines: string[];
  goals: string[];
  memory: string[]; // facts Jarvis learned in conversation
  cvImported: boolean;
}

export type Effort = "low" | "medium" | "high";
export type Provider = "claude" | "gemini" | "groq";

export interface Settings {
  provider: Provider;
  apiKey: string; // Claude
  model: string; // Claude model
  geminiKey: string;
  geminiModel: string;
  groqKey: string;
  groqModel: string;
  effort: Effort;
  speak: boolean;
  voiceName: string;
  voiceRate: number;
  voicePitch: number;
  language: string; // BCP-47 for speech recognition / synthesis
  elevenKey: string;
  elevenVoiceId: string;
  voiceFx: boolean;
  wakeWord: boolean;
  googleClientId: string;
  reducedMotion: boolean;
}

export type CardData =
  | { kind: "email"; to: string; cc?: string; subject: string; body: string; status: "draft" | "sent" | "cancelled" }
  | { kind: "call"; name: string; phone: string; purpose?: string }
  | { kind: "message"; channel: "sms" | "whatsapp"; name: string; phone: string; text: string }
  | { kind: "task"; title: string; due?: string; priority: Priority }
  | { kind: "reminder"; message: string; at: string }
  | { kind: "link"; url: string; label: string }
  | { kind: "sources"; items: { title: string; url: string }[] }
  | { kind: "inbox"; items: { id: string; from: string; subject: string; snippet: string; date: string }[] }
  | { kind: "events"; items: { title: string; start: string; end?: string; location?: string }[] }
  | { kind: "weather"; place: string; now: string; temp: number; high: number; low: number; code: number }
  | { kind: "deck"; deckId: string; name: string; count: number }
  | { kind: "focus"; minutes: number; label: string }
  | { kind: "note"; title: string };

export interface DisplayMsg {
  id: string;
  role: "user" | "jarvis" | "card" | "error";
  text?: string;
  card?: CardData;
  attachments?: string[];
  ts: number;
}

export interface Session {
  id: string;
  system: string; // frozen at session start (keeps prompt cache + thinking blocks valid)
  messages: Anthropic.Beta.BetaMessageParam[];
  display: DisplayMsg[];
  /** Native history for the free providers (Gemini contents / Groq messages), kept unchanged. */
  alt?: { provider: Provider; messages: unknown[] };
  createdAt: number;
  updatedAt: number;
}

export interface FocusLog {
  date: string; // YYYY-MM-DD
  minutes: number;
}

export interface State {
  settings: Settings;
  profile: Profile;
  tasks: Task[];
  reminders: Reminder[];
  notes: Note[];
  contacts: Contact[];
  decks: Deck[];
  focus: FocusLog[];
  session: Session | null;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "claude",
  apiKey: "",
  model: "claude-opus-5-5",
  geminiKey: "",
  geminiModel: "gemini-flash-lite-latest",
  groqKey: "",
  groqModel: "openai/gpt-oss-120b",
  effort: "low",
  speak: true,
  voiceName: "",
  voiceRate: 1.02,
  voicePitch: 0.92,
  language: "en-GB",
  elevenKey: "",
  elevenVoiceId: "",
  voiceFx: true,
  wakeWord: false,
  googleClientId: "",
  reducedMotion: false,
};

export const DEFAULT_PROFILE: Profile = {
  name: "",
  addressAs: "sir",
  headline: "",
  location: "",
  languages: [],
  education: [],
  experience: [],
  skills: [],
  tools: [],
  interests: [],
  dailyRoutines: [],
  goals: [],
  memory: [],
  cvImported: false,
};

export const state: State = {
  settings: { ...DEFAULT_SETTINGS },
  profile: { ...DEFAULT_PROFILE },
  tasks: [],
  reminders: [],
  notes: [],
  contacts: [],
  decks: [],
  focus: [],
  session: null,
};

type Key = keyof State;
const KEYS: Key[] = ["settings", "profile", "tasks", "reminders", "notes", "contacts", "decks", "focus", "session"];

type Listener = (key: Key) => void;
const listeners = new Set<Listener>();

export function onChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const timers = new Map<Key, number>();

/** Mark a slice as changed: notifies listeners and persists (debounced). */
export function commit(key: Key): void {
  listeners.forEach((fn) => fn(key));
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.set(
    key,
    window.setTimeout(() => {
      void kvSet(key, state[key]);
      timers.delete(key);
    }, 250),
  );
}

export async function loadState(): Promise<void> {
  await Promise.all(
    KEYS.map(async (k) => {
      const v = await kvGet<unknown>(k);
      if (v === undefined || v === null) return;
      if (k === "settings") state.settings = { ...DEFAULT_SETTINGS, ...(v as Settings) };
      else if (k === "profile") state.profile = { ...DEFAULT_PROFILE, ...(v as Profile) };
      else (state as unknown as Record<string, unknown>)[k] = v;
    }),
  );
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
