import { state, commit, type Lead, type LeadStatus } from "../core/store";
import { h, esc, normalizePhone, todayKey } from "../core/util";
import * as google from "../core/google";
import { findLeads, draftPitch, demoPrompt, markContacted, detectArea } from "../core/hunter";
import { icon } from "./icons";
import { openSheet, closeSheet, toast } from "./overlay";

let filter: LeadStatus | "all" = "all";
let count = 7;
let hunting = false;

const STATUS: [LeadStatus, string][] = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["demo", "Demo sent"],
  ["won", "Won"],
  ["lost", "Not interested"],
];

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function linkChip(label: string, href: string, ic: string) {
  const a = h("a", { class: "chip", href, target: href.startsWith("http") ? "_blank" : "_self", rel: "noopener", style: "text-decoration:none" });
  a.innerHTML = `${icon(ic)}${esc(label)}`;
  return a;
}

function btn(label: string, ic: string, fn: () => void, cls = "btn sm") {
  const b = h("button", { class: cls, type: "button" });
  b.innerHTML = `${icon(ic)}<span>${esc(label)}</span>`;
  b.addEventListener("click", fn);
  return b;
}

/* ------------------------------------------------------------ pitch sheet */
async function openPitch(lead: Lead, rerender: () => void) {
  const wrap = h("div", {});
  openSheet(wrap, rerender);
  const loading = (msg: string) => wrap.replaceChildren(h("div", { class: "view-title", style: "font-size:17px" }, lead.name), h("div", { class: "empty" }, msg));
  if (!lead.pitch || lead.pitch.lang !== state.settings.hunter.language) {
    loading("Jarvis is writing a personalised pitch…");
    try {
      await draftPitch(lead);
    } catch (e) {
      loading((e as Error).message);
      return;
    }
  }
  const p = lead.pitch!;
  const subject = h("input", { class: "field", value: p.subject }) as HTMLInputElement;
  const body = h("textarea", { class: "field", rows: "11" }) as HTMLTextAreaElement;
  body.value = p.body;
  const dm = h("textarea", { class: "field", rows: "5" }) as HTMLTextAreaElement;
  dm.value = p.dm;
  const save = () => {
    p.subject = subject.value;
    p.body = body.value;
    p.dm = dm.value;
    commit("leads");
  };
  [subject, body, dm].forEach((el) => el.addEventListener("change", save));

  const done = (channel: string, msg: string) => {
    save();
    markContacted(lead, channel);
    toast("Clients", msg);
  };

  const emailActs = h("div", { class: "row wrap", style: "margin-top:10px" });
  if (lead.email) {
    if (google.googleConfigured() && (google.googleReady() || google.wasLinked())) {
      emailActs.append(
        btn(
          "Send via Gmail",
          "send",
          async () => {
            save();
            try {
              await google.sendEmail(lead.email!, p.subject, p.body);
              done("email", `Email sent to ${lead.name}. Follow-up reminder set for 3 days.`);
              closeSheet();
            } catch (e) {
              toast("Gmail", (e as Error).message, 7000);
            }
          },
          "btn sm primary",
        ),
      );
    }
    emailActs.append(
      btn("Open in Mail", "mail", () => {
        save();
        location.href = `mailto:${encodeURIComponent(lead.email!)}?subject=${encodeURIComponent(p.subject)}&body=${encodeURIComponent(p.body)}`;
        done("email", "Opened in your mail app.");
      }),
    );
  } else emailActs.append(h("span", { class: "hint", style: "margin:0" }, "No public email found — use a message channel below."));

  const dmActs = h("div", { class: "row wrap", style: "margin-top:10px" });
  if (lead.phone) {
    const ph = normalizePhone(lead.phone).replace(/^\+/, "");
    dmActs.append(
      btn("WhatsApp", "whatsapp", () => {
        save();
        window.open(`https://wa.me/${ph}?text=${encodeURIComponent(p.dm)}`, "_blank");
        done("whatsapp", "WhatsApp opened with your message.");
      }, "btn sm primary"),
    );
  }
  for (const [key, label, ic] of [
    ["instagram", "Instagram", "globe"],
    ["facebook", "Facebook", "globe"],
  ] as const) {
    const href = lead[key];
    if (!href) continue;
    dmActs.append(
      btn(label, ic, async () => {
        save();
        const ok = await copy(p.dm);
        window.open(href, "_blank");
        done(key, ok ? `Message copied — tap “Message” on their ${label} page and paste.` : `Open their ${label} page and paste your message.`);
      }),
    );
  }
  if (!dmActs.childElementCount) dmActs.append(h("span", { class: "hint", style: "margin:0" }, "No phone or social page found for this business."));

  const rewrite = btn("Rewrite", "reset", async () => {
    lead.pitch = undefined;
    closeSheet();
    setTimeout(() => void openPitch(lead, rerender), 350);
  }, "btn sm ghost");

  wrap.replaceChildren(
    h("div", { class: "row" }, h("div", { class: "view-title grow", style: "font-size:17px" }, lead.name), rewrite),
    h("p", { class: "view-sub" }, "Review and edit before sending — nothing is sent until you tap a button."),
    h("label", { class: "lbl" }, "Email subject"),
    subject,
    h("label", { class: "lbl" }, "Email"),
    body,
    emailActs,
    h("div", { class: "section-label" }, "Message (WhatsApp · Instagram · Facebook)"),
    dm,
    dmActs,
    h("div", { class: "section-label" }, "Demo website"),
    h(
      "div",
      { class: "row wrap" },
      btn("Copy demo prompt", "cards", async () => {
        const ok = await copy(demoPrompt(lead));
        toast("Demo", ok ? "Demo prompt copied. Paste it into a new Claude chat." : "Couldn't copy — try again.");
      }),
      btn("Open Claude", "spark", () => window.open("https://claude.ai/new", "_blank")),
    ),
    h("p", { class: "hint" }, "Tip: send the demo once they reply interested — it converts better and saves your Claude usage."),
  );
}

/* ------------------------------------------------------------ lead card */
function leadCard(lead: Lead, i: number, rerender: () => void) {
  const el = h("div", { class: "panel", style: `--i:${i}` });
  const sw = (lead.palette ?? []).map((c) => `<i style="background:${esc(c)}"></i>`).join("");
  const statusLabel = STATUS.find(([s]) => s === lead.status)?.[1] ?? lead.status;
  el.innerHTML = `<div class="row"><div class="avatar" style="background:linear-gradient(135deg,${esc((lead.palette ?? ["#5ee6ff", "#1d5bff"]).join(","))});color:#fff;text-shadow:0 1px 3px #000">${esc(lead.name.slice(0, 2).toUpperCase())}</div><div class="grow"><b style="font-size:15px">${esc(lead.name)}</b><div class="small muted">${esc(lead.category)}${lead.address ? " · " + esc(lead.address) : ""}</div></div><span class="tag ${lead.status === "won" ? "health" : lead.status === "new" ? "work" : lead.status === "lost" ? "" : "errand"}">${esc(statusLabel)}</span></div>${lead.why ? `<div class="small" style="color:var(--text-2);margin-top:8px">${esc(lead.why)}</div>` : ""}${sw ? `<div class="swatches">${sw}</div>` : ""}`;
  const chips = h("div", { class: "row wrap", style: "margin-top:10px;gap:6px" });
  if (lead.email) chips.append(linkChip("Email", `mailto:${lead.email}`, "mail"));
  if (lead.phone) chips.append(linkChip(lead.phone, `tel:${normalizePhone(lead.phone)}`, "phone"));
  if (lead.instagram) chips.append(linkChip("Instagram", lead.instagram, "globe"));
  if (lead.facebook) chips.append(linkChip("Facebook", lead.facebook, "globe"));
  if (lead.mapsUrl) chips.append(linkChip("Maps", lead.mapsUrl, "search"));
  if (lead.source && lead.source !== lead.mapsUrl) chips.append(linkChip("Source", lead.source, "link"));
  el.append(chips);

  const sel = h("select", { class: "field", style: "height:34px;width:auto;flex:1;min-width:120px;font-size:13px" }) as HTMLSelectElement;
  sel.innerHTML = STATUS.map(([v, l]) => `<option value="${v}" ${v === lead.status ? "selected" : ""}>${l}</option>`).join("");
  sel.addEventListener("change", () => {
    lead.status = sel.value as LeadStatus;
    commit("leads");
    rerender();
  });
  const del = h("button", { class: "icon-btn", type: "button", "aria-label": "Remove lead", style: "width:34px;height:34px" });
  del.innerHTML = icon("trash");
  del.addEventListener("click", () => {
    state.leads = state.leads.filter((l) => l.id !== lead.id);
    commit("leads");
    rerender();
  });
  el.append(
    h(
      "div",
      { class: "row", style: "margin-top:12px;gap:8px" },
      btn(lead.pitch ? "Pitch" : "Write pitch", "send", () => void openPitch(lead, rerender), "btn sm primary"),
      btn("Demo", "cards", async () => {
        const ok = await copy(demoPrompt(lead));
        toast("Demo", ok ? "Demo prompt copied — paste it into Claude." : "Couldn't copy.");
      }),
      sel,
      del,
    ),
  );
  return el;
}

/* ------------------------------------------------------------ offer settings */
function offerSheet(rerender: () => void) {
  const hs = state.settings.hunter;
  const f = (label: string, key: keyof typeof hs, ph = "") => {
    const i = h("input", { class: "field", value: String(hs[key] ?? ""), placeholder: ph }) as HTMLInputElement;
    i.addEventListener("change", () => {
      (hs as unknown as Record<string, string>)[key] = i.value.trim();
      commit("settings");
    });
    return [h("label", { class: "lbl" }, label), i];
  };
  openSheet(
    h(
      "div",
      {},
      h("div", { class: "view-title", style: "font-size:17px" }, "Your offer & signature"),
      ...f("Your name (signature)", "senderName", state.profile.name || "Ghassen Jdidi"),
      ...f("Phone / WhatsApp", "senderPhone", "+216 …"),
      ...f("Portfolio link (optional)", "portfolio", "https://…"),
      ...f("Pack 1", "pack1"),
      ...f("Pack 2", "pack2"),
      ...f("Pack 3", "pack3"),
      h("p", { class: "hint" }, "Tip: for local clients you can write prices in dinars, e.g. “300 TND”. Changes apply to new pitches (tap Rewrite on existing ones)."),
      h("div", { style: "height:12px" }),
      h("button", { class: "btn primary block", type: "button", onclick: () => closeSheet() }, "Done"),
    ),
    rerender,
  );
}

/* ------------------------------------------------------------ main */
export function renderClients(body: HTMLElement, rerender: () => void) {
  const hs = state.settings.hunter;
  const area = h("input", { class: "field grow", value: hs.area, placeholder: "Your area, e.g. Ariana, Tunisia" }) as HTMLInputElement;
  area.addEventListener("change", () => {
    hs.area = area.value.trim();
    commit("settings");
  });
  const locate = h("button", { class: "icon-btn", type: "button", "aria-label": "Use my location" });
  locate.innerHTML = icon("globe");
  locate.addEventListener("click", async () => {
    try {
      hs.area = await detectArea();
      commit("settings");
      area.value = hs.area;
      toast("Clients", `Area set to ${hs.area}.`);
    } catch (e) {
      toast("Clients", (e as Error).message, 6000);
    }
  });

  const seg = <T extends string | number>(opts: [T, string][], cur: T, on: (v: T) => void) => {
    const s = h("div", { class: "seg grow" });
    for (const [v, l] of opts) {
      const b = h("button", { type: "button", class: v === cur ? "on" : "" }, l);
      b.addEventListener("click", () => on(v));
      s.append(b);
    }
    return s;
  };
  const langSeg = seg<"fr" | "en" | "ar">(
    [
      ["fr", "FR"],
      ["en", "EN"],
      ["ar", "AR"],
    ],
    hs.language,
    (v) => {
      hs.language = v;
      commit("settings");
      rerender();
    },
  );
  const countSeg = seg<number>(
    [
      [5, "5"],
      [7, "7"],
      [10, "10"],
    ],
    count,
    (v) => {
      count = v;
      rerender();
    },
  );

  const go = h("button", { class: "btn primary block", type: "button", style: "margin-top:12px" }) as HTMLButtonElement;
  const paintGo = () => {
    go.disabled = hunting;
    go.innerHTML = hunting
      ? `<span class="bars" style="display:inline-flex;gap:3px;align-items:flex-end;height:12px"><i style="width:3px;background:currentColor;animation:eq .9s infinite"></i><i style="width:3px;background:currentColor;animation:eq .9s -.3s infinite"></i><i style="width:3px;background:currentColor;animation:eq .9s -.6s infinite"></i></span><span>Searching Maps & socials…</span>`
      : `${icon("search")}<span>Find today's leads</span>`;
  };
  paintGo();
  go.addEventListener("click", async () => {
    if (hunting) return;
    hs.area = area.value.trim() || hs.area;
    hunting = true;
    paintGo();
    try {
      const leads = await findLeads(count, hs.area || undefined);
      toast("Clients", `${leads.length} new businesses found.`);
      filter = "new";
    } catch (e) {
      toast("Clients", (e as Error).message, 8000);
    } finally {
      hunting = false;
      rerender();
    }
  });

  const today = todayKey();
  const top = h(
    "div",
    { class: "panel" },
    h("div", { class: "row" }, h("div", { class: "section-label grow", style: "margin:0" }, "Client hunter"), btn("Offer", "edit", () => offerSheet(rerender), "btn sm ghost")),
    h("label", { class: "lbl" }, "Area"),
    h("div", { class: "row" }, area, locate),
    h("div", { class: "row", style: "margin-top:12px" }, h("div", { class: "grow" }, h("label", { class: "lbl", style: "margin-top:0" }, "Pitch language"), langSeg), h("div", { class: "grow" }, h("label", { class: "lbl", style: "margin-top:0" }, "Leads"), countSeg)),
    go,
    h(
      "p",
      { class: "hint" },
      `${hs.lastHunt === today ? "Today's hunt is done. " : ""}Jarvis researches with web search and drafts; you review and send. Check details through the source link — AI research can be wrong.`,
    ),
  );

  // pipeline filter
  const counts = (s: LeadStatus) => state.leads.filter((l) => l.status === s).length;
  const pipe = h("div", { class: "chips", style: "padding:12px 0 4px" });
  for (const [v, l] of [["all", `All ${state.leads.length}`], ...STATUS.map(([s, lab]) => [s, `${lab} ${counts(s)}`])] as [LeadStatus | "all", string][]) {
    const c = h("button", { class: "chip", type: "button", style: v === filter ? "border-color:var(--cyan);color:var(--text)" : "" }, l);
    c.addEventListener("click", () => {
      filter = v;
      rerender();
    });
    pipe.append(c);
  }

  const list = h("div", { class: "stagger" });
  const shown = state.leads.filter((l) => filter === "all" || l.status === filter);
  if (!shown.length) {
    const e = h("div", { class: "empty" });
    e.innerHTML = state.leads.length
      ? "<b>Nothing here</b>No leads with this status."
      : "<b>No leads yet</b>Tap “Find today's leads”, or say “Jarvis, run today's client hunt”.";
    list.append(e);
  }
  shown.forEach((l, i) => list.append(leadCard(l, i, rerender)));
  body.append(top, pipe, list);
}
