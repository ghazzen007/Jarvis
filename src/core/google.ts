import { state } from "./store";

// Google Identity Services token flow (runs fully in the browser; the access
// token never leaves your phone except to call Google's own APIs).
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string }): void; callback: (r: TokenResponse) => void }
interface GIS { accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void }): TokenClient; revoke(t: string, cb?: () => void): void } } }

let token = "";
let expiry = 0;
let client: TokenClient | null = null;

function loadGis(): Promise<GIS> {
  const w = window as unknown as { google?: GIS };
  if (w.google?.accounts) return Promise.resolve(w.google);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve((window as unknown as { google: GIS }).google);
    s.onerror = () => reject(new Error("Could not load Google sign-in."));
    document.head.append(s);
  });
}

export function googleReady(): boolean {
  return !!token && Date.now() < expiry;
}

export function googleConfigured(): boolean {
  return !!state.settings.googleClientId;
}

/** Interactive connect (must be called from a tap). */
export async function connectGoogle(prompt = "consent"): Promise<void> {
  if (!state.settings.googleClientId) throw new Error("Add your Google OAuth Client ID in Settings first.");
  const g = await loadGis();
  await new Promise<void>((resolve, reject) => {
    client = g.accounts.oauth2.initTokenClient({
      client_id: state.settings.googleClientId,
      scope: SCOPES,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error || "Google sign-in failed."));
        token = r.access_token;
        expiry = Date.now() + ((r.expires_in ?? 3600) - 60) * 1000;
        localStorage.setItem("jarvis:google-linked", "1");
        resolve();
      },
    });
    client.requestAccessToken({ prompt });
  });
}

export function disconnectGoogle() {
  const w = window as unknown as { google?: GIS };
  if (token && w.google) w.google.accounts.oauth2.revoke(token);
  token = "";
  expiry = 0;
  localStorage.removeItem("jarvis:google-linked");
}

export function wasLinked(): boolean {
  return localStorage.getItem("jarvis:google-linked") === "1";
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (!googleReady()) {
    if (wasLinked() && googleConfigured()) await connectGoogle("");
    else throw new Error("Google isn't connected. Open Profile → Connections → Connect Google.");
  }
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/* ---------------------------- Gmail ---------------------------------- */

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType: string; body?: { data?: string }; parts?: GmailPart[] }
interface GmailMsg { id: string; snippet: string; payload: GmailPart & { headers: GmailHeader[] } }

const hdr = (m: GmailMsg, n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";

export async function listInbox(query = "is:unread in:inbox", max = 8) {
  const list = await api<{ messages?: { id: string }[] }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
  );
  const ids = list.messages ?? [];
  const msgs = await Promise.all(
    ids.map((m) =>
      api<GmailMsg>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      ),
    ),
  );
  return msgs.map((m) => ({ id: m.id, from: hdr(m, "From"), subject: hdr(m, "Subject"), date: hdr(m, "Date"), snippet: m.snippet }));
}

function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function findText(p: GmailPart): string {
  if (p.mimeType === "text/plain" && p.body?.data) return b64urlDecode(p.body.data);
  for (const c of p.parts ?? []) {
    const t = findText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data)
    return b64urlDecode(p.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return "";
}

export async function readEmail(id: string) {
  const m = await api<GmailMsg>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  return { id, from: hdr(m, "From"), to: hdr(m, "To"), subject: hdr(m, "Subject"), date: hdr(m, "Date"), body: findText(m.payload).slice(0, 12000) };
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encodeHeader = (s: string) => (/[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=` : s);

export async function sendEmail(to: string, subject: string, body: string, cc?: string) {
  const raw = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ]
    .filter((l, i) => l !== "" || i > 3)
    .join("\r\n");
  return api<{ id: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64urlEncode(raw) }),
  });
}

/* --------------------------- Calendar -------------------------------- */

interface GEvent { summary?: string; location?: string; start: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }

export async function listEvents(fromISO: string, toISO: string) {
  const r = await api<{ items?: GEvent[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${encodeURIComponent(fromISO)}&timeMax=${encodeURIComponent(toISO)}`,
  );
  return (r.items ?? []).map((e) => ({
    title: e.summary ?? "(untitled)",
    start: e.start.dateTime ?? e.start.date ?? "",
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location,
  }));
}

export async function createEvent(ev: { title: string; start: string; end?: string; description?: string; location?: string }) {
  const start = new Date(ev.start);
  const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 60 * 60 * 1000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return api<{ id: string; htmlLink: string }>("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: ev.title,
      description: ev.description,
      location: ev.location,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    }),
  });
}
