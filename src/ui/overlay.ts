import { h } from "../core/util";

/* ------------------------------ toasts ------------------------------ */
export function toast(title: string, body: string, ms = 5000) {
  const host = document.getElementById("toasts")!;
  const el = h("div", { class: "toast panel" }, h("b", {}, title), h("span", {}, body));
  host.append(el);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 400);
  };
  el.addEventListener("click", close);
  setTimeout(close, ms);
}

/* ------------------------------ bottom sheet ------------------------------ */
let onClose: (() => void) | null = null;

export function openSheet(content: Node, closeCb?: () => void) {
  const sheet = document.getElementById("sheet")!;
  const body = sheet.querySelector(".sheet-body")!;
  body.replaceChildren(h("div", { class: "sheet-grip" }), content);
  onClose = closeCb ?? null;
  requestAnimationFrame(() => sheet.classList.add("open"));
}

export function closeSheet() {
  const sheet = document.getElementById("sheet")!;
  sheet.classList.remove("open");
  onClose?.();
  onClose = null;
}

export function initOverlays() {
  const sheet = document.getElementById("sheet")!;
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) closeSheet();
  });
}

/** Styled replacement for window.prompt(). */
export function askText(title: string, placeholder = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v?: string) => {
      if (done) return;
      done = true;
      resolve(v?.trim() || undefined);
    };
    const field = h("input", { class: "field", placeholder, enterkeyhint: "go" }) as HTMLInputElement;
    const form = h(
      "form",
      {},
      h("div", { class: "view-title", style: "font-size:17px" }, title),
      h("div", { style: "height:12px" }),
      field,
      h("div", { style: "height:14px" }),
      h("button", { class: "btn primary block", type: "submit" }, "Engage"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      finish(field.value);
      closeSheet();
    });
    openSheet(form, () => finish(undefined));
    setTimeout(() => field.focus(), 350);
  });
}
