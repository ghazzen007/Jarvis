import type { CardData } from "../core/store";
import { h, fmtDue, normalizePhone, esc } from "../core/util";
import { icon } from "./icons";

/** Wired up by main.ts (avoids import cycles). */
export const cardActions = {
  ask: (_text: string) => {},
  openDeck: (_id: string) => {},
  goto: (_view: string) => {},
  openClients: () => {},
};

function head(ic: string, title: string, sub: string) {
  const el = h("div", { class: "card-head" });
  el.innerHTML = `<div class="ic">${icon(ic)}</div><div class="grow"><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div>`;
  return el;
}

function linkBtn(label: string, href: string, ic: string, cls = "btn sm") {
  const a = h("a", { class: cls, href, target: href.startsWith("http") ? "_blank" : "_self", rel: "noopener" });
  a.innerHTML = `${icon(ic)}<span>${esc(label)}</span>`;
  return a;
}

function btn(label: string, ic: string, onClick: () => void, cls = "btn sm") {
  const b = h("button", { class: cls, type: "button" });
  b.innerHTML = `${icon(ic)}<span>${esc(label)}</span>`;
  b.addEventListener("click", onClick);
  return b;
}

const mailto = (c: Extract<CardData, { kind: "email" }>) =>
  `mailto:${encodeURIComponent(c.to)}?subject=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.body)}${c.cc ? `&cc=${encodeURIComponent(c.cc)}` : ""}`;
const gmailWeb = (c: Extract<CardData, { kind: "email" }>) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.to)}&su=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.body)}`;

export interface ConfirmOpts {
  prompt: string;
  resolve: (ok: boolean) => void;
}

export function renderCard(c: CardData, confirm?: ConfirmOpts): HTMLElement {
  const el = h("div", { class: "panel card" });
  switch (c.kind) {
    case "email": {
      el.append(head("mail", c.status === "sent" ? "Email sent" : "Email draft", c.subject || "(no subject)"));
      const kv = h("div", { class: "kv" });
      kv.innerHTML = `<span>To</span><span>${esc(c.to)}</span>${c.cc ? `<span>Cc</span><span>${esc(c.cc)}</span>` : ""}<span>Subject</span><span class="subj">${esc(c.subject)}</span>`;
      const body = h("div", { class: "mail-body" }, c.body);
      el.append(kv, body);
      const actions = h("div", { class: "actions" });
      if (confirm && c.status === "draft") {
        const status = h("div", { class: "status-line no" }, confirm.prompt);
        const subj = kv.querySelector(".subj") as HTMLElement;
        const finish = (ok: boolean) => {
          c.subject = subj.innerText.trim();
          c.body = body.innerText;
          c.status = ok ? "sent" : "cancelled";
          body.contentEditable = "false";
          subj.contentEditable = "false";
          actions.remove();
          status.className = `status-line ${ok ? "ok" : "no"}`;
          status.textContent = ok ? "Approved — sending…" : "Not sent";
          confirm.resolve(ok);
        };
        actions.append(
          btn("Send", "send", () => finish(true), "btn sm primary"),
          btn("Edit", "edit", () => {
            body.contentEditable = "true";
            subj.contentEditable = "true";
            body.focus();
          }),
          btn("Cancel", "x", () => finish(false), "btn sm ghost"),
        );
        el.append(actions, status);
      } else if (c.status === "draft") {
        actions.append(linkBtn("Open in Mail", mailto(c), "mail", "btn sm primary"), linkBtn("Gmail", gmailWeb(c), "globe"));
        actions.append(btn("Copy", "note", () => void navigator.clipboard?.writeText(`${c.subject}\n\n${c.body}`)));
        el.append(actions);
      } else {
        el.append(h("div", { class: `status-line ${c.status === "sent" ? "ok" : "no"}` }, c.status === "sent" ? "Sent" : "Not sent"));
      }
      break;
    }
    case "call": {
      el.append(head("phone", "Call", c.name || c.phone));
      el.append(h("div", { class: "mono small muted" }, c.phone));
      if (c.purpose) {
        const p = h("div", { class: "mail-body" }, c.purpose);
        el.append(p);
      }
      const ph = normalizePhone(c.phone);
      el.append(
        h(
          "div",
          { class: "actions" },
          linkBtn("Call now", `tel:${ph}`, "phone", "btn sm primary"),
          linkBtn("SMS", `sms:${ph}`, "sms"),
          linkBtn("WhatsApp", `https://wa.me/${ph.replace(/^\+/, "")}`, "whatsapp"),
        ),
      );
      break;
    }
    case "message": {
      const ph = normalizePhone(c.phone);
      el.append(head(c.channel === "sms" ? "sms" : "whatsapp", c.channel === "sms" ? "SMS" : "WhatsApp", c.name || c.phone));
      el.append(h("div", { class: "mail-body" }, c.text));
      const href = c.channel === "sms" ? `sms:${ph}?body=${encodeURIComponent(c.text)}` : `https://wa.me/${ph.replace(/^\+/, "")}?text=${encodeURIComponent(c.text)}`;
      el.append(h("div", { class: "actions" }, linkBtn("Send", href, "send", "btn sm primary"), btn("Copy", "note", () => void navigator.clipboard?.writeText(c.text))));
      break;
    }
    case "task":
      el.append(head("tasks", "Task added", c.title));
      if (c.due || c.priority === "high")
        el.append(h("div", { class: "row small muted" }, c.due ? fmtDue(c.due) : "", c.priority === "high" ? h("span", { class: "tag high" }, "high") : null));
      el.addEventListener("click", () => cardActions.goto("tasks"));
      break;
    case "reminder":
      el.append(head("bell", "Reminder set", c.message));
      el.append(h("div", { class: "small muted" }, fmtDue(c.at)));
      break;
    case "note":
      el.append(head("note", "Note saved", c.title));
      el.addEventListener("click", () => cardActions.goto("tasks"));
      break;
    case "link":
      el.append(head("link", "Link", c.label));
      el.append(h("div", { class: "actions" }, linkBtn("Open", c.url, "globe", "btn sm primary")));
      break;
    case "sources": {
      el.append(head("search", "Sources", `${c.items.length} reference${c.items.length > 1 ? "s" : ""}`));
      for (const s of c.items) {
        const a = h("a", { class: "list-item", href: s.url, target: "_blank", rel: "noopener", style: "display:block;text-decoration:none;color:inherit" });
        a.innerHTML = `<b>${esc(s.title || s.url)}</b><span class="muted small">${esc(new URL(s.url).hostname.replace(/^www\./, ""))}</span>`;
        el.append(a);
      }
      break;
    }
    case "inbox":
      el.append(head("mail", "Inbox", c.items.length ? `${c.items.length} message${c.items.length > 1 ? "s" : ""}` : "Nothing new"));
      for (const m of c.items) {
        const it = h("div", { class: "list-item" });
        it.innerHTML = `<b>${esc(m.subject || "(no subject)")}</b><div class="muted small">${esc(m.from.replace(/<.*>/, "").trim())}</div><div class="small" style="color:var(--text-2)">${esc(m.snippet)}</div>`;
        const r = btn("Draft reply", "edit", () => cardActions.ask(`Draft a reply to the email with id ${m.id} ("${m.subject}"). Read it first.`), "btn sm ghost");
        r.style.marginTop = "6px";
        it.append(r);
        el.append(it);
      }
      break;
    case "events":
      el.append(head("cal", "Calendar", c.items.length ? `${c.items.length} event${c.items.length > 1 ? "s" : ""}` : "Clear schedule"));
      for (const e of c.items) {
        const it = h("div", { class: "list-item" });
        it.innerHTML = `<b>${esc(e.title)}</b><span class="muted small">${esc(e.start.length > 10 ? fmtDue(e.start) : e.start)}${e.location ? " · " + esc(e.location) : ""}</span>`;
        el.append(it);
      }
      break;
    case "weather": {
      el.append(head("sun", "Weather", c.place));
      const row = h("div", { class: "row" });
      row.innerHTML = `<div class="weather-big">${c.temp}°</div><div class="grow"><div style="text-transform:capitalize">${esc(c.now)}</div><div class="muted small">H ${c.high}° · L ${c.low}°</div></div>`;
      el.append(row);
      break;
    }
    case "deck":
      el.append(head("cards", "Flashcards ready", `${c.name} · ${c.count} cards`));
      el.append(h("div", { class: "actions" }, btn("Study now", "play", () => cardActions.openDeck(c.deckId), "btn sm primary")));
      break;
    case "leads": {
      el.append(head("search", "Client hunt", `${c.count} new lead${c.count === 1 ? "" : "s"} found`));
      for (const n of c.names.slice(0, 10)) el.append(h("div", { class: "list-item" }, n));
      el.append(h("div", { class: "actions" }, btn("Review & pitch", "send", () => cardActions.openClients(), "btn sm primary")));
      break;
    }
    case "focus":
      el.append(head("timer", "Focus session", `${c.minutes} min · ${c.label}`));
      el.append(h("div", { class: "actions" }, btn("Open timer", "timer", () => cardActions.goto("study"), "btn sm")));
      break;
  }
  return el;
}
