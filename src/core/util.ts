export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** Small, safe markdown renderer (input is HTML-escaped first). */
export function md(src: string): string {
  const lines = esc(src).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let code = false;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      close();
      out.push(code ? "</pre>" : "<pre>");
      code = !code;
      continue;
    }
    if (code) {
      out.push(line);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const hd = line.match(/^(#{1,4})\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        close();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
    } else if (hd) {
      close();
      out.push(`<h4>${inline(hd[2])}</h4>`);
    } else if (line.trim() === "") {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  if (code) out.push("</pre>");
  return out.join("");
}

/** Text suitable for speech: no markdown, no URLs, no code. */
export function speakable(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | EventListener> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((day - today) / 86400000);
  const time = fmtTime(d);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + ` ${time}`;
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
