# J.A.R.V.I.S. — personal AI assistant

A personal assistant you can install on your phone. It talks, listens, and handles everyday work: tasks, reminders, mail, calls, messages, calendar, research, and studying. It runs on Claude, and its interface is a holographic HUD with a 3D particle core that reacts to your voice.

> Installable PWA · Three.js core · Claude Opus 5.5, or **free** Gemini / Groq · web search and tools · voice in and out · Gmail and Calendar · built for mobile

---

## What it does

| Area | What Jarvis handles |
|---|---|
| **Voice** | Tap the core or the mic and speak. Replies are read aloud sentence by sentence while they stream in. You can turn on the **"Jarvis …" wake word** for hands-free use while the app is open. Supports English, French and Arabic (including Tunisian). |
| **Daily tasks** | Tasks with priorities and categories, reminders that send notifications, notes, "Brief me", and "Plan my day". |
| **Mail** | Drafts emails in your voice. With Gmail connected it also reads and summarises your inbox, drafts replies, and sends mail **after you tap approve** (you can edit the draft first). Without Gmail, drafts open in your mail app. |
| **Calls and messages** | "Call Mum" looks up the contact and shows a call card with talking points. SMS and WhatsApp messages are prepared for you to send with one tap. You can import contacts from your phone (Chrome on Android). |
| **Research** | Live web search and page reading. You get a verdict with source cards, and research questions automatically get deeper reasoning. |
| **Studies** | Explanations at your level, quizzes, **AI-generated flashcards** with spaced repetition (3D flip cards), PDF and photo summaries, exam study plans, and a Pomodoro focus timer with stats. |
| **Your profile** | **Import your CV** (PDF or photo). Claude pulls out your skills, tools, education, routines and goals, and Jarvis then fits its advice to the methods and tools you already know. During conversations it also remembers facts you tell it. |
| **Calendar and weather** | Lists and creates Google Calendar events. Weather comes from Open-Meteo, with no key needed. |

## Install it on your phone

1. Open the deployed URL (see **Deploy** below) in **Chrome on Android** or **Safari on iPhone**.
2. Android: open the ⋮ menu and choose **Install app**. iPhone: tap **Share**, then **Add to Home Screen**.
3. Open Jarvis, tap **Engage**, then follow the *Initial calibration* steps:
   - choose an AI brain and paste its key:
     - **Gemini (free):** get a key at <https://aistudio.google.com/apikey>. No card needed. It can read PDFs and photos and uses Google Search for research.
     - **Groq (free):** get a key at <https://console.groq.com/keys>. No card needed. Very fast, text only, and uses Groq's built-in web search for research.
     - **Claude (paid, smartest):** get a key at <https://platform.claude.com/settings/keys>. It needs API credits.
   - enter your name and how Jarvis should address you
   - optionally, **import your CV**

Keys are stored only on your device (IndexedDB) and are sent only to their own provider. You can switch brains at any time in **Profile → AI core**. The ↻ button there loads the provider's current model list.

> Free tiers have per-minute and per-day limits that change often. Google publishes its current limits in AI Studio, and Groq in its console. On Gemini, the Flash-Lite models usually allow the most requests per day. Google may use free-tier data to improve its products.

## The voice

Jarvis is designed to sound like a refined, warm British assistant who talks to you, not a machine reading text:

- **Natural voice (free):** Google's human-like Gemini voices. It uses your Gemini key, and the "Iapetus" voice is recommended. Each line is sent with a style direction: a calm, warm British butler with a natural, brisk rhythm.
- **HD voice:** ElevenLabs, the most realistic option. It has a free tier. One tap selects a premade British voice (George or Daniel).
- **Phone voice:** the device's built-in voice, which works offline.

How Jarvis speaks:
- The first sentence starts playing immediately. The next chunk's audio is fetched while the current one plays, so there are no robotic gaps.
- Only the spoken gist of a long answer is read aloud. Lists, headings and code stay on screen, and Jarvis says so.
- Abbreviations, symbols, emoji and links are turned into natural speech or skipped.
- You can adjust the pace in **Profile → Voice**.

> These are original voices. The app doesn't copy a real actor's voice, which would need that person's consent.

## Connect Gmail and Calendar (optional, about 2 minutes)

1. Go to <https://console.cloud.google.com/>, create a project, and enable the **Gmail API** and the **Google Calendar API**.
2. Go to **APIs & Services → OAuth consent screen**, choose External, and add yourself as a **test user**.
3. Go to **Credentials → Create credentials → OAuth client ID**, choose **Web application**, and under **Authorised JavaScript origins** add your app's origin (for example `https://ghazzen007.github.io`, and `http://localhost:5173` for development).
4. Paste the Client ID into **Profile → Connections**, then tap **Connect Gmail & Calendar**.

The sign-in runs entirely in the browser through Google Identity Services. The access token stays on your phone.

## Deploy (GitHub Pages)

The workflow `.github/workflows/deploy.yml` builds the app and publishes it on every push to `main`.

1. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Push to `main`, or run the workflow by hand from the **Actions** tab.
3. The app is then live at `https://<your-user>.github.io/Jarvis/`.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build in dist/
npm run preview    # serve the production build
node scripts/gen-icons.mjs   # regenerate the app icons (needs Playwright)
```

## How it is built

```
src/
  main.ts            boot sequence, router, wake word, scheduler wiring
  styles.css         HUD design system (glass panels, corner brackets, motion)
  visual/orb.ts      Three.js core: particle sphere (GLSL noise), audio-reactive
                     spikes, plexus network, geodesic core, data rings, dust
  core/providers.ts  free brains: Gemini (function calling + Google Search grounding)
                     and Groq (OpenAI-compatible tool calls + compound web search)
  core/brain.ts      Claude loop: streaming, parallel tool calls, web search,
                     refusal fallback, simple compaction, CV → profile extraction
  core/tools.ts      22 tools (tasks, reminders, notes, contacts, calls, SMS,
                     WhatsApp, email, inbox, calendar, weather, flashcards, focus…)
  core/prompt.ts     persona and profile (system prompt frozen per session),
                     live context added as mid-conversation system messages
  core/voice.ts      speech recognition, sentence-streamed speech output,
                     ElevenLabs HD voice with a WebAudio effects chain, wake word
  core/google.ts     Gmail and Calendar over REST with Google Identity Services
  core/store.ts      state persisted in IndexedDB
  ui/*.ts            Core, Tasks, Comms, Study and Profile screens, cards, sheets
```

**AI details.** The default model is `claude-opus-5-5` (Sonnet 5.5 and Haiku 5.5 can be chosen in settings). It uses adaptive thinking with an effort level you set: *Swift* for voice and *Deep* for research. It also uses server-side web search and web fetch, and server-side refusal fallback. The conversation history is append-only, with a frozen system prompt and context added as system messages, so prompt caching and earlier reasoning stay valid from turn to turn.

## Privacy and limits

- No backend. Your data, keys and history live only on your device. **Profile → Export data** saves a backup.
- Browsers can't place calls or send texts on their own. Jarvis prepares them, and you tap **Call** or **Send**.
- Reminders fire while the app is open or running in the background. If you need an alert that is guaranteed to arrive, ask Jarvis to put it in Google Calendar.
- The wake word works only while the app is open in the foreground, because browsers don't allow always-on listening.
