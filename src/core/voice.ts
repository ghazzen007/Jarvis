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
 * ------------------------------------------------------------------ */

let speaking = false;
const queue: string[] = [];
let onSpeakChange: (s: boolean) => void = () => {};
let audioCtx: AudioContext | null = null;
let currentAudio: HTMLAudioElement | null = null;

export function onSpeakingChange(fn: (s: boolean) => void) {
  onSpeakChange = fn;
}

export function isSpeaking() {
  return speaking;
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
    if (/google|natural|neural|enhanced|premium/.test(n)) s += 8;
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

/** Queue a chunk of text to be spoken (sentences stream in as Claude writes). */
export function speak(text: string) {
  if (!state.settings.speak) return;
  const t = speakable(text);
  if (!t) return;
  queue.push(t);
  if (!speaking) void drain();
}

async function drain() {
  setSpeaking(true);
  while (queue.length) {
    const chunk = queue.shift()!;
    try {
      if (state.settings.elevenKey && state.settings.elevenVoiceId) await speakEleven(chunk);
      else await speakNative(chunk);
    } catch (err) {
      console.warn("TTS failed, falling back", err);
      await speakNative(chunk).catch(() => {});
    }
    if (!speaking) return; // stopped mid-way
  }
  setSpeaking(false);
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

/** Premium voice via ElevenLabs (your own key + a voice you choose in their library). */
async function speakEleven(text: string): Promise<void> {
  const { elevenKey, elevenVoiceId } = state.settings;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.crossOrigin = "anonymous";
  currentAudio = audio;
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const src = audioCtx.createMediaElementSource(audio);
  const an = audioCtx.createAnalyser();
  an.fftSize = 128;
  let out: AudioNode = src;
  if (state.settings.voiceFx) out = aiVoiceChain(audioCtx, src);
  out.connect(an);
  an.connect(audioCtx.destination);
  analyser = an;
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
  analyser = null;
  currentAudio = null;
  URL.revokeObjectURL(url);
}

/** Subtle "AI system" colouring: presence boost, airy top, very short slap echo. */
function aiVoiceChain(ctx: AudioContext, input: AudioNode): AudioNode {
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 110;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 3200;
  presence.gain.value = 3.5;
  presence.Q.value = 0.9;
  const air = ctx.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 9000;
  air.gain.value = 2.5;
  const delay = ctx.createDelay(0.1);
  delay.delayTime.value = 0.018;
  const wet = ctx.createGain();
  wet.gain.value = 0.18;
  const mix = ctx.createGain();
  input.connect(hp);
  hp.connect(presence);
  presence.connect(air);
  air.connect(mix);
  air.connect(delay);
  delay.connect(wet);
  wet.connect(mix);
  return mix;
}

export function stopSpeaking() {
  queue.length = 0;
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.dispatchEvent(new Event("ended"));
  }
  setSpeaking(false);
}

/** Splits a growing stream of text into speakable sentences. */
export class SentenceStreamer {
  private buf = "";
  private held = "";
  private inCode = false;
  push(delta: string) {
    this.buf += delta;
    // flush complete sentences / list items (short fragments are merged)
    const re = /^([\s\S]*?[.!?…:;](?=\s)|[\s\S]*?\n)/;
    let m: RegExpMatchArray | null;
    while ((m = this.buf.match(re)) && m[0].length > 0) {
      const piece = m[0];
      this.buf = this.buf.slice(piece.length);
      if (piece.includes("```")) {
        this.inCode = !this.inCode;
        continue;
      }
      if (this.inCode) continue;
      this.held += piece;
      if (this.held.trim().length >= 28 || /\n\s*$/.test(piece)) {
        speak(this.held);
        this.held = "";
      }
    }
  }
  flush() {
    const rest = this.held + (this.inCode ? "" : this.buf);
    if (rest.trim()) speak(rest);
    this.buf = "";
    this.held = "";
    this.inCode = false;
  }
}

// Voices load asynchronously in Chrome.
speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
