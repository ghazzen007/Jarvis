import { state, commit, DEFAULT_PROFILE, type Effort, type Profile, type Provider } from "../core/store";
import { PROVIDER_INFO, listModels } from "../core/providers";
import { kvClear } from "../core/db";
import { MODELS, extractProfileFromCV, noteProfileChanged, resetSession } from "../core/brain";
import * as google from "../core/google";
import * as voice from "../core/voice";
import { h, esc, fileToBase64 } from "../core/util";
import { icon } from "./icons";
import { openSheet, closeSheet, toast } from "./overlay";

let root: HTMLElement;
let onSettingsChanged: () => void = () => {};

export function setSettingsListener(fn: () => void) {
  onSettingsChanged = fn;
}

function saveSettings() {
  commit("settings");
  onSettingsChanged();
}

type KeyField = "apiKey" | "geminiKey" | "groqKey";
const KEY_FIELD: Record<Provider, KeyField> = { claude: "apiKey", gemini: "geminiKey", groq: "groqKey" };
const PROVIDERS: [Provider, string][] = [
  ["gemini", "Gemini · free"],
  ["groq", "Groq · free"],
  ["claude", "Claude"],
];

/** True when the selected AI provider has a key. */
export function hasKey(): boolean {
  return !!state.settings[KEY_FIELD[state.settings.provider]].trim();
}

function keyHintHTML(p: Provider): string {
  if (p === "claude")
    return `Paid API — create a key at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a> (needs credits).`;
  const i = PROVIDER_INFO[p];
  return `${i.keyHint} Get it at <a href="${i.keyUrl}" target="_blank" rel="noopener">${new URL(i.keyUrl).hostname}</a>.`;
}

function providerSeg(cur: Provider, on: (p: Provider) => void) {
  const seg = h("div", { class: "seg" });
  for (const [v, l] of PROVIDERS) {
    const b = h("button", { type: "button", class: v === cur ? "on" : "" }, l);
    b.addEventListener("click", () => on(v));
    seg.append(b);
  }
  return seg;
}

const modelCache: Partial<Record<Provider, string[]>> = {};

function profileChanged() {
  commit("profile");
  noteProfileChanged();
}

function toggle(checked: boolean, on: (v: boolean) => void) {
  const inp = h("input", { type: "checkbox" }) as HTMLInputElement;
  inp.checked = checked;
  inp.addEventListener("change", () => on(inp.checked));
  return h("label", { class: "switch" }, inp, h("span"));
}

function setting(title: string, sub: string, control: Node) {
  const el = h("div", { class: "setting" });
  const k = h("div", { class: "k grow" });
  k.innerHTML = `${esc(title)}${sub ? `<small>${sub}</small>` : ""}`;
  el.append(k, control);
  return el;
}

/* ------------------------------ CV import ------------------------------ */
async function importCV(onDone?: () => void) {
  const file = h("input", { type: "file", accept: "application/pdf,image/*,.txt,.md" }) as HTMLInputElement;
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    toast("Profile", "Analysing your CV…", 4000);
    try {
      const input =
        f.type === "application/pdf"
          ? { pdfBase64: await fileToBase64(f) }
          : f.type.startsWith("image/")
            ? { imageBase64: await fileToBase64(f), imageType: f.type }
            : { text: await f.text() };
      const p = await extractProfileFromCV(input);
      const keep = { addressAs: state.profile.addressAs, memory: state.profile.memory };
      state.profile = { ...DEFAULT_PROFILE, ...state.profile, ...p, ...keep, cvImported: true };
      profileChanged();
      toast("Profile", "Profile calibrated from your CV.");
      voice.speak(`Profile calibrated. Pleasure to properly meet you, ${state.profile.name.split(" ")[0] || state.profile.addressAs}.`);
      render();
      onDone?.();
    } catch (e) {
      toast("Profile", (e as Error).message, 7000);
    }
  });
  file.click();
}

/* ------------------------------ edit profile ------------------------------ */
const LIST_FIELDS: [keyof Profile, string][] = [
  ["skills", "Skills"],
  ["tools", "Tools & technologies"],
  ["languages", "Languages"],
  ["education", "Education"],
  ["experience", "Experience"],
  ["interests", "Interests"],
  ["dailyRoutines", "Daily routines"],
  ["goals", "Goals"],
];

function editProfile() {
  const p = state.profile;
  const f = (label: string, key: keyof Profile, ph = "") => {
    const i = h("input", { class: "field", value: String(p[key] ?? ""), placeholder: ph }) as HTMLInputElement;
    i.dataset.key = key;
    return [h("label", { class: "lbl" }, label), i];
  };
  const form = h("form", {}, h("div", { class: "view-title" }, "Edit profile"));
  form.append(...f("Name", "name"), ...f("Jarvis calls you", "addressAs", "sir, madam, boss, your first name…"), ...f("Headline", "headline", "e.g. Software engineering student"), ...f("City", "location"));
  for (const [key, label] of LIST_FIELDS) {
    const t = h("textarea", { class: "field", rows: "3", placeholder: "One per line" }) as HTMLTextAreaElement;
    t.value = (p[key] as string[]).join("\n");
    t.dataset.key = key;
    form.append(h("label", { class: "lbl" }, label), t);
  }
  form.append(h("div", { style: "height:16px" }), h("button", { class: "btn primary block", type: "submit" }, "Save profile"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const next = { ...state.profile } as Record<string, unknown>;
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-key]").forEach((el) => {
      const k = el.dataset.key!;
      next[k] = el.tagName === "TEXTAREA" ? el.value.split("\n").map((s) => s.trim()).filter(Boolean) : el.value.trim();
    });
    state.profile = next as unknown as Profile;
    profileChanged();
    closeSheet();
    render();
  });
  openSheet(form);
}

/* ------------------------------ onboarding ------------------------------ */
export function showOnboarding() {
  let prov: Provider = state.settings.provider === "claude" && !state.settings.apiKey ? "gemini" : state.settings.provider;
  const key = h("input", { class: "field", type: "password", autocomplete: "off" }) as HTMLInputElement;
  const keyHint = h("p", { class: "hint" });
  const keyLabel = h("label", { class: "lbl" });
  const segHost = h("div", {});
  const paintProv = () => {
    keyLabel.textContent = `1 · ${prov === "claude" ? "Claude" : PROVIDER_INFO[prov].label} API key`;
    key.placeholder = prov === "claude" ? "sk-ant-…" : prov === "groq" ? "gsk_…" : "AIza…";
    key.value = state.settings[KEY_FIELD[prov]];
    keyHint.innerHTML = keyHintHTML(prov) + " It stays on this phone.";
    segHost.replaceChildren(providerSeg(prov, (p) => ((prov = p), paintProv())));
  };
  paintProv();
  const name = h("input", { class: "field", placeholder: "Your name", value: state.profile.name }) as HTMLInputElement;
  const addr = h("select", { class: "field" }) as HTMLSelectElement;
  addr.innerHTML = ["sir", "madam", "boss", "my first name"].map((a) => `<option ${a === state.profile.addressAs ? "selected" : ""}>${a}</option>`).join("");
  const wrap = h("form", {});
  wrap.innerHTML = `<div class="view-title">Initial calibration</div><p class="view-sub">Three quick steps and I'm at your service.</p>`;
  wrap.append(
    h("label", { class: "lbl" }, "AI brain"),
    segHost,
    keyLabel,
    key,
    keyHint,
    h("label", { class: "lbl" }, "2 · Who am I serving?"),
    h("div", { class: "row" }, name, addr),
  );
  const cv = h("button", { class: "btn block", type: "button", style: "margin-top:8px" });
  cv.innerHTML = `${icon("upload")}<span>3 · Import my CV (optional)</span>`;
  cv.addEventListener("click", () => {
    if (key.value.trim()) {
      state.settings[KEY_FIELD[prov]] = key.value.trim();
      state.settings.provider = prov;
      saveSettings();
    }
    if (!hasKey()) return toast("Calibration", "Add your API key first.");
    void importCV(() => (cv.innerHTML = `${icon("check")}<span>CV imported</span>`));
  });
  wrap.append(cv, h("div", { style: "height:16px" }), h("button", { class: "btn primary block", type: "submit" }, "Engage"));
  wrap.addEventListener("submit", (e) => {
    e.preventDefault();
    if (key.value.trim()) state.settings[KEY_FIELD[prov]] = key.value.trim();
    state.settings.provider = prov;
    if (!hasKey()) return key.focus();
    state.profile.name = name.value.trim() || state.profile.name;
    state.profile.addressAs = addr.value === "my first name" ? state.profile.name.split(" ")[0] || "sir" : addr.value;
    saveSettings();
    profileChanged();
    resetSession();
    closeSheet();
    voice.speak(`Calibration complete. At your service, ${state.profile.addressAs}.`);
    render();
  });
  openSheet(wrap);
}

/* ------------------------------ render ------------------------------ */
export function render() {
  if (!root) return;
  const p = state.profile;
  const s = state.settings;
  const initials = (p.name || "J").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  const hero = h("div", { class: "panel" });
  hero.innerHTML = `<div class="profile-hero"><div class="ring"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor"><circle cx="50" cy="50" r="48" stroke-dasharray="3 6" opacity=".6"/><path d="M50 2a48 48 0 0 1 41 23" stroke-width="2.5" stroke-linecap="round"/></svg><div class="avatar">${esc(initials)}</div></div><div class="grow"><h2>${esc(p.name || "Unidentified user")}</h2><div class="small" style="color:var(--text-2)">${esc(p.headline || "Import your CV so I can tailor everything to you.")}</div><div class="small muted">${esc(p.location)}</div></div></div>`;
  const heroActs = h("div", { class: "row", style: "margin-top:14px" });
  const cvBtn = h("button", { class: `btn ${p.cvImported ? "" : "primary"} grow`, type: "button" });
  cvBtn.innerHTML = `${icon("upload")}<span>${p.cvImported ? "Re-import CV" : "Import CV"}</span>`;
  cvBtn.addEventListener("click", () => (hasKey() ? void importCV() : showOnboarding()));
  const edit = h("button", { class: "btn ghost", type: "button" });
  edit.innerHTML = `${icon("edit")}<span>Edit</span>`;
  edit.addEventListener("click", editProfile);
  heroActs.append(cvBtn, edit);
  hero.append(heroActs);

  const skills = h("div", { class: "panel" });
  const chipset = (title: string, items: string[]) => {
    if (!items.length) return;
    skills.append(h("div", { class: "section-label", style: "margin-top:4px" }, title));
    const c = h("div", { class: "chipset" });
    items.slice(0, 24).forEach((x) => c.append(h("span", { class: "chip" }, x)));
    skills.append(c);
  };
  chipset("Skills", p.skills);
  chipset("Tools", p.tools);
  chipset("Routines", p.dailyRoutines);
  chipset("Goals", p.goals);

  const mem = h("div", { class: "panel" });
  if (!p.memory.length) mem.append(h("div", { class: "small muted" }, "Nothing yet. Tell me about your schedule, people and preferences — I'll remember."));
  p.memory.forEach((m, i) => {
    const row = h("div", { class: "mem-item" }, h("span", { class: "grow" }, m));
    const x = h("button", { class: "icon-btn", type: "button", style: "width:30px;height:30px", "aria-label": "Forget" });
    x.innerHTML = icon("x");
    x.addEventListener("click", () => {
      p.memory.splice(i, 1);
      profileChanged();
      render();
    });
    row.append(x);
    mem.append(row);
  });

  /* --- AI core --- */
  const ai = h("div", { class: "panel" });
  const prov = s.provider;
  const kf = KEY_FIELD[prov];
  const keyIn = h("input", { class: "field", type: "password", value: s[kf], placeholder: prov === "claude" ? "sk-ant-…" : prov === "groq" ? "gsk_…" : "AIza…", autocomplete: "off" }) as HTMLInputElement;
  keyIn.addEventListener("change", () => {
    s[kf] = keyIn.value.trim();
    saveSettings();
    toast("Core", s[kf] ? "Key saved on this device." : "Key removed.");
    render();
  });
  const keyHint = h("p", { class: "hint" });
  keyHint.innerHTML = keyHintHTML(prov);

  const model = h("select", { class: "field" }) as HTMLSelectElement;
  const modelRow = h("div", { class: "row" }, model);
  model.classList.add("grow");
  if (prov === "claude") {
    model.innerHTML = MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${m.label}</option>`).join("");
    model.addEventListener("change", () => ((s.model = model.value), saveSettings()));
  } else {
    const field = prov === "gemini" ? "geminiModel" : "groqModel";
    const fill = (ids: string[]) => {
      const all = [s[field], ...ids].filter((v, i, a) => v && a.indexOf(v) === i);
      model.innerHTML = all.map((id) => `<option value="${esc(id)}" ${id === s[field] ? "selected" : ""}>${esc(id)}</option>`).join("");
    };
    fill(modelCache[prov] ?? []);
    model.addEventListener("change", () => ((s[field] = model.value), saveSettings()));
    const refresh = h("button", { class: "icon-btn", type: "button", "aria-label": "Load available models" });
    refresh.innerHTML = icon("reset");
    const load = async (quiet: boolean) => {
      try {
        modelCache[prov] = await listModels(prov);
        fill(modelCache[prov]!);
        if (!quiet) toast("Core", `${modelCache[prov]!.length} models available.`);
      } catch (e) {
        if (!quiet) toast("Core", (e as Error).message, 7000);
      }
    };
    refresh.addEventListener("click", () => void load(false));
    modelRow.append(refresh);
    if (s[kf] && !modelCache[prov]) void load(true);
  }

  const eff = h("div", { class: "seg" });
  for (const [v, l] of [
    ["low", "Swift"],
    ["medium", "Balanced"],
    ["high", "Deep"],
  ] as [Effort, string][]) {
    const b = h("button", { type: "button", class: v === s.effort ? "on" : "" }, l);
    b.addEventListener("click", () => {
      s.effort = v;
      saveSettings();
      render();
    });
    eff.append(b);
  }
  ai.append(
    h("label", { class: "lbl", style: "margin-top:0" }, "AI brain"),
    providerSeg(prov, (p) => {
      s.provider = p;
      saveSettings();
      toast("Core", `Switched to ${p === "claude" ? "Claude" : PROVIDER_INFO[p].label}.`);
      render();
    }),
    h("label", { class: "lbl" }, `${prov === "claude" ? "Claude" : PROVIDER_INFO[prov].label} API key`),
    keyIn,
    keyHint,
    h("label", { class: "lbl" }, "Model"),
    modelRow,
    h("label", { class: "lbl" }, "Reasoning depth"),
    eff,
    h(
      "p",
      { class: "hint" },
      prov === "claude"
        ? "Swift is best for voice. Research requests automatically go Deep."
        : prov === "gemini"
          ? "Free tier: Flash-Lite allows the most requests per day. Deep and research questions use Google Search. Gemini can read PDFs and photos."
          : "Free tier with daily limits. Deep and research questions use Groq's web search. Groq handles text only — use Gemini for PDFs/photos.",
    ),
  );

  /* --- voice --- */
  const vo = h("div", { class: "panel" });
  const voices = voice.rankedVoices();
  const vsel = h("select", { class: "field" }) as HTMLSelectElement;
  vsel.innerHTML = `<option value="">Auto — best British voice</option>` + voices.map((v) => `<option value="${esc(v.name)}" ${v.name === s.voiceName ? "selected" : ""}>${esc(v.name)} (${v.lang})</option>`).join("");
  vsel.addEventListener("change", () => {
    s.voiceName = vsel.value;
    saveSettings();
  });
  const lang = h("select", { class: "field" }) as HTMLSelectElement;
  lang.innerHTML = [
    ["en-GB", "English (UK)"],
    ["en-US", "English (US)"],
    ["fr-FR", "Français"],
    ["ar-TN", "العربية — تونس"],
    ["ar-SA", "العربية"],
  ]
    .map(([v, l]) => `<option value="${v}" ${v === s.language ? "selected" : ""}>${l}</option>`)
    .join("");
  lang.addEventListener("change", () => {
    s.language = lang.value;
    saveSettings();
  });
  const range = (min: number, max: number, step: number, val: number, on: (v: number) => void) => {
    const r = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(val) }) as HTMLInputElement;
    r.addEventListener("change", () => on(parseFloat(r.value)));
    return r;
  };
  const sample = () =>
    `Good evening, ${state.profile.addressAs || "sir"}. Everything's running smoothly. I've checked your schedule, and you have a free hour before your next task — shall I help you make the most of it?`;
  const test = h("button", { class: "btn sm primary", type: "button" });
  test.innerHTML = `${icon("wave")}<span>Preview voice</span>`;
  test.addEventListener("click", () => {
    voice.stopSpeaking();
    voice.speak(sample());
  });

  // engine
  const eng = h("div", { class: "seg" });
  for (const [v, l] of [
    ["auto", "Auto"],
    ["gemini", "Natural"],
    ["eleven", "HD"],
    ["device", "Phone"],
  ] as const) {
    const b = h("button", { type: "button", class: v === s.voiceEngine ? "on" : "" }, l);
    b.addEventListener("click", () => {
      s.voiceEngine = v;
      saveSettings();
      render();
    });
    eng.append(b);
  }
  const engHint = h("p", { class: "hint" });
  engHint.innerHTML =
    "<b>Natural</b> — Google's human-like voices, free with your Gemini key. <b>HD</b> — ElevenLabs, the most realistic (free tier with a monthly character limit). <b>Phone</b> — your device's built-in voice, works offline. <b>Auto</b> picks the best one you've set up.";

  // Gemini natural voice
  const gvoice = h("select", { class: "field" }) as HTMLSelectElement;
  gvoice.innerHTML = voice.GEMINI_VOICES.map(([n, d]) => `<option value="${n}" ${n === s.geminiVoice ? "selected" : ""}>${n} — ${d}</option>`).join("");
  gvoice.addEventListener("change", () => {
    s.geminiVoice = gvoice.value;
    saveSettings();
    voice.stopSpeaking();
    voice.speak(sample());
  });

  // ElevenLabs
  const eKey = h("input", { class: "field", type: "password", value: s.elevenKey, placeholder: "ElevenLabs API key", autocomplete: "off" }) as HTMLInputElement;
  const eVoice = h("input", { class: "field", value: s.elevenVoiceId, placeholder: "Voice ID" }) as HTMLInputElement;
  eKey.addEventListener("change", () => ((s.elevenKey = eKey.value.trim()), saveSettings(), render()));
  eVoice.addEventListener("change", () => ((s.elevenVoiceId = eVoice.value.trim()), saveSettings(), render()));
  const presets = h("div", { class: "row wrap", style: "margin-top:8px" });
  for (const [name, id, desc] of voice.ELEVEN_PRESETS) {
    const b = h("button", { class: `chip${s.elevenVoiceId === id ? " on" : ""}`, type: "button", title: desc }, `${name} · ${desc.split(" — ")[0]}`);
    if (s.elevenVoiceId === id) b.style.borderColor = "var(--cyan)";
    b.addEventListener("click", () => {
      s.elevenVoiceId = id;
      saveSettings();
      render();
    });
    presets.append(b);
  }

  vo.append(
    setting("Speak replies", "Read answers aloud", toggle(s.speak, (v) => ((s.speak = v), saveSettings()))),
    setting(
      "Wake word",
      "Say “Jarvis …” hands-free while the app is open",
      toggle(s.wakeWord, (v) => {
        s.wakeWord = v;
        saveSettings();
      }),
    ),
    h("label", { class: "lbl" }, "Language (listening & speaking)"),
    lang,
    h("label", { class: "lbl" }, "Voice engine"),
    eng,
    engHint,
    h("label", { class: "lbl" }, "Pace"),
    range(0.85, 1.3, 0.01, s.voiceRate, (v) => ((s.voiceRate = v), saveSettings())),
    h("div", { style: "height:10px" }),
    test,
    h("div", { class: "section-label" }, "Natural voice (Gemini, free)"),
    s.geminiKey ? gvoice : h("p", { class: "hint", style: "margin-top:0" }, "Add a free Gemini key in AI core above to unlock natural voices."),
    h("div", { class: "section-label" }, "HD voice (ElevenLabs)"),
    eKey,
    h("div", { style: "height:8px" }),
    eVoice,
    presets,
    (() => {
      const p = h("p", { class: "hint" });
      p.innerHTML = `Free account at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener">elevenlabs.io</a> → create an API key, then tap a British voice above. These are original voices — copying a real actor's voice isn't supported.`;
      return p;
    })(),
    setting("Clarity polish", "Gentle warmth & presence on cloud voices", toggle(s.voiceFx, (v) => ((s.voiceFx = v), saveSettings()))),
    h("div", { class: "section-label" }, "Phone voice"),
    h("label", { class: "lbl", style: "margin-top:0" }, "Device voice"),
    vsel,
    h("label", { class: "lbl" }, "Pitch"),
    range(0.6, 1.4, 0.02, s.voicePitch, (v) => ((s.voicePitch = v), saveSettings())),
  );

  /* --- connections --- */
  const con = h("div", { class: "panel" });
  const gid = h("input", { class: "field", value: s.googleClientId, placeholder: "xxxx.apps.googleusercontent.com" }) as HTMLInputElement;
  gid.addEventListener("change", () => ((s.googleClientId = gid.value.trim()), saveSettings(), render()));
  const gBtn = h("button", { class: `btn ${google.googleReady() ? "ghost" : "primary"} block`, type: "button", style: "margin-top:10px" });
  gBtn.innerHTML = `${icon("mail")}<span>${google.googleReady() ? "Disconnect Google" : "Connect Gmail & Calendar"}</span>`;
  gBtn.addEventListener("click", async () => {
    if (google.googleReady()) {
      google.disconnectGoogle();
      return render();
    }
    try {
      await google.connectGoogle();
      toast("Google", "Gmail and Calendar connected.");
      render();
    } catch (e) {
      toast("Google", (e as Error).message, 7000);
    }
  });
  const ghint = h("p", { class: "hint" });
  ghint.innerHTML = `Create a free OAuth Client ID (type “Web application”) in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a>, enable the Gmail and Calendar APIs, and add <span class="mono">${esc(location.origin)}</span> as an authorised JavaScript origin. See the README for a 2-minute walkthrough.`;
  const notif = h("button", { class: "btn block", type: "button", style: "margin-top:10px" });
  notif.innerHTML = `${icon("bell")}<span>${"Notification" in window && Notification.permission === "granted" ? "Notifications enabled" : "Enable notifications"}</span>`;
  notif.addEventListener("click", async () => {
    if ("Notification" in window) await Notification.requestPermission();
    render();
  });
  con.append(h("label", { class: "lbl", style: "margin-top:0" }, "Google OAuth Client ID"), gid, ghint, gBtn, notif);

  /* --- data --- */
  const data = h("div", { class: "panel" });
  const exp = h("button", { class: "btn grow", type: "button" }, "Export data");
  exp.addEventListener("click", () => {
    const { settings, session, ...rest } = state;
    void session;
    const safe = { ...rest, settings: { ...settings, apiKey: "", elevenKey: "" } };
    const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" })), download: "jarvis-backup.json" });
    a.click();
  });
  const newChat = h("button", { class: "btn grow", type: "button" }, "New conversation");
  newChat.addEventListener("click", () => {
    resetSession(true);
    toast("Core", "Fresh conversation started.");
    (window as unknown as { jarvisRefresh(): void }).jarvisRefresh();
  });
  const wipe = h("button", { class: "btn danger block", type: "button", style: "margin-top:10px" }, "Erase everything on this device");
  wipe.addEventListener("click", async () => {
    if (!confirm("Erase all Jarvis data, keys and history from this device?")) return;
    await kvClear();
    localStorage.clear();
    location.reload();
  });
  data.append(h("div", { class: "row" }, exp, newChat), wipe);

  root.replaceChildren(
    h("div", { class: "view-title" }, "Profile", h("small", {}, "identity · core · voice")),
    h("p", { class: "view-sub" }, "How Jarvis knows you, thinks and sounds."),
    h("div", { class: "stagger" }, hero, skills.childElementCount ? skills : h("div")),
    h("div", { class: "section-label" }, "Memory"),
    mem,
    h("div", { class: "section-label" }, "AI core"),
    ai,
    h("div", { class: "section-label" }, "Voice"),
    vo,
    h("div", { class: "section-label" }, "Connections"),
    con,
    h("div", { class: "section-label" }, "Data"),
    data,
    h("p", { class: "hint", style: "text-align:center;margin:20px 0 6px" }, "J.A.R.V.I.S. v1.0 · runs entirely on your device"),
  );
}

export function mountProfile(el: HTMLElement) {
  root = el;
  render();
  speechSynthesis.addEventListener?.("voiceschanged", () => render());
}
