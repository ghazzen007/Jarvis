// Generates the app icon (SVG) and PNG sizes via the pre-installed Playwright Chromium.
// Usage: node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright"); // uses the globally installed Playwright (NODE_PATH)

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function orbSvg({ size = 512, pad = 0, bg = true } = {}) {
  const c = size / 2;
  const R = (size / 2 - pad) * 0.56;
  let dots = "";
  for (let i = 0; i < 900; i++) {
    const y = 1 - (i / 899) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = Math.PI * (3 - Math.sqrt(5)) * i;
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    // tilt
    const yy = y * Math.cos(0.35) - z * Math.sin(0.35);
    const zz = y * Math.sin(0.35) + z * Math.cos(0.35);
    const rim = 1 - Math.abs(zz);
    const a = (0.15 + 0.85 * Math.pow(rim, 1.6)) * (zz > 0 ? 1 : 0.55);
    const col = yy > 0.1 ? "#7cecff" : yy > -0.4 ? "#4fb8ff" : "#2a6bff";
    const s = (0.6 + rnd() * 1.1) * size / 512;
    dots += `<circle cx="${(c + x * R).toFixed(1)}" cy="${(c - yy * R).toFixed(1)}" r="${s.toFixed(2)}" fill="${col}" opacity="${a.toFixed(2)}"/>`;
  }
  const ring = (rx, ry, rot, op, dash) =>
    `<ellipse cx="${c}" cy="${c}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${c} ${c})" fill="none" stroke="#5ee6ff" stroke-width="${size / 256}" opacity="${op}" ${dash ? `stroke-dasharray="${size / 60} ${size / 90}"` : ""}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<defs>
<radialGradient id="bg" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#0a2238"/><stop offset=".6" stop-color="#030a14"/><stop offset="1" stop-color="#010307"/></radialGradient>
<radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset=".25" stop-color="#9ff3ff" stop-opacity=".8"/><stop offset="1" stop-color="#1d5bff" stop-opacity="0"/></radialGradient>
<radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset=".5" stop-color="#1d5bff" stop-opacity=".25"/><stop offset="1" stop-color="#1d5bff" stop-opacity="0"/></radialGradient>
</defs>
${bg ? `<rect width="${size}" height="${size}" fill="url(#bg)"/>` : ""}
<circle cx="${c}" cy="${c}" r="${R * 1.55}" fill="url(#halo)"/>
${ring(R * 1.32, R * 0.42, -18, 0.75, true)}
${ring(R * 1.24, R * 1.24, 0, 0.25, true)}
${ring(R * 1.4, R * 0.3, 24, 0.45, false)}
${dots}
<circle cx="${c}" cy="${c}" r="${R * 0.5}" fill="url(#core)"/>
</svg>`;
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon.svg", orbSvg({ size: 512 }));

const browser = await chromium.launch();
const page = await browser.newPage();
const shots = [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 60],
  ["apple-touch-icon.png", 180, 0],
];
for (const [name, size, pad] of shots) {
  seed = 7;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#000">${orbSvg({ size, pad })}</body></html>`);
  await page.screenshot({ path: `public/icons/${name}`, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log("icons written");
