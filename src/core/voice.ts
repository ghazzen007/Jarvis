import { state } from "./store";
import { speakable } from "./util";

/* ------------------------------------------------------------------ *
 *  Speech recognition (input)                                         *
 * ------------------------------------------------------------------ */

// Minimal typings for the Web Speech API (not in lib.dom for all browsers).
interface SRAlternative { transcript: string }
interface SRResult { isFinal: boolean; 0: SRAlternative; length: number }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
}

const SR: (new () => SpeechRec) | undefined =
  (window as unknown as { SpeechRecognition?: new () => SpeechRec }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;

export const canListen = !!SR;

let level = 0; // 0..1 activity level used by the orb
let levelTarget = 0;
let analyser: AnalyserNode | null = null;
const fbuf = new Uint8Array(64);

/** Current voice activity level (mic or speech output) for visuals. */
export function voiceLevel(): number {
  if (analyser) {
    analyser.getByteFrequencyData(fbuf);
    let sum = 0;
    for (let i = 2; i < 40; i++) sum += fbuf[i];
    return Math.min(1, (sum / 38 / 255) * 2.2);
  }
  // synthetic envelope (speechSynthesis / recognition don't expose audio)
  levelTarget *= 0.92;
  const flutter = speaking ? 0.25 + Math.random() * 0.35 : 0;
  level += (Math.max(levelTarget, flutter) - level) * 0.3;
  return level;
}

export interface ListenHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onEnd(): void;
  onError(msg: string): void;
}

let rec: SpeechRec | null = null;
let listening = false;

export function isListening() {
  return listening;
}

export function listen(h: ListenHandlers) {
  if (!SR) {
    h.onError("Voice input isn't supported in this browser — try Chrome on Android, or type instead.");
    return;
  }
  stopSpeaking();
  stopWake();
  rec?.abort();
  rec = new SR();
  rec.lang = state.settings.language;
  rec.continuous = false;
  rec.interimResults = true;
  let finalText = "";
  rec.onspeechstart = () => (levelTarget = 0.6);
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    levelTarget = 0.5 + Math.random() * 0.5;
    h.onInterim((finalText + " " + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    h.onError(e.error === "not-allowed" ? "Microphone permission denied." : `Voice error: ${e.error}`);
  };
  rec.onend = () => {
    listening = false;
    const t = finalText.trim();
    if (t) h.onFinal(t);
    h.onEnd();
    resumeWake();
  };
  listening = true;
  rec.start();
}

export function stopListening() {
  rec?.stop();
}

/* ------------------------------------------------------------------ *
 *  Wake word ("Jarvis …") — hands-free while the app is open          *
 * ------------------------------------------------------------------ */

let wakeRec: SpeechRec | null = null;
let wakeHandler: ((command: string) => void) | null = null;
let wakeEnabled = false;

export function startWake(onCommand: (command: string) => void) {
  wakeHandler = onCommand;
  wakeEnabled = true;
  resumeWake();
}

export function disableWake() {
  wakeEnabled = false;
  stopWake();
}

function stopWake() {
  if (wakeRec) {
    wakeRec.onend = null;
    wakeRec.abort();
    wakeRec = null;
  }
}

function resumeWake() {
  if (!SR || !wakeEnabled || listening || speaking || document.hidden || wakeRec) return;
  const r = new SR();
  r.lang = state.settings.language;
  r.continuous = true;
  r.interimResults = false;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const said = e.results[i][0].transcript.trim();
      const m = said.match(/\bjarvis\b[\s,.:!?]*(.*)$/i);
      if (m) {
        stopWake();
        wakeHandler?.(m[1].trim());
        return;
      }
    }
  };
  r.onerror = () => {};
  r.onend = () => {
    wakeRec = null;
    setTimeout(resumeWake, 400);
  };
  wakeRec = r;
  try {
    r.start();
  } catch {
    wakeRec = null;
  }
}

document.addEventListener("visibilitychange", () => (document.hidden ? stopWake() : resumeWake()));

/* ------------------------------------------------------------------ *
 *  Speech synthesis (output)                                          *
 *                                                                     *
 *  Engines: ElevenLabs (most realistic) → Gemini natural voice (free  *
 *  with a Gemini key) → the phone's own voice. Audio for the next     *
 *  chunk is fetched while the current one plays, so speech flows      *
 *  without robotic gaps.                                              *
 * ------------------------------------------------------------------ */

type Engine = "gemini" | "eleven" | "device";

interface Chunk {
  text: string;
  audio?: Promise<Blob | null>; // prefetched cloud audio (null = fall back to device voice)
}

let speaking = false;
const queue: Chunk[] = [];
let onSpeakChange: (s: boolean) => void = () => {};
let audioCtx: AudioContext | null = null;
let currentAudio: HTMLAudioElement | null = null;
let generation = 0; // bumps on stop, so stale playback loops exit
let cloudFailedUntil = 0; // after a cloud failure, use the device voice for a while
let onVoiceNotice: (msg: string) => void = () => {};

export function onSpeakingChange(fn: (s: boolean) => void) {
  onSpeakChange = fn;
}

export function onVoiceIssue(fn: (msg: string) => void) {
  onVoiceNotice = fn;
}

export function isSpeaking() {
  return speaking;
}

/** Natural Gemini voices that suit a refined assistant (name → character). */
export const GEMINI_VOICES: [string, string][] = [
  ["Iapetus", "Clear, composed — recommended"],
  ["Charon", "Informative, smooth"],
  ["Sadaltager", "Knowledgeable, warm"],
  ["Algieba", "Smooth, refined"],
  ["Schedar", "Even, calm"],
  ["Rasalgethi", "Informative, deeper"],
  ["Achird", "Friendly"],
  ["Umbriel", "Easy-going"],
  ["Orus", "Firm"],
  ["Alnilam", "Firm, confident"],
];

/** ElevenLabs premade British male voices (available on free accounts). */
export const ELEVEN_PRESETS: [string, string, string][] = [
  ["George", "JBFqnCBsd6RMkjVDRZzb", "Warm, articulate British — recommended"],
  ["Daniel", "onwK4e9ZLuTAKqWW03F9", "Polished British presenter"],
];

const STYLE =
  "You are the voice of JARVIS, a refined British AI butler. Speak the text below in a warm, calm, quietly confident British voice — " +
  "natural and human, gently friendly and attentive, with relaxed conversational rhythm and a brisk, easy pace. Never sound robotic or monotone. " +
  "Say only the text after the colon:\n\n";

function engine(): Engine {
  const st = state.settings;
  if (Date.now() < cloudFailedUntil) return "device";
  const elevenReady = !!(st.elevenKey && st.elevenVoiceId);
  const geminiReady = !!st.geminiKey;
  switch (st.voiceEngine) {
    case "eleven":
      return elevenReady ? "eleven" : "device";
    case "gemini":
      return geminiReady ? "gemini" : "device";
    case "device":
      return "device";
    default:
      return elevenReady ? "eleven" : geminiReady ? "gemini" : "device";
  }
}

export function activeVoiceLabel(): string {
  return { eleven: "HD", gemini: "NAT", device: "STD" }[engine()];
}

/** Voices ranked so a refined British male voice is preferred. */
export function rankedVoices(): SpeechSynthesisVoice[] {
  const vs = speechSynthesis.getVoices();
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0;
    const n = v.name.toLowerCase();
    if (v.lang === "en-GB") s += 50;
    else if (v.lang.startsWith("en")) s += 20;
    if (/daniel|george|ryan|arthur|oliver|thomas|harry|brian|male|uk english male/.test(n)) s += 30;
    if (/female|serena|kate|libby|sonia|susan|martha|hazel/.test(n)) s -= 25;
    if (/google|natural|neural|enhanced|premium|online/.test(n)) s += 12;
    if (v.lang.split("-")[0] === state.settings.language.split("-")[0]) s += 15;
    return s;
  };
  return [...vs].sort((a, b) => score(b) - score(a));
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const vs = speechSynthesis.getVoices();
  return vs.find((v) => v.name === state.settings.voiceName) ?? rankedVoices()[0];
}

function setSpeaking(s: boolean) {
  if (speaking === s) return;
  speaking = s;
  onSpeakChange(s);
  if (!s) resumeWake();
  else stopWake();
}

/** Make written text sound natural when spoken. */
export function humanize(text: string): string {
  return speakable(text)
    .replace(/\be\.g\.,?/gi, "for example,")
    .replace(/\bi\.e\.,?/gi, "that is,")
    .replace(/\betc\.?/gi, "and so on")
    .replace(/\bvs\.?\b/gi, "versus")
    .replace(/\s&\s/g, " and ")
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(/[→⇒➜]/g, ", then ")
    .replace(/\s[–—]\s/g, ", ")
    .replace(/[()[\]{}]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Queue text to be spoken. Cloud audio is requested immediately (prefetch). */
export function speak(text: string) {
  if (!state.settings.speak) return;
  const t = humanize(text);
  if (!t) return;
  const chunk: Chunk = { text: t };
  const e = engine();
  if (e !== "device") chunk.audio = fetchCloud(e, t);
  queue.push(chunk);
  if (!speaking) void drain();
}

async function drain() {
  const gen = ++generation;
  setSpeaking(true);
  unlockAudio();
  while (queue.length && gen === generation) {
    const chunk = queue.shift()!;
    const blob = chunk.audio ? await chunk.audio : null;
    if (gen !== generation) return;
    if (blob) await playBlob(blob, gen);
    else await speakNative(chunk.text);
  }
  if (gen === generation) setSpeaking(false);
}

async function fetchCloud(e: Exclude<Engine, "device">, text: string): Promise<Blob | null> {
  try {
    return e === "eleven" ? await elevenAudio(text) : await geminiAudio(text);
  } catch (err) {
    console.warn("Cloud voice failed, using device voice", err);
    cloudFailedUntil = Date.now() + 10 * 60 * 1000;
    onVoiceNotice(
      e === "gemini"
        ? "Natural voice unavailable right now (free limit or model change) — using the phone voice for a few minutes."
        : "ElevenLabs voice unavailable (check key/credits) — using the phone voice for a few minutes.",
    );
    return null;
  }
}

function speakNative(text: string): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else u.lang = state.settings.language;
    u.rate = state.settings.voiceRate;
    u.pitch = state.settings.voicePitch;
    u.onboundary = () => (levelTarget = 0.7 + Math.random() * 0.3);
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

/* ---- ElevenLabs ---- */
async function elevenAudio(text: string): Promise<Blob> {
  const { elevenKey, elevenVoiceId } = state.settings;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      // lower stability + some style = more expressive, human delivery
      voice_settings: { stability: 0.42, similarity_boost: 0.8, style: 0.28, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  return res.blob();
}

/* ---- Gemini natural voice (uses the Gemini key) ---- */
let ttsModel: string | null = null;

async function geminiTtsModel(key: string): Promise<string> {
  if (ttsModel) return ttsModel;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  if (!res.ok) throw new Error(`Gemini models ${res.status}`);
  const j = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  const names = (j.models ?? []).map((m) => m.name.replace(/^models\//, "")).filter((n) => /tts/i.test(n));
  if (!names.length) throw new Error("No Gemini speech model available for this key.");
  // prefer flash (fast, free-tier friendly), newest first
  names.sort((a, b) => Number(/flash/.test(b)) - Number(/flash/.test(a)) || b.localeCompare(a));
  ttsModel = names[0];
  return ttsModel;
}

async function geminiAudio(text: string): Promise<Blob> {
  const key = state.settings.geminiKey.trim();
  const model = await geminiTtsModel(key);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: STYLE + text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: state.settings.geminiVoice || "Iapetus" } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini voice ${res.status}`);
  const j = await res.json();
  const part = (j.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: { data?: string } }) => p.inlineData?.data);
  if (!part) throw new Error("Gemini returned no audio.");
  const mime: string = part.inlineData.mimeType ?? "";
  const rate = Number(mime.match(/rate=(\d+)/)?.[1] ?? 24000);
  const pcm = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
  return /wav|mpeg|mp3|ogg/.test(mime) ? new Blob([pcm], { type: mime }) : pcmToWav(pcm, rate);
}

/** Wrap raw 16-bit mono PCM in a WAV container. */
function pcmToWav(pcm: Uint8Array<ArrayBuffer>, sampleRate: number): Blob {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  h.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, "data");
  h.setUint32(40, pcm.length, true);
  return new Blob([h.buffer, pcm], { type: "audio/wav" });
}

/* ---- playback (drives the orb with the real audio level) ---- */
function unlockAudio() {
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
}
addEventListener("pointerdown", unlockAudio, { once: true });

async function playBlob(blob: Blob, gen: number): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.playbackRate = Math.min(1.35, Math.max(0.8, state.settings.voiceRate));
  (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  currentAudio = audio;
  unlockAudio();
  const ctx = audioCtx!;
  const src = ctx.createMediaElementSource(audio);
  const an = ctx.createAnalyser();
  an.fftSize = 128;
  const out: AudioNode = state.settings.voiceFx ? presenceChain(ctx, src) : src;
  out.connect(an);
  an.connect(ctx.destination);
  analyser = an;
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
  if (gen === generation) analyser = null;
  currentAudio = null;
  URL.revokeObjectURL(url);
}

/** Optional clarity polish: gentle warmth + presence. No echo, nothing robotic. */
function presenceChain(ctx: AudioContext, input: AudioNode): AudioNode {
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 80;
  const warmth = ctx.createBiquadFilter();
  warmth.type = "lowshelf";
  warmth.frequency.value = 220;
  warmth.gain.value = 1.5;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 3000;
  presence.gain.value = 2;
  presence.Q.value = 0.8;
  input.connect(hp);
  hp.connect(warmth);
  warmth.connect(presence);
  return presence;
}

export function stopSpeaking() {
  generation++;
  queue.length = 0;
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.dispatchEvent(new Event("ended"));
  }
  analyser = null;
  setSpeaking(false);
}

/**
 * Turns a streaming reply into natural speech, the way a person would say it:
 * the first sentence goes out immediately (fast response), then whole
 * thoughts in larger chunks for smooth delivery. Lists, headings and code
 * aren't read out line by line — after a short spoken summary, Jarvis points
 * to the screen instead.
 */
export class SentenceStreamer {
  private buf = "";
  private held = "";
  private inCode = false;
  private spoken = 0;
  private chunks = 0;
  private listItems = 0;
  private done = false;
  private static BUDGET = 650; // max characters read aloud per reply

  private emit(text: string) {
    const t = text.trim();
    if (!t || this.done) return;
    speak(t);
    this.spoken += t.length;
    this.chunks++;
  }

  private stopWithPointer() {
    if (this.done) return;
    this.flushHeld();
    this.done = true;
    speak(pick(["The details are on your screen.", "I've put the rest on screen for you.", "Everything else is on the screen."]));
  }

  private flushHeld() {
    if (this.held.trim()) this.emit(this.held);
    this.held = "";
  }

  push(delta: string) {
    if (this.done) return;
    this.buf += delta;
    const re = /^([\s\S]*?[.!?…](?=\s)|[\s\S]*?\n)/;
    let m: RegExpMatchArray | null;
    while (!this.done && (m = this.buf.match(re)) && m[0].length > 0) {
      const piece = m[0];
      this.buf = this.buf.slice(piece.length);
      const line = piece.trim();
      if (line.startsWith("```")) {
        this.inCode = !this.inCode;
        if (this.spoken > 0) this.stopWithPointer();
        continue;
      }
      if (this.inCode || !line) continue;
      const isList = /^([-*•]|\d+[.)])\s/.test(line);
      const isHeading = /^#{1,6}\s/.test(line) || /^\|/.test(line);
      if (isHeading) {
        if (this.spoken > 0) this.stopWithPointer();
        continue;
      }
      if (isList) {
        // read at most a couple of items, like a person would
        this.listItems++;
        if (this.listItems > 3 || this.spoken > 260) {
          this.stopWithPointer();
          continue;
        }
      }
      if (this.spoken + this.held.length + piece.length > SentenceStreamer.BUDGET) {
        this.stopWithPointer();
        continue;
      }
      this.held += piece;
      // first chunk: speak as soon as one sentence is ready; then group ~2-3 sentences
      const target = this.chunks === 0 ? 1 : 180;
      if (this.held.trim().length >= target || /\n\s*$/.test(piece)) this.flushHeld();
    }
  }

  flush() {
    if (this.done) return;
    if (!this.inCode) this.held += this.buf;
    this.buf = "";
    if (this.spoken + this.held.length > SentenceStreamer.BUDGET + 120) this.stopWithPointer();
    else this.flushHeld();
    this.inCode = false;
  }
}

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

// Voices load asynchronously in Chrome.
speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
