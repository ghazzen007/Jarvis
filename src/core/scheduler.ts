import { state, commit } from "./store";

type Alert = (title: string, body: string) => void;

const notifiedTasks = new Set<string>();

async function notify(title: string, body: string) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: title + body });
    else new Notification(title, { body, icon: "icons/icon-192.png" });
  } catch {
    /* ignore */
  }
}

/** Checks reminders and due tasks every 15 s while the app is alive. */
export function startScheduler(alert: Alert) {
  const tick = () => {
    const now = Date.now();
    let changed = false;
    for (const r of state.reminders) {
      if (!r.fired && new Date(r.at).getTime() <= now) {
        r.fired = true;
        changed = true;
        alert("Reminder", r.message);
        void notify("Jarvis · Reminder", r.message);
      }
    }
    if (changed) {
      state.reminders = state.reminders.filter((r) => !r.fired || now - new Date(r.at).getTime() < 7 * 86400000);
      commit("reminders");
    }
    for (const t of state.tasks) {
      if (t.done || !t.due || notifiedTasks.has(t.id)) continue;
      const due = new Date(t.due).getTime();
      if (due <= now && now - due < 60 * 60 * 1000) {
        notifiedTasks.add(t.id);
        alert("Task due", t.title);
        void notify("Jarvis · Task due", t.title);
      }
    }
  };
  // Don't re-announce tasks that were already overdue when the app opened.
  const now = Date.now();
  state.tasks.forEach((t) => t.due && new Date(t.due).getTime() < now && notifiedTasks.add(t.id));
  tick();
  setInterval(tick, 15000);
}
