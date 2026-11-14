import * as THREE from "three";
import { SIMPLEX } from "./noise";

export type OrbMode = "idle" | "listening" | "thinking" | "speaking";
export type OrbLayout = "hero" | "ambient";

interface Look {
  top: THREE.Color;
  bottom: THREE.Color;
  accent: THREE.Color;
  amp: number;
  spin: number;
  ring: number;
  spike: number;
  core: number;
  plexus: number;
}

const look = (top: number, bottom: number, accent: number, p: Omit<Look, "top" | "bottom" | "accent">): Look => ({
  top: new THREE.Color(top),
  bottom: new THREE.Color(bottom),
  accent: new THREE.Color(accent),
  ...p,
});

const LOOKS: Record<OrbMode, Look> = {
  idle: look(0x6eeaff, 0x3a7bff, 0x5ee6ff, { amp: 0.35, spin: 0.07, ring: 0.25, spike: 0.12, core: 0.55, plexus: 0.22 }),
  listening: look(0xffffff, 0x6fe8ff, 0xc4f7ff, { amp: 0.75, spin: 0.1, ring: 0.45, spike: 0.38, core: 1.0, plexus: 0.4 }),
  thinking: look(0xa093ff, 0x2bd2ff, 0xa093ff, { amp: 0.55, spin: 0.32, ring: 1.7, spike: 0.22, core: 0.85, plexus: 0.65 }),
  speaking: look(0xffb045, 0xfff1dc, 0xffb045, { amp: 1.0, spin: 0.12, ring: 0.6, spike: 0.62, core: 1.25, plexus: 0.45 }),
};

const SHELL_VS = /* glsl */ `
${SIMPLEX}
uniform float uTime, uAmp, uLevel, uAssemble, uSize, uPR;
attribute vec3 aScatter;
attribute float aRand;
varying float vY;
varying float vAlpha;
varying float vRand;
void main(){
  vec3 n = normalize(position);
  float big = snoise(n * 1.5 + vec3(0.0, uTime * 0.28, uTime * 0.12));
  float fine = snoise(n * 4.2 - uTime * 0.55);
  float r = 1.0 + big * 0.085 * uAmp + fine * 0.035 * uAmp + uLevel * 0.09 * (0.5 + 0.5 * sin(uTime * 9.0 + aRand * 6.2831));
  vec3 target = position * r;
  float t = clamp(uAssemble * 1.6 - aRand * 0.6, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  vec3 p = mix(aScatter, target, t);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.55 + aRand * 0.9) * uPR / -mv.z;
  vec3 vn = normalize(normalMatrix * n);
  float rim = 1.0 - abs(vn.z);
  vAlpha = (0.18 + 0.82 * pow(rim, 1.6)) * (0.55 + 0.45 * step(0.0, vn.z)) * (0.35 + 0.65 * t);
  vY = n.y;
  vRand = aRand;
}`;

const SHELL_FS = /* glsl */ `
uniform vec3 uTop, uBottom;
uniform float uTime;
varying float vY;
varying float vAlpha;
varying float vRand;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.0, d);
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + vRand * 3.0) + vRand * 40.0);
  vec3 col = mix(uBottom, uTop, smoothstep(-0.55, 0.65, vY));
  gl_FragColor = vec4(col, soft * vAlpha * tw);
}`;

const SPIKE_VS = /* glsl */ `
${SIMPLEX}
uniform float uTime, uSpike, uLevel, uAssemble;
attribute float aEnd;
attribute float aRand;
varying float vA;
void main(){
  vec3 dir = normalize(position);
  float n = abs(snoise(dir * 2.6 + vec3(uTime * 0.9)));
  float len = (0.03 + uSpike * (0.12 + 0.9 * n) * (0.45 + uLevel * 1.4)) * uAssemble;
  float r = 1.13 + aEnd * len;
  vec4 mv = modelViewMatrix * vec4(dir * r, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 vn = normalize(normalMatrix * dir);
  vA = (1.0 - aEnd * 0.95) * (0.25 + 0.75 * (1.0 - abs(vn.z))) * (0.4 + 0.6 * aRand);
}`;

const SPIKE_FS = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main(){ gl_FragColor = vec4(uColor, vA * 0.85); }`;

function fib(i: number, n: number): THREE.Vector3 {
  const y = 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const th = Math.PI * (3 - Math.sqrt(5)) * i;
  return new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
}

function randDir(): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t));
}

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function dataTexture(seed: number): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 48;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.font = "600 26px 'JetBrains Mono', ui-monospace, monospace";
  g.textBaseline = "middle";
  let x = 8;
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const words = ["SYS", "NODE", "CORE", "LINK", "SYNC", "MEM", "NET", "AUX", "PWR", "RX", "TX", "QPU"];
  while (x < c.width) {
    const r = rnd();
    if (r < 0.35) {
      const w = 20 + rnd() * 80;
      g.globalAlpha = 0.5 + rnd() * 0.5;
      g.fillRect(x, 14 + rnd() * 6, w, 6 + rnd() * 8);
      x += w + 10;
    } else {
      const txt =
        r < 0.6
          ? `${words[Math.floor(rnd() * words.length)]}.${Math.floor(rnd() * 9999).toString().padStart(4, "0")}`
          : `0x${Math.floor(rnd() * 0xffffff).toString(16).toUpperCase().padStart(6, "0")}`;
      g.globalAlpha = 0.45 + rnd() * 0.55;
      g.fillText(txt, x, 24);
      x += g.measureText(txt).width + 18;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

interface Ring {
  obj: THREE.Object3D;
  speed: number;
  mats: THREE.Material[];
}

export class Orb {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  private root = new THREE.Group(); // positioned by layout
  private spin = new THREE.Group(); // rotated by user + auto-spin
  private shellMat: THREE.ShaderMaterial;
  private spikeMat: THREE.ShaderMaterial;
  private plexus: THREE.LineSegments;
  private geodesic: THREE.LineSegments;
  private nodes: THREE.Points;
  private core: THREE.Sprite;
  private halo: THREE.Sprite;
  private dust: THREE.Points;
  private rings: Ring[] = [];
  private clock = new THREE.Clock();
  private mode: OrbMode = "idle";
  private layout: OrbLayout = "hero";
  private cur: Look = { ...LOOKS.idle, top: LOOKS.idle.top.clone(), bottom: LOOKS.idle.bottom.clone(), accent: LOOKS.idle.accent.clone() };
  private assemble = 0;
  private assembleTarget = 0;
  private level = 0;
  private levelSource: () => number = () => 0;
  private drag = { active: false, x: 0, y: 0, vx: 0, vy: 0, moved: 0 };
  private rot = new THREE.Euler(0.25, 0, 0);
  private layoutPos = new THREE.Vector3();
  private layoutScale = 1;
  private running = true;
  onTap: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, lowPower = false) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.root);
    this.root.add(this.spin);
    this.camera.position.set(0, 0, 6);

    const mobile = matchMedia("(max-width: 700px)").matches;
    const N = lowPower ? 3500 : mobile ? 7000 : 10000;
    const pr = Math.min(devicePixelRatio, mobile ? 2 : 2);

    // ---- particle shell -------------------------------------------------
    const pos = new Float32Array(N * 3);
    const scatter = new Float32Array(N * 3);
    const rand = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // Mix even (fibonacci) + pole-biased distribution — gives the dense
      // glowing poles seen in the particle-sphere references.
      let v: THREE.Vector3;
      if (i % 3 === 0) {
        const th = Math.random() * Math.PI;
        const ph = Math.random() * Math.PI * 2;
        v = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
      } else v = fib(i, N);
      v.multiplyScalar(1 + (Math.random() - 0.5) * 0.04);
      pos.set([v.x, v.y, v.z], i * 3);
      const s = randDir().multiplyScalar(3 + Math.random() * 6);
      scatter.set([s.x, s.y, s.z], i * 3);
      rand[i] = Math.random();
    }
    const shellGeo = new THREE.BufferGeometry();
    shellGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    shellGeo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
    shellGeo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
    this.shellMat = new THREE.ShaderMaterial({
      vertexShader: SHELL_VS,
      fragmentShader: SHELL_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.3 },
        uLevel: { value: 0 },
        uAssemble: { value: 0 },
        uSize: { value: mobile ? 19 : 15 },
        uPR: { value: pr },
        uTop: { value: this.cur.top },
        uBottom: { value: this.cur.bottom },
      },
    });
    this.spin.add(new THREE.Points(shellGeo, this.shellMat));

    // ---- radial spikes (audio reactive sunburst) ------------------------
    const S = 220;
    const sp = new Float32Array(S * 6);
    const sEnd = new Float32Array(S * 2);
    const sRand = new Float32Array(S * 2);
    for (let i = 0; i < S; i++) {
      const d = fib(i, S);
      sp.set([d.x, d.y, d.z, d.x, d.y, d.z], i * 6);
      sEnd.set([0, 1], i * 2);
      const r = Math.random();
      sRand.set([r, r], i * 2);
    }
    const spikeGeo = new THREE.BufferGeometry();
    spikeGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    spikeGeo.setAttribute("aEnd", new THREE.BufferAttribute(sEnd, 1));
    spikeGeo.setAttribute("aRand", new THREE.BufferAttribute(sRand, 1));
    this.spikeMat = new THREE.ShaderMaterial({
      vertexShader: SPIKE_VS,
      fragmentShader: SPIKE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uSpike: { value: 0.1 }, uLevel: { value: 0 }, uAssemble: { value: 0 }, uColor: { value: this.cur.accent } },
    });
    this.spin.add(new THREE.LineSegments(spikeGeo, this.spikeMat));

    // ---- plexus network inside the shell --------------------------------
    const P = 240;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < P; i++) pts.push(randDir().multiplyScalar(0.9));
    const seg: number[] = [];
    for (let i = 0; i < P; i++) {
      const near = pts
        .map((p, j) => ({ j, d: p.distanceTo(pts[i]) }))
        .filter((o) => o.j !== i && o.d < 0.36)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const o of near) if (o.j > i) seg.push(...pts[i].toArray(), ...pts[o.j].toArray());
    }
    const plexGeo = new THREE.BufferGeometry();
    plexGeo.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    this.plexus = new THREE.LineSegments(
      plexGeo,
      new THREE.LineBasicMaterial({ color: 0x8f7bff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.spin.add(this.plexus);
    const nodeGeo = new THREE.BufferGeometry().setFromPoints(pts);
    this.nodes = new THREE.Points(
      nodeGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.022, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.spin.add(this.nodes);

    // ---- geodesic core --------------------------------------------------
    this.geodesic = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.5, 1)),
      new THREE.LineBasicMaterial({ color: 0x5ee6ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.root.add(this.geodesic);

    // ---- glowing core ---------------------------------------------------
    const glow = glowTexture();
    this.core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xbff4ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.core.scale.setScalar(0.5);
    this.root.add(this.core);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x2a7dff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.halo.scale.setScalar(3.4);
    this.root.add(this.halo);

    // ---- orbital HUD rings ----------------------------------------------
    this.buildRings();

    // ---- ambient dust ---------------------------------------------------
    const D = lowPower ? 300 : 900;
    const dp = new Float32Array(D * 3);
    for (let i = 0; i < D; i++) dp.set(randDir().multiplyScalar(2.4 + Math.random() * 6).toArray(), i * 3);
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute("position", new THREE.BufferAttribute(dp, 3));
    this.dust = new THREE.Points(
      dGeo,
      new THREE.PointsMaterial({ color: 0x6fd9ff, size: 0.018, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scene.add(this.dust);

    this.bindPointer();
    this.resize();
    addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => {
      this.running = !document.hidden;
      if (this.running) {
        this.clock.getDelta();
        this.loop();
      }
    });
    this.loop();
  }

  private buildRings() {
    const accent = () => this.cur.accent;
    const defs = [
      { r: 1.32, tilt: [1.2, 0.2, 0], speed: 0.35, dash: true, text: true, arc: Math.PI * 1.35 },
      { r: 1.42, tilt: [1.45, -0.5, 0.3], speed: -0.22, dash: false, text: false, arc: Math.PI * 2 },
      { r: 1.24, tilt: [0.35, 0.9, 0], speed: 0.5, dash: true, text: true, arc: Math.PI * 0.9 },
      { r: 1.55, tilt: [1.6, 0.1, -0.2], speed: 0.12, dash: true, text: false, arc: Math.PI * 2 },
    ];
    defs.forEach((d, idx) => {
      const g = new THREE.Group();
      g.rotation.set(d.tilt[0], d.tilt[1], d.tilt[2]);
      const mats: THREE.Material[] = [];
      // thin line ring
      const pts: THREE.Vector3[] = [];
      const steps = 220;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * d.arc;
        pts.push(new THREE.Vector3(Math.cos(a) * d.r, 0, Math.sin(a) * d.r));
      }
      const lg = new THREE.BufferGeometry().setFromPoints(pts);
      const lm = d.dash
        ? new THREE.LineDashedMaterial({ color: accent(), dashSize: 0.05 + idx * 0.02, gapSize: 0.03, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
        : new THREE.LineBasicMaterial({ color: accent(), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(lg, lm);
      if (d.dash) line.computeLineDistances();
      g.add(line);
      mats.push(lm);
      // ticks
      const tk: number[] = [];
      const T = 72;
      for (let i = 0; i < T; i++) {
        const a = (i / T) * d.arc;
        const l = i % 6 === 0 ? 0.07 : 0.03;
        tk.push(Math.cos(a) * d.r, 0, Math.sin(a) * d.r, Math.cos(a) * (d.r + l), 0, Math.sin(a) * (d.r + l));
      }
      const tg = new THREE.BufferGeometry();
      tg.setAttribute("position", new THREE.Float32BufferAttribute(tk, 3));
      const tm = new THREE.LineBasicMaterial({ color: accent(), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
      g.add(new THREE.LineSegments(tg, tm));
      mats.push(tm);
      // data text band
      if (d.text) {
        const tex = dataTexture(idx * 97 + 13);
        tex.repeat.set(2, 1);
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(d.r + 0.05, d.r + 0.05, 0.05, 160, 1, true, 0, d.arc * 0.8),
          new THREE.MeshBasicMaterial({ map: tex, color: accent(), transparent: true, opacity: 0.75, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        band.rotation.y = Math.PI / 2;
        g.add(band);
        mats.push(band.material as THREE.Material);
      }
      this.root.add(g);
      this.rings.push({ obj: g, speed: d.speed, mats });
    });
  }

  private bindPointer() {
    const el = this.canvas;
    el.addEventListener("pointerdown", (e) => {
      this.drag = { active: true, x: e.clientX, y: e.clientY, vx: 0, vy: 0, moved: 0 };
    });
    addEventListener("pointermove", (e) => {
      if (!this.drag.active) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.vx = dx * 0.006;
      this.drag.vy = dy * 0.006;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.rot.y += dx * 0.006;
      this.rot.x = THREE.MathUtils.clamp(this.rot.x + dy * 0.006, -1.2, 1.2);
    });
    addEventListener("pointerup", (e) => {
      if (!this.drag.active) return;
      this.drag.active = false;
      if (this.drag.moved < 8 && this.hitTest(e.clientX, e.clientY)) this.onTap?.();
    });
  }

  private hitTest(x: number, y: number): boolean {
    if (this.layout !== "hero") return false;
    const v = this.root.position.clone().project(this.camera);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const sx = (v.x * 0.5 + 0.5) * w;
    const sy = (-v.y * 0.5 + 0.5) * h;
    const edge = this.root.position.clone().add(new THREE.Vector3(this.root.scale.x * 1.1, 0, 0)).project(this.camera);
    const rad = Math.abs((edge.x - v.x) * 0.5 * w);
    return Math.hypot(x - sx, y - sy) < rad;
  }

  private resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit the orb (incl. rings ~ diameter 3.3) into the hero area.
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const zW = 3.3 / (0.84 * 2 * t * this.camera.aspect);
    const zH = 3.3 / (0.44 * 2 * t);
    this.camera.position.z = Math.max(zW, zH, 5);
    this.camera.updateProjectionMatrix();
    this.applyLayout(true);
  }

  private viewSize() {
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const H = 2 * this.camera.position.z * t;
    return { H, W: H * this.camera.aspect };
  }

  private applyLayout(snap = false) {
    const { H, W } = this.viewSize();
    if (this.layout === "hero") {
      this.layoutPos.set(0, H * (0.5 - 0.3), 0);
      this.layoutScale = 1;
    } else {
      this.layoutPos.set(W * 0.5 - W * 0.17, H * 0.5 - H * 0.085, -1.5);
      this.layoutScale = 0.42;
    }
    if (snap) {
      this.root.position.copy(this.layoutPos);
      this.root.scale.setScalar(this.layoutScale);
    }
  }

  setMode(m: OrbMode) {
    this.mode = m;
  }

  setLayout(l: OrbLayout) {
    this.layout = l;
    this.applyLayout();
  }

  setLevelSource(fn: () => number) {
    this.levelSource = fn;
  }

  /** Particles fly in from the void and form the sphere. */
  assembleIn() {
    this.assembleTarget = 1;
  }

  private loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const target = LOOKS[this.mode];
    const k = 1 - Math.pow(0.02, dt); // smooth exponential easing

    this.cur.top.lerp(target.top, k);
    this.cur.bottom.lerp(target.bottom, k);
    this.cur.accent.lerp(target.accent, k);
    for (const key of ["amp", "spin", "ring", "spike", "core", "plexus"] as const) {
      this.cur[key] += (target[key] - this.cur[key]) * k;
    }
    this.assemble += (this.assembleTarget - this.assemble) * (1 - Math.pow(0.25, dt));
    const raw = this.levelSource();
    this.level += (raw - this.level) * (raw > this.level ? 0.5 : 0.12);

    // layout easing
    this.root.position.lerp(this.layoutPos, 1 - Math.pow(0.04, dt));
    const s = this.root.scale.x + (this.layoutScale - this.root.scale.x) * (1 - Math.pow(0.04, dt));
    this.root.scale.setScalar(s);

    // rotation: inertia + auto spin
    if (!this.drag.active) {
      this.drag.vx *= 0.94;
      this.drag.vy *= 0.94;
      this.rot.y += this.drag.vx + this.cur.spin * dt;
      this.rot.x = THREE.MathUtils.clamp(this.rot.x + this.drag.vy, -1.2, 1.2);
      this.rot.x += (0.25 - this.rot.x) * 0.01;
    }
    this.spin.rotation.set(this.rot.x, this.rot.y, 0);
    this.plexus.rotation.y = -t * 0.05;
    this.nodes.rotation.y = -t * 0.05;
    (this.plexus.material as THREE.LineBasicMaterial).opacity = this.cur.plexus * (0.7 + 0.3 * Math.sin(t * 2.0)) * this.assemble;
    (this.plexus.material as THREE.LineBasicMaterial).color.copy(this.cur.top).lerp(new THREE.Color(0x8f7bff), 0.5);
    (this.nodes.material as THREE.PointsMaterial).opacity = 0.8 * this.assemble;

    this.geodesic.rotation.set(t * 0.21, t * 0.33, 0);
    const gm = this.geodesic.material as THREE.LineBasicMaterial;
    gm.color.copy(this.cur.accent);
    gm.opacity = (0.22 + this.level * 0.4) * this.assemble;
    this.geodesic.scale.setScalar(0.9 + this.level * 0.25 + Math.sin(t * 1.3) * 0.02);

    const cs = (0.32 + this.cur.core * 0.28 + this.level * 0.45) * this.assemble;
    this.core.scale.setScalar(cs);
    (this.core.material as THREE.SpriteMaterial).color.copy(this.cur.top);
    const hm = this.halo.material as THREE.SpriteMaterial;
    hm.color.copy(this.cur.bottom);
    hm.opacity = (0.16 + this.level * 0.18) * this.assemble;

    this.rings.forEach((r, i) => {
      r.obj.rotateY(r.speed * this.cur.ring * dt * 1.6);
      const sc = 0.6 + 0.4 * this.assemble;
      r.obj.scale.setScalar(sc + (i % 2 ? 1 : -1) * this.level * 0.03);
      r.mats.forEach((m) => {
        (m as THREE.LineBasicMaterial).color?.copy(this.cur.accent);
        m.opacity = Math.min(1, (i === 1 ? 0.3 : 0.55) * this.assemble * (0.8 + this.level * 0.5));
      });
    });

    this.dust.rotation.y = t * 0.012;
    this.dust.rotation.x = Math.sin(t * 0.05) * 0.1;
    (this.dust.material as THREE.PointsMaterial).color.copy(this.cur.bottom).lerp(new THREE.Color(0xffffff), 0.3);

    const u = this.shellMat.uniforms;
    u.uTime.value = t;
    u.uAmp.value = this.cur.amp;
    u.uLevel.value = this.level;
    u.uAssemble.value = this.assemble;
    const su = this.spikeMat.uniforms;
    su.uTime.value = t;
    su.uSpike.value = this.cur.spike;
    su.uLevel.value = this.level;
    su.uAssemble.value = this.assemble;

    this.renderer.render(this.scene, this.camera);
  };
}
