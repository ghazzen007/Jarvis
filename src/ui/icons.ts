const P: Record<string, string> = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7-7-1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.4 8.4a2 2 0 0 1-2.8-2.8L14.5 7"/>',
  core: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2.2"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>',
  comms: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  study: '<path d="M2 8.5 12 4l10 4.5-10 4.5z"/><path d="M6 10.5V16c3 2.5 9 2.5 12 0v-5.5M22 8.5V14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  sms: '<path d="M4 4h16v12H8l-4 4z"/>',
  whatsapp: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.6-2-1-1 .9c-1-.4-2.4-1.8-2.8-2.8l.9-1-1-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cards: '<rect x="3" y="7" width="13" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  brief: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  contacts: '<circle cx="9" cy="9" r="3.5"/><path d="M3 20c.8-3.4 3.2-5 6-5s5.2 1.6 6 5M16 5.5a3.5 3.5 0 0 1 0 7M18 15c1.6.6 2.6 2.2 3 5"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
};

export function icon(name: string, cls = ""): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;
}

export function iconEl(name: string, cls = ""): SVGElement {
  const t = document.createElement("template");
  t.innerHTML = icon(name, cls);
  return t.content.firstElementChild as SVGElement;
}

export const RINGS_SVG = `<svg class="rings" viewBox="0 0 100 100" fill="none" stroke="currentColor"><circle cx="50" cy="50" r="47" stroke-width="1" stroke-dasharray="2 5" opacity=".7"/><path d="M50 3a47 47 0 0 1 40 22" stroke-width="2" stroke-linecap="round"/><path d="M50 97a47 47 0 0 1-40-22" stroke-width="2" stroke-linecap="round" opacity=".6"/></svg>`;
