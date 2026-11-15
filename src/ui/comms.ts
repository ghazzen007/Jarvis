import { state, commit, uid, type Contact } from "../core/store";
import { h, esc, normalizePhone } from "../core/util";
import * as google from "../core/google";
import { icon } from "./icons";
import { openSheet, closeSheet, toast } from "./overlay";
import { cardActions } from "./cards";
import { renderClients } from "./hunter";

let root: HTMLElement;
let tab: "contacts" | "inbox" | "compose" | "clients" = "contacts";

/** Jump straight to the Client Hunter list. */
export function openClients() {
  tab = "clients";
  render();
}
let query = "";

interface PickerContact { name?: string[]; tel?: string[]; email?: string[] }
const picker = (navigator as unknown as { contacts?: { select(p: string[], o: { multiple: boolean }): Promise<PickerContact[]> } }).contacts;

async function importContacts() {
  if (!picker) {
    toast("Contacts", "Your browser can't share contacts — add them manually, or use Chrome on Android.");
    return;
  }
  try {
    const picked = await picker.select(["name", "tel", "email"], { multiple: true });
    let n = 0;
    for (const p of picked) {
      const name = p.name?.[0]?.trim();
      if (!name) continue;
      const ex = state.contacts.find((c) => c.name.toLowerCase() === name.toLowerCase());
      const data = { phone: p.tel?.[0], email: p.email?.[0] };
      if (ex) Object.assign(ex, Object.fromEntries(Object.entries(data).filter(([, v]) => v)));
      else state.contacts.push({ id: uid(), name, ...data });
      n++;
    }
    commit("contacts");
    toast("Contacts", `${n} contact${n === 1 ? "" : "s"} synced.`);
    render();
  } catch {
    /* user cancelled */
  }
}

function contactSheet(c?: Contact) {
  const name = h("input", { class: "field", placeholder: "Name", value: c?.name ?? "" }) as HTMLInputElement;
  const phone = h("input", { class: "field", type: "tel", placeholder: "+216 …", value: c?.phone ?? "" }) as HTMLInputElement;
  const email = h("input", { class: "field", type: "email", placeholder: "name@example.com", value: c?.email ?? "" }) as HTMLInputElement;
  const rel = h("input", { class: "field", placeholder: "e.g. Mum, Professor, Manager", value: c?.relation ?? "" }) as HTMLInputElement;
  const form = h(
    "form",
    {},
    h("div", { class: "view-title" }, c ? "Edit contact" : "New contact"),
    h("label", { class: "lbl" }, "Name"),
    name,
    h("label", { class: "lbl" }, "Phone"),
    phone,
    h("label", { class: "lbl" }, "Email"),
    email,
    h("label", { class: "lbl" }, "Relation"),
    rel,
  );
  const actions = h("div", { class: "row", style: "margin-top:16px" }, h("button", { class: "btn primary grow", type: "submit" }, "Save"));
  if (c) {
    const del = h("button", { class: "btn danger", type: "button" }, "Delete");
    del.addEventListener("click", () => {
      state.contacts = state.contacts.filter((x) => x.id !== c.id);
      commit("contacts");
      closeSheet();
      render();
    });
    actions.append(del);
  }
  form.append(actions);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    const data = { name: name.value.trim(), phone: phone.value.trim() || undefined, email: email.value.trim() || undefined, relation: rel.value.trim() || undefined };
    if (c) Object.assign(c, data);
    else state.contacts.push({ id: uid(), ...data });
    commit("contacts");
    closeSheet();
    render();
  });
  openSheet(form);
}

function contactItem(c: Contact, i: number) {
  const el = h("div", { class: "item", style: `--i:${i}` });
  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const info = h("div", { class: "grow", style: "cursor:pointer" });
  info.innerHTML = `<div class="title">${esc(c.name)}</div><div class="meta">${c.relation ? `<span class="tag">${esc(c.relation)}</span>` : ""}<span class="mono">${esc(c.phone ?? c.email ?? "")}</span></div>`;
  info.addEventListener("click", () => contactSheet(c));
  const acts = h("div", { class: "row", style: "gap:6px" });
  const a = (ic: string, href: string, label: string) => {
    const x = h("a", { class: "icon-btn", href, "aria-label": label, target: href.startsWith("http") ? "_blank" : "_self", rel: "noopener" });
    x.innerHTML = icon(ic);
    return x;
  };
  if (c.phone) {
    const ph = normalizePhone(c.phone);
    acts.append(a("phone", `tel:${ph}`, `Call ${c.name}`), a("whatsapp", `https://wa.me/${ph.replace(/^\+/, "")}`, `WhatsApp ${c.name}`));
  }
  if (c.email) acts.append(a("mail", `mailto:${c.email}`, `Email ${c.name}`));
  const avatar = h("div", { class: "avatar" }, initials);
  el.append(avatar, info, acts);
  return el;
}

async function loadInbox(body: HTMLElement) {
  body.replaceChildren(h("div", { class: "empty" }, "Scanning inbox…"));
  try {
    const items = await google.listInbox("in:inbox", 15);
    body.replaceChildren();
    const sum = h("button", { class: "btn primary block", type: "button", style: "margin-bottom:12px" });
    sum.innerHTML = `${icon("spark")}<span>Summarise with Jarvis</span>`;
    sum.addEventListener("click", () => cardActions.ask("Check my inbox and summarise what needs my attention, with suggested replies for anything urgent."));
    body.append(sum);
    items.forEach((m, i) => {
      const el = h("div", { class: "panel", style: `--i:${i}` });
      el.innerHTML = `<div class="row"><b class="grow" style="font-size:14px">${esc(m.subject || "(no subject)")}</b><span class="muted small">${esc(new Date(m.date).toLocaleDateString([], { day: "numeric", month: "short" }))}</span></div><div class="muted small">${esc(m.from.replace(/<.*>/, "").trim())}</div><div class="small" style="color:var(--text-2);margin-top:4px">${esc(m.snippet)}</div>`;
      const reply = h("button", { class: "btn sm ghost", type: "button", style: "margin-top:10px" });
      reply.innerHTML = `${icon("edit")}<span>Draft reply</span>`;
      reply.addEventListener("click", () => cardActions.ask(`Read the email with id ${m.id} ("${m.subject}") and draft a reply in my voice.`));
      el.append(reply);
      body.append(el);
    });
  } catch (e) {
    body.replaceChildren(h("div", { class: "empty" }, (e as Error).message));
  }
}

export function render() {
  if (!root) return;
  const segEl = h("div", { class: "seg" });
  for (const [v, l] of [
    ["contacts", "Contacts"],
    ["inbox", "Inbox"],
    ["compose", "Compose"],
    ["clients", "Clients"],
  ] as const) {
    const b = h("button", { type: "button", class: v === tab ? "on" : "" }, l);
    b.addEventListener("click", () => ((tab = v), render()));
    segEl.append(b);
  }
  const top = h(
    "div",
    {},
    h("div", { class: "view-title" }, "Comms", h("small", {}, `${state.contacts.length} contacts`)),
    h("p", { class: "view-sub" }, "Calls, messages and mail — or just say “Jarvis, call…”, “text…”, “email…”."),
    segEl,
  );
  const body = h("div", { class: "stagger", style: "margin-top:14px" });

  if (tab === "clients") {
    renderClients(body, render);
  } else if (tab === "contacts") {
    const search = h("input", { class: "field grow", placeholder: "Search contacts", value: query }) as HTMLInputElement;
    search.addEventListener("input", () => {
      query = search.value;
      renderList();
    });
    const imp = h("button", { class: "icon-btn", type: "button", "aria-label": "Import from phone" });
    imp.innerHTML = icon("contacts");
    imp.addEventListener("click", importContacts);
    const add = h("button", { class: "icon-btn", type: "button", "aria-label": "Add contact", style: "color:var(--cyan)" });
    add.innerHTML = icon("plus");
    add.addEventListener("click", () => contactSheet());
    top.append(h("div", { class: "row", style: "margin-top:12px" }, search, imp, add));
    const listEl = h("div", {});
    const renderList = () => {
      const q = query.toLowerCase();
      const list = state.contacts.filter((c) => !q || (c.name + " " + (c.relation ?? "")).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
      listEl.replaceChildren(...list.map(contactItem));
      if (!state.contacts.length) {
        const e = h("div", { class: "empty" });
        e.innerHTML = `<b>No contacts yet</b>Import from your phone so Jarvis can call, text and email people by name.`;
        const b = h("button", { class: "btn primary", type: "button", style: "margin-top:14px" });
        b.innerHTML = `${icon("contacts")}<span>Import contacts</span>`;
        b.addEventListener("click", importContacts);
        e.append(h("div", {}, b));
        listEl.append(e);
      }
    };
    renderList();
    body.append(listEl);
  } else if (tab === "inbox") {
    if (!google.googleConfigured()) {
      const e = h("div", { class: "empty" });
      e.innerHTML = `<b>Gmail not connected</b>Add your Google Client ID in Profile → Connections to let Jarvis read and send mail. Without it, Jarvis still drafts emails that open in your mail app.`;
      const b = h("button", { class: "btn", type: "button", style: "margin-top:14px" }, "Open settings");
      b.addEventListener("click", () => cardActions.goto("profile"));
      e.append(h("div", {}, b));
      body.append(e);
    } else if (!google.googleReady()) {
      const e = h("div", { class: "empty" });
      e.innerHTML = `<b>Sign in to Gmail</b>Tap to connect your Google account.`;
      const b = h("button", { class: "btn primary", type: "button", style: "margin-top:14px" });
      b.innerHTML = `${icon("mail")}<span>Connect Google</span>`;
      b.addEventListener("click", async () => {
        try {
          await google.connectGoogle(google.wasLinked() ? "" : "consent");
          render();
        } catch (err) {
          toast("Google", (err as Error).message);
        }
      });
      e.append(h("div", {}, b));
      body.append(e);
    } else void loadInbox(body);
  } else {
    const to = h("input", { class: "field", placeholder: "To (name or email)" }) as HTMLInputElement;
    const about = h("textarea", { class: "field", rows: "5", placeholder: "What should it say? e.g. Ask Prof. Ben Ali for an extension on the ML project until Friday, polite and brief." }) as HTMLTextAreaElement;
    const tone = h("select", { class: "field" }) as HTMLSelectElement;
    tone.innerHTML = ["Professional", "Friendly", "Formal (French)", "Concise", "Warm & personal"].map((t) => `<option>${t}</option>`).join("");
    const go = h("button", { class: "btn primary block", type: "submit", style: "margin-top:16px" });
    go.innerHTML = `${icon("spark")}<span>Draft with Jarvis</span>`;
    const form = h("form", { class: "panel" }, h("label", { class: "lbl", style: "margin-top:0" }, "Recipient"), to, h("label", { class: "lbl" }, "Message intent"), about, h("label", { class: "lbl" }, "Tone"), tone, go);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!about.value.trim()) return about.focus();
      cardActions.ask(`Draft an email to ${to.value || "(ask me who)"}. Tone: ${tone.value}. Intent: ${about.value}`);
    });
    const quick = h("div", { class: "panel" });
    quick.innerHTML = `<div class="section-label" style="margin-top:0">Quick ideas</div>`;
    for (const q of ["Follow up on my job application", "Ask my professor a question about the course", "Reschedule a meeting to tomorrow", "Thank-you note after an interview"]) {
      const c = h("button", { class: "chip", type: "button", style: "margin:0 6px 6px 0" }, q);
      c.addEventListener("click", () => {
        about.value = q;
        about.focus();
      });
      quick.append(c);
    }
    body.append(form, quick);
  }
  root.replaceChildren(top, body);
}

export function mountComms(el: HTMLElement) {
  root = el;
  render();
}
