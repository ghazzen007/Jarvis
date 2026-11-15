import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { state, commit, uid, type CardData, type Contact } from "./store";
import * as google from "./google";
import { normalizePhone } from "./util";

/** Hooks the tools use to talk to the interface. */
export interface ToolUI {
  card(c: CardData): void;
  /** Ask the user to approve an outward-facing action. Resolves true on approve. */
  confirm(c: CardData, prompt: string): Promise<boolean>;
  startFocus(minutes: number, label: string): void;
}

const isoDate = z.string().describe("ISO 8601 date-time in the user's local time, e.g. 2026-11-14T18:30:00");

const S = {
  create_task: z.object({
    title: z.string().min(1),
    due: isoDate.optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    category: z.enum(["study", "work", "personal", "errand", "health"]).optional(),
    notes: z.string().optional(),
  }),
  list_tasks: z.object({ filter: z.enum(["open", "today", "overdue", "done", "all"]).optional() }),
  complete_task: z.object({ id: z.string().describe("Task id from list_tasks or the context block") }),
  set_reminder: z.object({ message: z.string().min(1), at: isoDate }),
  save_note: z.object({ title: z.string().min(1), content: z.string(), tags: z.array(z.string()).optional() }),
  search_notes: z.object({ query: z.string() }),
  remember_fact: z.object({ fact: z.string().min(3).describe("A durable fact or preference about the user, phrased in third person") }),
  find_contact: z.object({ query: z.string() }),
  save_contact: z.object({ name: z.string().min(1), phone: z.string().optional(), email: z.string().optional(), relation: z.string().optional() }),
  prepare_call: z.object({
    contact: z.string().optional().describe("Contact name to look up"),
    phone: z.string().optional().describe("Explicit phone number if given"),
    purpose: z.string().optional().describe("Short talking points for the call"),
  }),
  prepare_message: z.object({
    channel: z.enum(["sms", "whatsapp"]),
    contact: z.string().optional(),
    phone: z.string().optional(),
    text: z.string().min(1),
  }),
  compose_email: z.object({
    to: z.string().describe("Recipient email address, or a contact name to resolve"),
    subject: z.string(),
    body: z.string(),
    cc: z.string().optional(),
  }),
  check_inbox: z.object({
    query: z.string().optional().describe("Gmail search query, default 'is:unread in:inbox'"),
    max: z.number().int().min(1).max(20).optional(),
  }),
  read_email: z.object({ id: z.string() }),
  calendar_events: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  create_calendar_event: z.object({
    title: z.string(),
    start: isoDate,
    end: isoDate.optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  }),
  get_weather: z.object({ place: z.string().optional().describe("City name; omit to use the phone's location") }),
  create_flashcards: z.object({
    deck: z.string().describe("Deck name, e.g. 'Linear Algebra — Eigenvalues'"),
    cards: z.array(z.object({ q: z.string(), a: z.string() })).min(1).max(40),
  }),
  start_focus_timer: z.object({ minutes: z.number().int().min(1).max(180), label: z.string().optional() }),
  open_link: z.object({ url: z.string().url(), label: z.string() }),
  find_business_leads: z.object({
    count: z.number().int().min(3).max(10).optional().describe("How many businesses to find (default 7)"),
    area: z.string().optional().describe("Area to search; omit to use the user's location"),
  }),
  list_leads: z.object({ status: z.enum(["new", "contacted", "replied", "demo", "won", "lost", "all"]).optional() }),
};

type Name = keyof typeof S;

const DESCRIPTIONS: Record<Name, string> = {
  create_task: "Add a to-do to the user's task list. Use for anything they need to do (study, errands, work).",
  list_tasks: "List the user's tasks with their ids.",
  complete_task: "Mark a task as done.",
  set_reminder: "Schedule a reminder notification at a specific local date-time.",
  save_note: "Save a note (meeting notes, ideas, summaries, study notes).",
  search_notes: "Search the user's saved notes by keyword.",
  remember_fact: "Store a lasting fact or preference about the user (e.g. their schedule, a person's role, a goal) so future sessions know it.",
  find_contact: "Look up a saved contact by name, relation, phone or email.",
  save_contact: "Save or update a contact.",
  prepare_call:
    "Prepare a phone call. Shows the user a call card with a dial button (the phone app does the actual call). Resolves contact names automatically.",
  prepare_message: "Prepare an SMS or WhatsApp message. Shows a card the user taps to send through their messaging app.",
  compose_email:
    "Draft an email to someone the user explicitly asked to contact (or a contact/inbox sender). The user sees the draft and must approve before it is sent (via Gmail if connected, otherwise via their mail app). Never use it to 'register', 'sync' or notify services, and never claim an email is sent unless this tool's result says so.",
  check_inbox: "List recent Gmail messages matching a query (requires Google connection).",
  read_email: "Read the full text of one Gmail message by id.",
  calendar_events: "List Google Calendar events in a time range (default: now until end of tomorrow).",
  create_calendar_event: "Create a Google Calendar event with a 10-minute popup reminder.",
  get_weather: "Current weather and today's range for a place.",
  create_flashcards: "Create a flashcard deck for spaced-repetition study in the Study tab.",
  start_focus_timer: "Start a Pomodoro-style focus timer.",
  open_link: "Offer the user a button to open a useful link (maps, docs, a video, a course page).",
  find_business_leads:
    "Client Hunter: search the web for local businesses near the user that have no website (potential web-design clients) and add them to the Clients list in the Comms tab. It does NOT contact anyone — the user reviews each lead, then sends the pitch themselves from the Clients list.",
  list_leads: "List the user's web-design client leads and their status (new, contacted, replied, demo, won, lost).",
};

/** Provider-neutral tool definitions (JSON Schema), shared by Claude, Gemini and Groq. */
export const CLIENT_TOOLS: { name: string; description: string; schema: Record<string, unknown> }[] = (Object.keys(S) as Name[]).map((name) => {
  const schema = z.toJSONSchema(S[name]) as Record<string, unknown>;
  delete schema.$schema;
  return { name, description: DESCRIPTIONS[name], schema };
});

export const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  ...CLIENT_TOOLS.map(
    (t) =>
      ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
        eager_input_streaming: true,
      }) satisfies Anthropic.Beta.BetaTool,
  ),
  { type: "web_search_20260209", name: "web_search", max_uses: 6 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
];

export const TOOL_LABELS: Record<string, string> = {
  web_search: "Searching the web",
  web_fetch: "Reading a page",
  create_task: "Adding task",
  list_tasks: "Checking tasks",
  complete_task: "Updating task",
  set_reminder: "Setting reminder",
  save_note: "Saving note",
  search_notes: "Searching notes",
  remember_fact: "Updating memory",
  find_contact: "Looking up contact",
  save_contact: "Saving contact",
  prepare_call: "Preparing call",
  prepare_message: "Preparing message",
  compose_email: "Drafting email",
  check_inbox: "Checking inbox",
  read_email: "Reading email",
  calendar_events: "Checking calendar",
  create_calendar_event: "Scheduling event",
  get_weather: "Checking weather",
  create_flashcards: "Building flashcards",
  start_focus_timer: "Starting focus timer",
  open_link: "Preparing link",
  find_business_leads: "Hunting for clients",
  list_leads: "Checking clients",
};

function findContacts(q: string): Contact[] {
  const s = q.toLowerCase().trim();
  const digits = normalizePhone(q);
  return state.contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(s) ||
      (c.relation ?? "").toLowerCase().includes(s) ||
      (c.email ?? "").toLowerCase().includes(s) ||
      (digits.length > 4 && normalizePhone(c.phone ?? "").includes(digits)),
  );
}

const WEATHER: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "heavy showers", 82: "violent showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
};

async function weather(place?: string) {
  let lat: number, lon: number, name: string;
  if (place) {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(place)}`).then((r) => r.json());
    const hit = g.results?.[0];
    if (!hit) throw new Error(`Couldn't find a place called ${place}.`);
    ({ latitude: lat, longitude: lon } = hit);
    name = `${hit.name}, ${hit.country_code}`;
  } else {
    const pos = await new Promise<GeolocationPosition>((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 600000 }),
    ).catch(() => null);
    if (!pos) throw new Error("Location unavailable — ask the user for a city.");
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
    name = state.profile.location || "your location";
  }
  const w = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`,
  ).then((r) => r.json());
  return {
    place: name,
    temp: Math.round(w.current.temperature_2m),
    code: w.current.weather_code as number,
    now: WEATHER[w.current.weather_code] ?? "—",
    wind_kmh: w.current.wind_speed_10m,
    humidity: w.current.relative_humidity_2m,
    high: Math.round(w.daily.temperature_2m_max[0]),
    low: Math.round(w.daily.temperature_2m_min[0]),
    rain_chance: w.daily.precipitation_probability_max[0],
  };
}

/** Validate a tool input (inputs stream eagerly, so the server doesn't validate them) and run it. */
export async function runTool(name: string, input: unknown, ui: ToolUI): Promise<{ content: string; isError?: boolean }> {
  if (!(name in S)) return { content: `Unknown tool ${name}`, isError: true };
  const parsed = S[name as Name].safeParse(input);
  if (!parsed.success) {
    return { content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }), isError: true };
  }
  try {
    const out = await exec(name as Name, parsed.data as never, ui);
    return { content: typeof out === "string" ? out : JSON.stringify(out) };
  } catch (e) {
    return { content: (e as Error).message || String(e), isError: true };
  }
}

async function exec(name: Name, a: Record<string, never>, ui: ToolUI): Promise<unknown> {
  const p = state.profile;
  switch (name) {
    case "create_task": {
      const i = a as unknown as z.infer<typeof S.create_task>;
      const t = { id: uid(), title: i.title, due: i.due, priority: i.priority ?? "normal", category: i.category ?? "personal", notes: i.notes, done: false, createdAt: Date.now() };
      state.tasks.unshift(t);
      commit("tasks");
      ui.card({ kind: "task", title: t.title, due: t.due, priority: t.priority });
      return { ok: true, id: t.id };
    }
    case "list_tasks": {
      const f = (a as unknown as z.infer<typeof S.list_tasks>).filter ?? "open";
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      const list = state.tasks.filter((t) => {
        if (f === "all") return true;
        if (f === "done") return t.done;
        if (t.done) return false;
        if (f === "today") return !!t.due && new Date(t.due).getTime() < end;
        if (f === "overdue") return !!t.due && new Date(t.due).getTime() < now.getTime();
        return true;
      });
      return list.slice(0, 40).map(({ id, title, due, priority, category, done }) => ({ id, title, due, priority, category, done }));
    }
    case "complete_task": {
      const t = state.tasks.find((x) => x.id === (a as unknown as { id: string }).id);
      if (!t) throw new Error("No task with that id.");
      t.done = true;
      t.doneAt = Date.now();
      commit("tasks");
      return { ok: true, title: t.title };
    }
    case "set_reminder": {
      const i = a as unknown as z.infer<typeof S.set_reminder>;
      if (isNaN(new Date(i.at).getTime())) throw new Error("Invalid date-time.");
      state.reminders.push({ id: uid(), message: i.message, at: i.at, fired: false });
      commit("reminders");
      if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
      ui.card({ kind: "reminder", message: i.message, at: i.at });
      return { ok: true, note: "Reminder fires while Jarvis is open or in the background; for guaranteed alerts also create a calendar event." };
    }
    case "save_note": {
      const i = a as unknown as z.infer<typeof S.save_note>;
      const n = { id: uid(), title: i.title, content: i.content, tags: i.tags ?? [], createdAt: Date.now(), updatedAt: Date.now() };
      state.notes.unshift(n);
      commit("notes");
      ui.card({ kind: "note", title: n.title });
      return { ok: true, id: n.id };
    }
    case "search_notes": {
      const q = (a as unknown as { query: string }).query.toLowerCase();
      return state.notes
        .filter((n) => (n.title + " " + n.content + " " + n.tags.join(" ")).toLowerCase().includes(q))
        .slice(0, 8)
        .map((n) => ({ title: n.title, content: n.content.slice(0, 1500), tags: n.tags }));
    }
    case "remember_fact": {
      const f = (a as unknown as { fact: string }).fact.trim();
      if (!p.memory.includes(f)) p.memory.push(f);
      if (p.memory.length > 80) p.memory.shift();
      commit("profile");
      return { ok: true };
    }
    case "find_contact":
      return findContacts((a as unknown as { query: string }).query).slice(0, 8);
    case "save_contact": {
      const i = a as unknown as z.infer<typeof S.save_contact>;
      const ex = state.contacts.find((c) => c.name.toLowerCase() === i.name.toLowerCase());
      if (ex) Object.assign(ex, Object.fromEntries(Object.entries(i).filter(([, v]) => v)));
      else state.contacts.push({ id: uid(), ...i });
      commit("contacts");
      return { ok: true };
    }
    case "prepare_call": {
      const i = a as unknown as z.infer<typeof S.prepare_call>;
      let phone = i.phone;
      let nm = i.contact ?? i.phone ?? "";
      if (!phone && i.contact) {
        const hits = findContacts(i.contact).filter((c) => c.phone);
        if (hits.length === 0) return { ok: false, reason: `No saved number for "${i.contact}". Ask the user for the number or to import contacts in the Comms tab.` };
        if (hits.length > 1 && !hits.some((h) => h.name.toLowerCase() === i.contact!.toLowerCase()))
          return { ok: false, ambiguous: hits.map((h) => ({ name: h.name, relation: h.relation })) };
        const c = hits.find((h) => h.name.toLowerCase() === i.contact!.toLowerCase()) ?? hits[0];
        phone = c.phone!;
        nm = c.name;
      }
      if (!phone) throw new Error("Need a contact name or phone number.");
      ui.card({ kind: "call", name: nm, phone, purpose: i.purpose });
      return { ok: true, shown: "Call card displayed — the user taps Call to dial." };
    }
    case "prepare_message": {
      const i = a as unknown as z.infer<typeof S.prepare_message>;
      let phone = i.phone;
      let nm = i.contact ?? i.phone ?? "";
      if (!phone && i.contact) {
        const c = findContacts(i.contact).find((x) => x.phone);
        if (!c) return { ok: false, reason: `No saved number for "${i.contact}".` };
        phone = c.phone!;
        nm = c.name;
      }
      if (!phone) throw new Error("Need a contact name or phone number.");
      ui.card({ kind: "message", channel: i.channel, name: nm, phone, text: i.text });
      return { ok: true, shown: "Message card displayed — the user taps Send to open their messaging app." };
    }
    case "compose_email": {
      const i = a as unknown as z.infer<typeof S.compose_email>;
      let to = i.to;
      if (!to.includes("@")) {
        const c = findContacts(to).find((x) => x.email);
        if (!c) return { ok: false, reason: `No saved email for "${to}". Ask the user for the address.` };
        to = c.email!;
      }
      const card: Extract<CardData, { kind: "email" }> = { kind: "email", to, cc: i.cc, subject: i.subject, body: i.body, status: "draft" };
      if (google.googleConfigured() && (google.googleReady() || google.wasLinked())) {
        // The user can edit subject/body on the card before approving.
        const ok = await ui.confirm(card, "Send this email from your Gmail?");
        if (!ok) return { ok: false, status: "User chose not to send (they may edit or send it manually)." };
        await google.sendEmail(card.to, card.subject, card.body, card.cc);
        const edited = card.subject !== i.subject || card.body.trim() !== i.body.trim();
        return { ok: true, status: "sent via Gmail", ...(edited ? { note: "The user edited the draft before sending." } : {}) };
      }
      ui.card(card);
      return { ok: true, status: "Draft shown with an 'Open in Mail' button; the user sends it from their mail app. Not sent yet." };
    }
    case "check_inbox": {
      const i = a as unknown as z.infer<typeof S.check_inbox>;
      const items = await google.listInbox(i.query, i.max ?? 8);
      ui.card({ kind: "inbox", items });
      return items;
    }
    case "read_email":
      return google.readEmail((a as unknown as { id: string }).id);
    case "calendar_events": {
      const i = a as unknown as z.infer<typeof S.calendar_events>;
      const from = i.from ? new Date(i.from) : new Date();
      const now = new Date();
      const to = i.to ? new Date(i.to) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
      const items = await google.listEvents(from.toISOString(), to.toISOString());
      ui.card({ kind: "events", items });
      return items;
    }
    case "create_calendar_event": {
      const i = a as unknown as z.infer<typeof S.create_calendar_event>;
      const r = await google.createEvent(i);
      ui.card({ kind: "events", items: [{ title: i.title, start: i.start, end: i.end, location: i.location }] });
      return { ok: true, link: r.htmlLink };
    }
    case "get_weather": {
      const w = await weather((a as unknown as { place?: string }).place);
      ui.card({ kind: "weather", place: w.place, now: w.now, temp: w.temp, high: w.high, low: w.low, code: w.code });
      return w;
    }
    case "create_flashcards": {
      const i = a as unknown as z.infer<typeof S.create_flashcards>;
      const deck = { id: uid(), name: i.deck, createdAt: Date.now(), cards: i.cards.map((c) => ({ ...c, box: 0, due: 0 })) };
      state.decks.unshift(deck);
      commit("decks");
      ui.card({ kind: "deck", deckId: deck.id, name: deck.name, count: deck.cards.length });
      return { ok: true, cards: deck.cards.length };
    }
    case "start_focus_timer": {
      const i = a as unknown as z.infer<typeof S.start_focus_timer>;
      ui.startFocus(i.minutes, i.label ?? "Focus");
      ui.card({ kind: "focus", minutes: i.minutes, label: i.label ?? "Focus" });
      return { ok: true };
    }
    case "find_business_leads": {
      const i = a as unknown as z.infer<typeof S.find_business_leads>;
      const { findLeads } = await import("./hunter");
      const leads = await findLeads(i.count ?? 7, i.area);
      ui.card({ kind: "leads", count: leads.length, names: leads.map((l) => `${l.name} · ${l.category}`) });
      return {
        ok: true,
        found: leads.map((l) => ({ name: l.name, category: l.category, email: !!l.email, phone: !!l.phone, instagram: !!l.instagram, facebook: !!l.facebook })),
        next: "Leads saved in Comms → Clients. The user opens each one to review, generate the pitch and send it.",
      };
    }
    case "list_leads": {
      const st = (a as unknown as { status?: string }).status ?? "all";
      return state.leads
        .filter((l) => st === "all" || l.status === st)
        .slice(0, 30)
        .map(({ name, category, status, contactedAt, channel }) => ({ name, category, status, channel, contacted: contactedAt ? new Date(contactedAt).toDateString() : undefined }));
    }
    case "open_link": {
      const i = a as unknown as z.infer<typeof S.open_link>;
      if (!/^https?:\/\//.test(i.url)) throw new Error("Only http(s) links.");
      ui.card({ kind: "link", url: i.url, label: i.label });
      return { ok: true };
    }
  }
}
