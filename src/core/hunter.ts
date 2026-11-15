// Client Hunter: find local businesses without a website, pitch them, track them.
// Human-in-the-loop by design: Jarvis researches and drafts; the user sends.
import { state, commit, uid, type Lead } from "./store";
import { complete } from "./brain";
import { todayKey } from "./util";

const LANG_NAME = { fr: "French", en: "English", ar: "Tunisian Arabic (Derja) written in Arabic script" } as const;

/* ---------------------------------------------------------------- location */
export async function detectArea(): Promise<string> {
  const pos = await new Promise<GeolocationPosition>((res, rej) =>
    navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000, maximumAge: 30 * 60 * 1000 }),
  ).catch(() => null);
  if (!pos) throw new Error("Location is off. Allow location for Jarvis, or type your area.");
  const { latitude, longitude } = pos.coords;
  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
    ).then((x) => x.json());
    const parts = [r.locality || r.city, r.principalSubdivision, r.countryName].filter((v: string, i: number, a: string[]) => v && a.indexOf(v) === i);
    if (parts.length) return parts.join(", ");
  } catch {
    /* fall through */
  }
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

export async function ensureArea(): Promise<string> {
  const h = state.settings.hunter;
  if (h.area) return h.area;
  h.area = await detectArea();
  commit("settings");
  return h.area;
}

/* ---------------------------------------------------------------- JSON helpers */
function parseJSON<T>(text: string, open: "[" | "{"): T {
  const close = open === "[" ? "]" : "}";
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf(open);
  const b = cleaned.lastIndexOf(close);
  if (a < 0 || b <= a) throw new Error("The AI didn't return a usable list. Try again.");
  return JSON.parse(cleaned.slice(a, b + 1)) as T;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() && !/^(null|n\/a|none|unknown)$/i.test(v.trim()) ? v.trim() : undefined);
const url = (v: unknown) => {
  const s = str(v);
  return s && /^https?:\/\//.test(s) ? s : undefined;
};
const email = (v: unknown) => {
  const s = str(v);
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
};

/* ---------------------------------------------------------------- find leads */
export async function findLeads(count = 7, areaOverride?: string): Promise<Lead[]> {
  const area = areaOverride?.trim() || (await ensureArea());
  const n = Math.max(3, Math.min(10, count));
  const known = state.leads.map((l) => l.name).slice(-150);
  const prompt = `You are researching potential web-design clients for a freelance web developer based in ${area}.

Use web search (Google Maps listings, Facebook/Instagram pages, local directories) to find ${n} real, currently operating, independent local businesses in or near ${area} — cafés, restaurants, bakeries and pastry shops, beauty salons, barbers, gyms, clothing boutiques, florists, clinics, shops, etc. — that do NOT appear to have their own website (they only have a Google Maps listing and/or social media pages).

Rules:
- Only real businesses you found in your search results. No chains or franchises. Skip any business that already has its own website.
- Contact details: include a phone number, email, Instagram or Facebook URL ONLY if you actually saw it in a source. Never guess or construct emails — use null when unknown.
- "description": the business's specialty and style, based on its Maps/social description and reviews.
- "why": one short sentence on what a website would do for this specific business.
- "palette": 3 hex colours that fit its brand or style (from its logo/photos if visible, otherwise fitting its category).
- Do not include any of these already-known businesses: ${known.length ? known.join("; ") : "(none)"}.

Reply with ONLY a JSON array, no commentary. Each item:
{"name": string, "category": string, "address": string|null, "description": string, "why": string, "phone": string|null, "email": string|null, "instagram": string|null, "facebook": string|null, "mapsUrl": string|null, "source": string|null, "palette": [string, string, string]}`;

  const { text, sources } = await complete(prompt, { search: true });
  const raw = parseJSON<Record<string, unknown>[]>(text, "[");
  const seen = new Set(state.leads.map((l) => l.name.toLowerCase()));
  const leads: Lead[] = [];
  for (const r of raw) {
    const name = str(r.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const palette = Array.isArray(r.palette) ? r.palette.map(String).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 3) : [];
    leads.push({
      id: uid(),
      name,
      category: str(r.category) ?? "Local business",
      area,
      address: str(r.address),
      description: str(r.description),
      why: str(r.why),
      phone: str(r.phone),
      email: email(r.email),
      instagram: url(r.instagram),
      facebook: url(r.facebook),
      mapsUrl: url(r.mapsUrl),
      source: url(r.source) ?? sources[0]?.url,
      palette,
      status: "new",
      createdAt: Date.now(),
    });
  }
  if (!leads.length) throw new Error("No new businesses found this time. Try a nearby area or again later.");
  state.leads.unshift(...leads);
  state.settings.hunter.lastHunt = todayKey();
  commit("leads");
  commit("settings");
  return leads;
}

/* ---------------------------------------------------------------- pitch */
export async function draftPitch(lead: Lead): Promise<NonNullable<Lead["pitch"]>> {
  const h = state.settings.hunter;
  const p = state.profile;
  const lang = h.language;
  const sender = h.senderName || p.name || "the developer";
  const prompt = `Write outreach messages from a freelance web developer to a local business. Language: ${LANG_NAME[lang]}.

Business: ${lead.name} — ${lead.category} in ${lead.area}${lead.address ? ` (${lead.address})` : ""}.
What they do: ${lead.description ?? "unknown"}.
Why a website would help them: ${lead.why ?? "more visibility and bookings"}.

Sender: ${sender}${h.senderPhone ? `, phone/WhatsApp ${h.senderPhone}` : ""}${h.portfolio ? `, portfolio ${h.portfolio}` : ""}.
Offer (keep prices exactly as written):
1) ${h.pack1}
2) ${h.pack2}
3) ${h.pack3}
Every site is modern, mobile-first, with motion design and interactive 3D elements tailored to the business, and a free personalised demo before they decide.

Write:
- "subject": a short, specific email subject (no clickbait, no ALL CAPS).
- "body": a warm, professional, well-structured email of 120–180 words: one line showing you know their business specifically, the concrete benefit of a website for them, the free demo offer, the three packs as a short list, a clear call to action (reply or WhatsApp), a polite final line saying they can simply reply "no thanks" and won't be contacted again, then the signature.
- "dm": the same pitch as a friendly Instagram/Facebook/WhatsApp message under 450 characters, no links except the portfolio if given.

Reply with ONLY JSON: {"subject": string, "body": string, "dm": string}`;
  const { text } = await complete(prompt);
  const j = parseJSON<{ subject?: string; body?: string; dm?: string }>(text, "{");
  if (!j.body) throw new Error("Couldn't write the pitch. Try again.");
  lead.pitch = { subject: j.subject ?? `Website for ${lead.name}`, body: j.body, dm: j.dm ?? j.body.slice(0, 450), lang };
  commit("leads");
  return lead.pitch;
}

/* ---------------------------------------------------------------- demo prompt for Claude */
export function demoPrompt(lead: Lead): string {
  const lang = { fr: "French", en: "English", ar: "Arabic (with right-to-left layout) and French" }[state.settings.hunter.language];
  return `Build a production-quality demo website for a real local business, as a single self-contained index.html (inline CSS and JS; libraries only from cdnjs, e.g. Three.js and GSAP).

Business: ${lead.name}
Type: ${lead.category} in ${lead.area}${lead.address ? `, ${lead.address}` : ""}
Specialty & style: ${lead.description ?? "—"}
Brand palette: ${lead.palette?.length ? lead.palette.join(", ") : "derive an elegant palette that fits the business"}
Site language: ${lang}

Requirements (2026 design trends):
- Hero with an interactive 3D object tied to their specialty (e.g. a steaming coffee cup for a café, a rotating cake for a pastry shop), reacting to mouse/touch and scroll.
- Smooth scroll, scroll-triggered motion, micro-interactions, elegant page/section transitions, refined bold typography, glass surfaces, subtle grain.
- Sections: hero, about/story, menu or services with sample prices, gallery, reviews, opening hours and location (map placeholder), contact with WhatsApp button, and a booking/order form (front-end only).
- Mobile-first, fast, accessible (contrast, focus states, reduced-motion support), SEO meta tags.
- Realistic placeholder text and images (Unsplash URLs) matching the business; a small "Demo" badge in a corner.
Return the complete file only.`;
}

/* ---------------------------------------------------------------- tracking */
export function markContacted(lead: Lead, channel: string) {
  const first = lead.status === "new";
  lead.status = lead.status === "new" ? "contacted" : lead.status;
  lead.contactedAt = Date.now();
  lead.channel = channel;
  commit("leads");
  if (first) {
    const at = new Date();
    at.setDate(at.getDate() + 3);
    at.setHours(10, 0, 0, 0);
    state.reminders.push({ id: uid(), message: `Follow up with ${lead.name} (${channel})`, at: at.toISOString(), fired: false });
    commit("reminders");
  }
}

export function hunterSummary() {
  const by = (s: Lead["status"]) => state.leads.filter((l) => l.status === s).length;
  return { total: state.leads.length, new: by("new"), contacted: by("contacted"), replied: by("replied"), demo: by("demo"), won: by("won") };
}
