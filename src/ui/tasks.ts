import { state, commit, uid, type Category, type Priority, type Task } from "../core/store";
import { h, fmtDue, esc, md } from "../core/util";
import { icon } from "./icons";
import { openSheet, closeSheet } from "./overlay";

let root: HTMLElement;
let tab: "tasks" | "reminders" | "notes" = "tasks";
let filter: "today" | "open" | "done" = "open";

function seg<T extends string>(opts: [T, string][], cur: T, on: (v: T) => void) {
  const s = h("div", { class: "seg" });
  for (const [v, label] of opts) {
    const b = h("button", { type: "button", class: v === cur ? "on" : "" }, label);
    b.addEventListener("click", () => on(v));
    s.append(b);
  }
  return s;
}

function taskItem(t: Task, i: number): HTMLElement {
  const el = h("div", { class: `item${t.done ? " done" : ""}`, style: `--i:${i}` });
  const chk = h("button", { class: "check", type: "button", "aria-label": t.done ? "Mark not done" : "Mark done" });
  chk.innerHTML = icon("check");
  chk.addEventListener("click", () => {
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : undefined;
    el.classList.toggle("done", t.done);
    commit("tasks");
    if (filter !== "done" && t.done) {
      setTimeout(() => {
        el.classList.add("removing");
        setTimeout(render, 380);
      }, 450);
    }
  });
  const overdue = !t.done && t.due && new Date(t.due).getTime() < Date.now();
  const info = h("div", { class: "grow" });
  info.innerHTML = `<div class="title">${esc(t.title)}</div><div class="meta">${t.due ? `<span style="${overdue ? "color:var(--red)" : ""}">${esc(fmtDue(t.due))}</span>` : ""}<span class="tag ${t.category}">${t.category}</span>${t.priority === "high" ? '<span class="tag high">high</span>' : ""}${t.notes ? `<span>${esc(t.notes.slice(0, 50))}</span>` : ""}</div>`;
  const del = h("button", { class: "icon-btn", type: "button", "aria-label": "Delete task" });
  del.innerHTML = icon("trash");
  del.addEventListener("click", () => {
    el.classList.add("removing");
    setTimeout(() => {
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      commit("tasks");
      render();
    }, 350);
  });
  el.append(chk, info, del);
  return el;
}

function addTaskSheet() {
  const title = h("input", { class: "field", placeholder: "What needs doing?" }) as HTMLInputElement;
  const due = h("input", { class: "field", type: "datetime-local" }) as HTMLInputElement;
  const pr = h("select", { class: "field" }) as HTMLSelectElement;
  pr.innerHTML = '<option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option>';
  const cat = h("select", { class: "field" }) as HTMLSelectElement;
  cat.innerHTML = ["personal", "study", "work", "errand", "health"].map((c) => `<option>${c}</option>`).join("");
  const save = h("button", { class: "btn primary block", type: "submit" }, "Add task");
  const form = h(
    "form",
    {},
    h("div", { class: "view-title" }, "New task"),
    h("label", { class: "lbl" }, "Title"),
    title,
    h("label", { class: "lbl" }, "Due"),
    due,
    h("div", { class: "row", style: "gap:10px" }, h("div", { class: "grow" }, h("label", { class: "lbl" }, "Priority"), pr), h("div", { class: "grow" }, h("label", { class: "lbl" }, "Category"), cat)),
    h("div", { style: "height:16px" }),
    save,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!title.value.trim()) return title.focus();
    state.tasks.unshift({
      id: uid(),
      title: title.value.trim(),
      due: due.value ? new Date(due.value).toISOString() : undefined,
      priority: pr.value as Priority,
      category: cat.value as Category,
      done: false,
      createdAt: Date.now(),
    });
    commit("tasks");
    closeSheet();
    render();
  });
  openSheet(h("div", { class: "panel sheet-body-inner", style: "border:0;background:none;padding:0" }, form));
  setTimeout(() => title.focus(), 350);
}

function noteSheet(id?: string) {
  const n = state.notes.find((x) => x.id === id);
  const title = h("input", { class: "field", placeholder: "Title", value: n?.title ?? "" }) as HTMLInputElement;
  const content = h("textarea", { class: "field", rows: "10", placeholder: "Write…" }) as HTMLTextAreaElement;
  content.value = n?.content ?? "";
  const form = h("form", {}, h("div", { class: "view-title" }, n ? "Edit note" : "New note"), h("label", { class: "lbl" }, "Title"), title, h("label", { class: "lbl" }, "Content"), content);
  const actions = h("div", { class: "row", style: "margin-top:14px" }, h("button", { class: "btn primary grow", type: "submit" }, "Save"));
  if (n) {
    const del = h("button", { class: "btn danger", type: "button" }, "Delete");
    del.addEventListener("click", () => {
      state.notes = state.notes.filter((x) => x.id !== n.id);
      commit("notes");
      closeSheet();
      render();
    });
    actions.append(del);
  }
  form.append(actions);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (n) Object.assign(n, { title: title.value || "Untitled", content: content.value, updatedAt: Date.now() });
    else state.notes.unshift({ id: uid(), title: title.value || "Untitled", content: content.value, tags: [], createdAt: Date.now(), updatedAt: Date.now() });
    commit("notes");
    closeSheet();
    render();
  });
  openSheet(form);
}

export function render() {
  if (!root) return;
  const top = h(
    "div",
    {},
    h("div", { class: "view-title" }, "Operations", h("small", {}, new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))),
    h("p", { class: "view-sub" }, "Everything you need to get done — Jarvis keeps this in sync when you ask by voice."),
    seg(
      [
        ["tasks", "Tasks"],
        ["reminders", "Reminders"],
        ["notes", "Notes"],
      ],
      tab,
      (v) => ((tab = v), render()),
    ),
  );
  const body = h("div", { class: "stagger", style: "margin-top:14px" });

  if (tab === "tasks") {
    const bar = h(
      "div",
      { class: "row", style: "margin-bottom:12px" },
      seg(
        [
          ["open", "Open"],
          ["today", "Today"],
          ["done", "Done"],
        ],
        filter,
        (v) => ((filter = v), render()),
      ),
      (() => {
        const b = h("button", { class: "icon-btn", type: "button", "aria-label": "Add task", style: "color:var(--cyan)" });
        b.innerHTML = icon("plus");
        b.addEventListener("click", addTaskSheet);
        return b;
      })(),
    );
    (bar.firstElementChild as HTMLElement).classList.add("grow");
    top.append(h("div", { style: "height:12px" }), bar);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const list = state.tasks
      .filter((t) => (filter === "done" ? t.done : !t.done && (filter === "open" || (t.due && new Date(t.due) <= endOfDay))))
      .sort((a, b) => {
        if (filter === "done") return (b.doneAt ?? 0) - (a.doneAt ?? 0);
        const pa = a.priority === "high" ? 0 : 1;
        const pb = b.priority === "high" ? 0 : 1;
        const da = a.due ? new Date(a.due).getTime() : Infinity;
        const db = b.due ? new Date(b.due).getTime() : Infinity;
        return da - db || pa - pb;
      });
    if (!list.length) {
      const e = h("div", { class: "empty" });
      e.innerHTML = `<b>${filter === "done" ? "Nothing completed yet" : "All clear"}</b>${filter === "done" ? "Finished tasks appear here." : 'Say "Jarvis, remind me to…" or tap + to add one.'}`;
      body.append(e);
    }
    list.forEach((t, i) => body.append(taskItem(t, i)));
  } else if (tab === "reminders") {
    const list = state.reminders.slice().sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    if (!list.length) {
      const e = h("div", { class: "empty" });
      e.innerHTML = '<b>No reminders</b>Try: "Remind me to call mum at 7pm".';
      body.append(e);
    }
    list.forEach((r, i) => {
      const el = h("div", { class: `item${r.fired ? " done" : ""}`, style: `--i:${i}` });
      el.innerHTML = `<div class="avatar">${icon("bell")}</div><div class="grow"><div class="title">${esc(r.message)}</div><div class="meta">${esc(fmtDue(r.at))}${r.fired ? " · delivered" : ""}</div></div>`;
      const del = h("button", { class: "icon-btn", type: "button", "aria-label": "Delete reminder" });
      del.innerHTML = icon("trash");
      del.addEventListener("click", () => {
        state.reminders = state.reminders.filter((x) => x.id !== r.id);
        commit("reminders");
        render();
      });
      el.append(del);
      el.querySelector(".avatar svg")?.setAttribute("style", "width:18px;height:18px");
      body.append(el);
    });
  } else {
    const add = h("button", { class: "btn block", type: "button", style: "margin-bottom:12px" });
    add.innerHTML = `${icon("plus")}<span>New note</span>`;
    add.addEventListener("click", () => noteSheet());
    body.append(add);
    if (!state.notes.length) {
      const e = h("div", { class: "empty" });
      e.innerHTML = '<b>No notes</b>Dictate one: "Jarvis, take a note…"';
      body.append(e);
    }
    state.notes.forEach((n, i) => {
      const el = h("div", { class: "panel", style: `--i:${i};cursor:pointer` });
      el.innerHTML = `<div class="row"><div class="grow"><b>${esc(n.title)}</b></div><span class="muted small">${new Date(n.updatedAt).toLocaleDateString()}</span></div><div class="small" style="color:var(--text-2);max-height:66px;overflow:hidden;margin-top:4px">${md(n.content.slice(0, 260))}</div>`;
      el.addEventListener("click", () => noteSheet(n.id));
      body.append(el);
    });
  }
  root.replaceChildren(top, body);
}

export function mountTasks(el: HTMLElement) {
  root = el;
  render();
}
