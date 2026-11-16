/* EXSALA HERMES MOD · powered by Gienetic */
// THE BREACH — procedural flat-vector illustration, deterministic PNG writer.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ───────────────────────────── canvas ─────────────────────────────
const SS = 2;                      // supersample factor
const W = 1024, H = 1024;          // final
const RW = W * SS, RH = H * SS;    // render

const buf = new Float32Array(RW * RH * 3); // linear-ish 0..255 rgb

const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

type RGB = [number, number, number];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mixc = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ───────────────────────────── PRNG ─────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x5eadbeef);

// ───────────────────────────── low-level paint ─────────────────────────────
function px(x: number, y: number, c: RGB, a: number) {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= RW || y >= RH) return;
  const i = ((y | 0) * RW + (x | 0)) * 3;
  if (a >= 1) {
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    return;
  }
  buf[i] += (c[0] - buf[i]) * a;
  buf[i + 1] += (c[1] - buf[i + 1]) * a;
  buf[i + 2] += (c[2] - buf[i + 2]) * a;
}

function paintRegion(
  x0: number, y0: number, x1: number, y1: number,
  fn: (x: number, y: number) => RGB | null
) {
  const ax = Math.max(0, Math.floor(x0)), bx = Math.min(RW - 1, Math.ceil(x1));
  const ay = Math.max(0, Math.floor(y0)), by = Math.min(RH - 1, Math.ceil(y1));
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      const c = fn(x + 0.5, y + 0.5);
      if (c) { const i = (y * RW + x) * 3; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; }
    }
  }
}

function blendRegion(
  x0: number, y0: number, x1: number, y1: number,
  fn: (x: number, y: number) => { c: RGB; a: number } | null
) {
  const ax = Math.max(0, Math.floor(x0)), bx = Math.min(RW - 1, Math.ceil(x1));
  const ay = Math.max(0, Math.floor(y0)), by = Math.min(RH - 1, Math.ceil(y1));
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      const r = fn(x + 0.5, y + 0.5);
      if (r) px(x, y, r.c, r.a);
    }
  }
}

// soft disc: alpha = falloff(d/R)
function softDisc(cx: number, cy: number, r: number, soft: number, c: RGB, a0: number) {
  blendRegion(cx - r - soft, cy - r - soft, cx + r + soft, cy + r + soft, (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    if (d > r + soft) return null;
    let a = d <= r ? 1 : 1 - (d - r) / soft;
    a = smooth(clamp(a));
    return { c, a: a * a0 };
  });
}

// ───────────────────────────── geometry helpers ─────────────────────────────
type P = [number, number];

function catmullRom(pts: P[], seg = 24, closed = false): P[] {
  const out: P[] = [];
  const n = pts.length;
  const g = (i: number): P => closed ? pts[((i % n) + n) % n] : pts[Math.min(n - 1, Math.max(0, i))];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    for (let s = 0; s < seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// scanline fill of a polygon (nonzero winding off — even-odd)
function fillPoly(poly: P[], c: RGB, a = 1, aa = true) {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of poly) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
  }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(RH - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const A = poly[i], B = poly[(i + 1) % n];
      if ((A[1] <= sy && B[1] > sy) || (B[1] <= sy && A[1] > sy)) {
        xs.push(A[0] + ((sy - A[1]) / (B[1] - A[1])) * (B[0] - A[0]));
      }
    }
    if (!xs.length) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let xa = xs[k], xb = xs[k + 1];
      if (aa) {
        // fractional coverage at edges
        const ia = Math.ceil(xa - 0.5), ib = Math.floor(xb - 0.5);
        for (let x = ia; x <= ib; x++) px(x, y, c, a);
        // left/right partial
        const la = ia - 0.5, rb = ib + 0.5;
        if (xa < la) { /* nothing */ }
        const covA = clamp(ia - xa + 0.5);
        if (covA > 0 && covA < 1) px(ia - 1, y, c, a * covA);
        const covB = clamp(xb - ib - 0.5);
        if (covB > 0 && covB < 1) px(ib + 1, y, c, a * covB);
      } else {
        for (let x = Math.ceil(xa - 0.5); x <= Math.floor(xb - 0.5); x++) px(x, y, c, a);
      }
    }
  }
}

function strokePoly(poly: P[], width: number, c: RGB, a: number, taperTo = 0) {
  const n = poly.length;
  for (let i = 0; i < n - 1; i++) {
    const A = poly[i], B = poly[i + 1];
    const t = i / (n - 1);
    const w = taperTo > 0 ? lerp(width, taperTo, t * t) : width;
    const r = w / 2;
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    const steps = Math.max(1, Math.ceil(len));
    for (let s = 0; s <= steps; s++) {
      const x = A[0] + (dx * s) / steps, y = A[1] + (dy * s) / steps;
      // soft dot
      const rr = Math.max(0.6, r);
      blendRegion(x - rr - 1, y - rr - 1, x + rr + 1, y + rr + 1, (qx, qy) => {
        const d = Math.hypot(qx - x, qy - y);
        if (d > rr + 0.9) return null;
        const aa2 = d <= rr - 0.5 ? 1 : clamp(rr + 0.5 - d);
        return { c, a: a * aa2 };
      });
    }
  }
}

// ───────────────────────────── 0. BACKGROUND / SKY + SEA (continuous) ─────────────────────────────
// One continuous vertical gradient across the whole canvas so no row jumps at the horizon.
const HORIZON = 0.60;

const skyStops: { y: number; c: RGB }[] = [
  { y: 0.00, c: hex('#060923') },
  { y: 0.14, c: hex('#0a1240') },  // deep indigo
  { y: 0.28, c: hex('#123a5e') },
  { y: 0.40, c: hex('#1d5a70') },
  { y: 0.485, c: hex('#4b6f7a') },
  { y: 0.545, c: hex('#a97a72') },
  { y: 0.578, c: hex('#e8906f') },
  { y: 0.600, c: hex('#f7b267') },
];

const seaStops: { y: number; c: RGB }[] = [
  { y: 0.6000, c: hex('#f7b267') },  // exactly the sky's last stop => zero seam
  { y: 0.6050, c: hex('#f0ab68') },
  { y: 0.6120, c: hex('#dc9b60') },
  { y: 0.6210, c: hex('#bc855c') },
  { y: 0.6320, c: hex('#8e7059') },
  { y: 0.6460, c: hex('#5c6258') },
  { y: 0.6620, c: hex('#2f5155') },
  { y: 0.6820, c: hex('#144350') },
  { y: 0.7100, c: hex('#0a3a4d') },
  { y: 0.8200, c: hex('#072a3a') },
  { y: 0.9200, c: hex('#051d2a') },
  { y: 1.0000, c: hex('#04141f') },
];

function gradColor(stops: { y: number; c: RGB }[], t: number): RGB {
  if (t <= stops[0].y) return stops[0].c;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t >= a.y && t <= b.y) {
      const u = (t - a.y) / (b.y - a.y);
      return mixc(a.c, b.c, smooth(u));
    }
  }
  return stops[stops.length - 1].c;
}

for (let y = 0; y < RH; y++) {
  const t = (y + 0.5) / RH;
  const base = t < HORIZON ? gradColor(skyStops, t) : gradColor(seaStops, t);
  for (let x = 0; x < RW; x++) {
    const i = (y * RW + x) * 3;
    buf[i] = base[0]; buf[i + 1] = base[1]; buf[i + 2] = base[2];
  }
}

// horizon glow band (soft, warm) — sits ON the waterline, blends both ways
blendRegion(0, RH * (HORIZON - 0.080), RW, RH * (HORIZON + 0.070), (_x, y) => {
  const t = (y + 0.5) / RH;
  const span = t < HORIZON ? 0.080 : 0.070;
  const d = Math.abs(t - HORIZON) / span;
  if (d >= 1) return null;
  const a = (1 - d) * (1 - d) * 0.22;
  return { c: hex('#ffcf9b'), a };
});

// glinting distant ripples straddling the waterline — kills any straight-edge read
{
  const hr = mulberry32(0x2b2b2b2b);
  for (let i = 0; i < 150; i++) {
    const y = RH * HORIZON + (hr() - 0.34) * 0.036 * RH;
    const x = hr() * RW;
    const len = (9 + hr() * 52) * SS;
    const a = 0.10 + hr() * 0.20;
    const th = (0.8 + hr() * 1.2) * SS;
    const n = Math.max(1, Math.round(len / (1.2 * SS)));
    for (let s = 0; s <= n; s++) {
      const xx = x - len / 2 + (len * s) / n;
      const taper = Math.max(0.25, 1 - Math.abs(s / n - 0.5) * 1.6);
      softDisc(xx, y, th * 0.45 * taper, th * 1.0, hex('#ffe3ba'), a * 0.55 * taper);
    }
  }
}

// ───────────────────────────── 1. STARS ─────────────────────────────
const starRnd = mulberry32(0x1a2b3c4d);
const STARS = 420;
for (let i = 0; i < STARS; i++) {
  const x = starRnd() * RW;
  // bias upward: sky only, thin out near horizon glow
  let v = Math.pow(starRnd(), 1.35);
  const y = v * RH * (HORIZON - 0.012);
  const hn = clamp(1 - y / (RH * HORIZON));
  if (starRnd() > 0.15 + hn * 0.85) continue;
  const r = (0.5 + starRnd() * 1.3) * SS;
  const base = starRnd();
  const pale = hex('#dfe9ff'), cyan = hex('#bfe8ff');
  const c = mixc(pale, cyan, starRnd());
  const a = (0.18 + Math.pow(starRnd(), 1.6) * 0.82) * (0.35 + hn * 0.65);
  softDisc(x, y, r * 0.45, r * 1.5, c, a);
}

// shooting stars — upper-left quadrant, tapering trails
function shootingStar(x0: number, y0: number, x1: number, y1: number, wd: number) {
  const pts: P[] = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push([lerp(x0, x1, t), lerp(y0, y1, t) - Math.sin(t * Math.PI) * 6]);
  }
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const a = (1 - t) * 0.52;
    const A = pts[i], B = pts[i + 1];
    strokePoly([A, B], lerp(wd, 0.6, t * t), hex('#eaf4ff'), a);
  }
  // bright head
  softDisc(x0, y0, 1.7 * SS, 3.0 * SS, hex('#ffffff'), 0.85);
  softDisc(x0, y0, 3.6 * SS, 6 * SS, hex('#cfe6ff'), 0.20);
}
shootingStar(0.075 * RW, 0.055 * RH, 0.275 * RW, 0.145 * RH, 2.4 * SS);
shootingStar(0.13 * RW, 0.20 * RH, 0.30 * RW, 0.245 * RH, 1.7 * SS);

// ───────────────────────────── 2. MOON (sky only) ─────────────────────────────
const MX = 0.68 * RW, MY = 0.29 * RH, MR = 0.155 * W * SS;
const moonClipY = RH * HORIZON;

// halo — clipped above horizon
blendRegion(MX - MR * 2.6, MY - MR * 2.6, MX + MR * 2.6, Math.min(moonClipY, MY + MR * 2.6), (x, y) => {
  if (y > moonClipY) return null;
  const d = Math.hypot(x - MX, y - MY);
  const outer = MR + 0.10 * W * SS * 2.2;
  if (d > outer) return null;
  let a: number;
  if (d <= MR) a = 0;
  else {
    const u = clamp((d - MR) / (outer - MR));
    a = Math.pow(1 - u, 2.4) * 0.36;
  }
  return { c: hex('#ffdfae'), a };
});

// disc with mottling, clipped above horizon
blendRegion(MX - MR - 2, MY - MR - 2, MX + MR + 2, Math.min(MY + MR + 2, moonClipY), (x, y) => {
  if (y > moonClipY) return null;
  const d = Math.hypot(x - MX, y - MY);
  if (d > MR + 1) return null;
  const aa2 = d <= MR - 0.8 ? 1 : clamp(MR + 0.8 - d);
  return { c: hex('#ffe9c4'), a: aa2 };
});

// mottling: a few large, very soft, low-alpha darker circles
const motRnd = mulberry32(0x77aa33);
for (let i = 0; i < 7; i++) {
  const ang = motRnd() * Math.PI * 2;
  const rad = Math.sqrt(motRnd()) * MR * 0.68;
  const cx = MX + Math.cos(ang) * rad, cy = MY + Math.sin(ang) * rad * 0.95;
  const r = MR * (0.16 + motRnd() * 0.24);
  blendRegion(cx - r * 1.6, cy - r * 1.6, cx + r * 1.6, Math.min(cy + r * 1.6, moonClipY), (x, y) => {
    if (y > moonClipY) return null;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r * 1.6) return null;
    // only inside moon
    if (Math.hypot(x - MX, y - MY) > MR - 1) return null;
    const u = clamp(d / (r * 1.6));
    return { c: hex('#e8cda2'), a: Math.pow(1 - u, 1.5) * 0.13 };
  });
}

// ───────────────────────────── 3. OCEAN DETAIL ─────────────────────────────
// long low-alpha sine wave bands
{
  const wr = mulberry32(0x31415926);
  const bands = 16;
  for (let b = 0; b < bands; b++) {
    const yy = (HORIZON + 0.012 + Math.pow(wr(), 0.62) * 0.375) * RH;
    const amp = (1.6 + wr() * 5.5) * SS;
    const fr = (0.6 + wr() * 2.4) * 0.0016 * (SS / 2);
    const ph = wr() * 6.283;
    const a = 0.035 + wr() * 0.075;
    const w = (0.8 + wr() * 1.9) * SS;
    const c = b % 3 === 0 ? hex('#9fd2d8') : hex('#3d7f8e');
    for (let x = 0; x < RW; x += 1) {
      const y = yy + Math.sin(x * fr + ph) * amp;
      const fade = clamp((x / RW) * 6) * clamp((1 - x / RW) * 6);
      softDisc(x, y, w * 0.5, w * 0.9, c, a * fade);
    }
  }
}

// moon glitter column — short warm dashes only (no disc!)
{
  const gr = mulberry32(0x0b10c0de);
  const cx = MX;
  const spanW = 0.07 * W * SS;
  const rows = 420;
  for (let i = 0; i < rows; i++) {
    const t = Math.pow(gr(), 0.78);                       // denser near horizon
    const y = moonClipY + t * (RH - moonClipY) * 0.92;
    const depth = t;
    // column narrows a little with depth, and spreads slightly
    const w = spanW * lerp(1.05, 0.85, depth);
    const spread = (gr() - 0.5) * 2;
    const x = cx + spread * w;
    // horizontal distance from moon column centre → fade at edges
    const edge = 1 - Math.abs(spread);
    const len = (2 + gr() * 22) * SS * lerp(1.0, 0.55, depth);
    const a = (0.10 + gr() * 0.55) * Math.pow(edge, 1.6) * lerp(1.0, 0.55, depth);
    const c = gr() > 0.55 ? hex('#ffd9a0') : hex('#ffe8c6');
    const th = (0.9 + gr() * 1.5) * SS * lerp(1, 0.7, depth);
    const yb = y + Math.sin(x * 0.02) * 1.2 * SS;
    softDisc(x, yb, th * 0.5, th * 1.5, c, a);
    // draw as a short dash by laying soft discs along x
    const steps = Math.max(1, Math.round(len / (1.1 * SS)));
    for (let s = 0; s <= steps; s++) {
      const xx = x - len / 2 + (len * s) / steps;
      const taper = 1 - Math.abs(s / steps - 0.5) * 1.4;
      softDisc(xx, yb, th * 0.42 * Math.max(0.25, taper), th * 1.1, c, a * 0.42);
    }
  }
}

// ───────────────────────────── 4. WHALE ─────────────────────────────
const N = (x: number, y: number): P => [x * RW, y * RH];

const bodyPts: P[] = [
  N(0.295, 0.665), // tail stock
  N(0.360, 0.520),
  N(0.455, 0.400),
  N(0.545, 0.325),
  N(0.625, 0.285), // head top
  N(0.665, 0.315), // nose tip
  N(0.630, 0.360), // jaw
  N(0.545, 0.440), // throat
  N(0.460, 0.545), // belly
  N(0.375, 0.630), // underside
];

const bodyCurve = catmullRom(bodyPts, 26, true);
const WHALE = hex('#0a1c33');

// tail fluke: two smooth lobes from the tail stock
const flukeUp: P[] = catmullRom([
  N(0.295, 0.665),
  N(0.262, 0.632),
  N(0.205, 0.596),
  N(0.148, 0.575),
  N(0.128, 0.588),
  N(0.176, 0.634),
  N(0.243, 0.672),
  N(0.295, 0.665),
], 22, false);
const flukeDown: P[] = catmullRom([
  N(0.295, 0.665),
  N(0.258, 0.700),
  N(0.196, 0.736),
  N(0.140, 0.756),
  N(0.126, 0.744),
  N(0.180, 0.706),
  N(0.246, 0.674),
  N(0.295, 0.665),
], 22, false);

// pectoral fin from belly, angled down-left
const fin: P[] = catmullRom([
  N(0.505, 0.497),
  N(0.487, 0.552),
  N(0.446, 0.628),
  N(0.392, 0.690),
  N(0.352, 0.700),
  N(0.372, 0.648),
  N(0.410, 0.578),
  N(0.462, 0.512),
  N(0.505, 0.497),
], 20, false);

fillPoly(flukeUp, WHALE, 1);
fillPoly(flukeDown, WHALE, 1);
fillPoly(fin, WHALE, 1);

// body with a subtle vertical shading so it reads as volume
{
  let minY = Infinity, maxY = -Infinity;
  for (const p of bodyCurve) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  fillPoly(bodyCurve, WHALE, 1);
  // gentle lighter belly tone
  const belly = hex('#123050');
  blendRegion(0.30 * RW, 0.33 * RH, 0.68 * RW, 0.70 * RH, (x, y) => {
    // inside test
    const inPoly = pointInPoly(bodyCurve, x, y);
    if (!inPoly) return null;
    const t = clamp((x / RW - 0.34) / 0.32);
    const t2 = clamp((y / RH - 0.30) / 0.34);
    const a = 0.20 * smooth(t) * smooth(t2) * 0.55;
    return { c: belly, a };
  });
}

function pointInPoly(poly: P[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// mouth slit + ventral pleats: the details that make it a whale at 300px
{
  const mouth = catmullRom([N(0.664, 0.317), N(0.652, 0.337), N(0.634, 0.353), N(0.611, 0.363)], 22, false);
  strokePoly(mouth, 1.3 * SS, hex('#1d4266'), 0.85);
  const pleats: P[][] = [
    [N(0.622, 0.372), N(0.572, 0.400), N(0.518, 0.445), N(0.472, 0.495)],
    [N(0.616, 0.386), N(0.564, 0.418), N(0.508, 0.466), N(0.462, 0.518)],
    [N(0.608, 0.400), N(0.556, 0.436), N(0.500, 0.486), N(0.454, 0.534)],
  ];
  for (const pl of pleats) strokePoly(catmullRom(pl, 18, false), 0.9 * SS, hex('#17395c'), 0.55);
  // leading edge of the flipper catches moonlight so it separates from the belly
  const lead = catmullRom([N(0.507, 0.497), N(0.489, 0.553), N(0.448, 0.629), N(0.393, 0.691), N(0.353, 0.700)], 22, false);
  strokePoly(lead, 1.7 * SS, hex('#cfe8ff'), 0.30);
}

// moonlit rim: stroke the BACK edge only, continuous
{
  const back = catmullRom([bodyPts[0], bodyPts[1], bodyPts[2], bodyPts[3], bodyPts[4], bodyPts[5]], 40, false);
  // draw an outer-glow pass then a crisp pass
  strokePoly(back, 7.0 * SS, hex('#9ec6e8'), 0.22);
  strokePoly(back, 3.0 * SS, hex('#cfe8ff'), 0.80);
  // fluke + fin rims, subtler
  const fl = catmullRom([N(0.295, 0.665), N(0.205, 0.596), N(0.148, 0.575), N(0.128, 0.588)], 30, false);
  strokePoly(fl, 2.0 * SS, hex('#cfe8ff'), 0.55);
}

// eye glint
softDisc(0.615 * RW, 0.335 * RH, 1.2 * SS, 1.8 * SS, hex('#eaf6ff'), 0.9);

// ───────────────────────────── 5. SPLASH ─────────────────────────────
const TX = 0.295 * RW, TY = 0.665 * RH;

// foam ring ellipse at the waterline
blendRegion(TX - 0.10 * RW, TY - 0.028 * RH, TX + 0.11 * RW, TY + 0.030 * RH, (x, y) => {
  const ex = (x - TX) / (0.088 * RW);
  const ey = (y - TY) / (0.0165 * RH);
  const d = Math.hypot(ex, ey);
  if (d > 1.5) return null;
  if (d > 1) return { c: hex('#dff6ff'), a: Math.pow(1 - (d - 1) / 0.5, 2) * 0.28 };
  return { c: hex('#eafcff'), a: 0.55 * (1 - Math.pow(d, 3) * 0.9) };
});

// crown splash: fanning droplet streaks
{
  const sr = mulberry32(0x5150a5);
  const count = 14;
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    // fan from about -170° to -10° (upward / outward)
    const ang = (-Math.PI * 0.96) + u * Math.PI * 0.92 + (sr() - 0.5) * 0.16;
    const len = (0.045 + sr() * 0.085) * RH * (0.55 + Math.sin(u * Math.PI) * 0.75);
    const x0 = TX + (sr() - 0.5) * 0.020 * RW;
    const y0 = TY + (sr() - 0.5) * 0.008 * RH;
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 + Math.sin(ang) * len;
    const a = 0.55 + sr() * 0.40;
    const w = (1.6 + sr() * 2.2) * SS;
    // tapered streak
    const steps = 14;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const xx = lerp(x0, x1, t);
      const yy = lerp(y0, y1, t) - Math.sin(t * Math.PI) * 3 * SS;
      const ww = lerp(w, 0.7, t * t);
      softDisc(xx, yy, ww * 0.5, ww * 0.9, hex('#dff6ff'), a * (1 - t * 0.75));
    }
    // droplet head
    softDisc(x1, y1 - 0.5 * SS, (1.5 + sr() * 1.4) * SS, 1.6 * SS, hex('#f2fbff'), a * 0.85);
  }
}

// spray arc trailing the body's rise
{
  const ar = mulberry32(0xc0ffee);
  for (let i = 0; i < 90; i++) {
    const t = Math.pow(ar(), 0.85);
    // curve from tail toward mid-body, offset outward/up
    const bx = lerp(0.295, 0.455, t) * RW;
    const by = lerp(0.665, 0.400, t) * RH;
    const off = (ar() - 0.5) * 2;
    const x = bx + off * (0.030 + 0.030 * t) * RW;
    const y = by - (0.012 + ar() * 0.055) * RH * (1 - t * 0.5) + Math.abs(off) * 0.012 * RH;
    const a = (0.20 + ar() * 0.55) * (1 - t * 0.55);
    const r = (0.7 + ar() * 1.7) * SS;
    softDisc(x, y, r * 0.5, r * 1.1, hex('#dff6ff'), a);
  }
}

// ───────────────────────────── 6. PAPER PLANE + TRAIL ─────────────────────────────
const PPX = 0.155 * RW, PPY = 0.165 * RH;
const planeScale = 0.030 * RW;

// dotted loop-de-loop trail: loops once then heads toward the whale
{
  const tr = mulberry32(0x9e3779b9);
  const pts: P[] = [];
  const loopCx = PPX - planeScale * 2.6, loopCy = PPY + planeScale * 2.6;
  const loopR = planeScale * 1.9;
  const SEG = 260;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    if (t < 0.62) {
      // loop
      const u = t / 0.62;
      const a = -Math.PI * 0.35 + u * Math.PI * 2;
      pts.push([loopCx + Math.cos(a) * loopR, loopCy + Math.sin(a) * loopR * 0.88]);
    } else {
      // straight-ish run toward the whale
      const u = (t - 0.62) / 0.38;
      const sx = loopCx + Math.cos(-Math.PI * 0.35 + Math.PI * 2) * loopR;
      const sy = loopCy + Math.sin(-Math.PI * 0.35 + Math.PI * 2) * loopR * 0.88;
      const ex = PPX - planeScale * 1.2, ey = PPY + planeScale * 0.55;
      pts.push([lerp(sx, ex, u) + Math.sin(u * 3.1) * planeScale * 0.18, lerp(sy, ey, u)]);
    }
  }
  const SPACING = 8.5 * SS;
  let carry = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    carry += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    if (carry >= SPACING) {
      carry = 0;
      const t = i / pts.length;
      const a = 0.70 * (0.30 + t * 0.80);
      const r = (1.0 + tr() * 0.8) * SS * (0.72 + t * 0.5);
      softDisc(cur[0], cur[1], r * 0.5, r * 0.95, hex('#bfe3ff'), a);
    }
    prev = cur;
  }
}

// the paper plane: two clean triangles, tilted up-right
{
  // local coords, nose at +x, tilted
  const ang = -Math.PI * 0.20;
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const T = (x: number, y: number): P => [
    PPX + (x * cs - y * sn) * planeScale,
    PPY + (x * sn + y * cs) * planeScale,
  ];
  const nose: P = [1.15, 0.0];
  const topWing: P = [-0.75, -0.62];
  const botWing: P = [-0.62, 0.42];
  const tailNotch: P = [-0.28, -0.02];

  const tri1 = [T(...nose), T(...topWing), T(...tailNotch)];
  const tri2 = [T(...nose), T(...tailNotch), T(...botWing)];
  fillPoly(tri1, hex('#ff5a4e'), 1);
  fillPoly(tri2, hex('#d63b32'), 1);
  // crisp edge highlight on the lit wing
  strokePoly([T(...nose), T(...topWing)], 1.1 * SS, hex('#ffb0a6'), 0.55);
}

// ───────────────────────────── 7. FOREGROUND WAVE CURL ─────────────────────────────
{
  // rising from bottom-left, below ~12% of frame height
  const curl: P[] = catmullRom([
    N(-0.03, 1.03),
    N(-0.02, 0.975),
    N(0.005, 0.936),
    N(0.045, 0.906),
    N(0.100, 0.889),
    N(0.158, 0.884),
    N(0.208, 0.893),
    N(0.240, 0.911),
    N(0.254, 0.931),
    N(0.238, 0.946),
    N(0.206, 0.949),
    N(0.176, 0.961),
    N(0.146, 0.980),
    N(0.118, 1.005),
    N(0.100, 1.03),
  ], 26, false);
  fillPoly(curl, hex('#06283a'), 1);
  // foam-dotted crest edge
  const crest = catmullRom([N(-0.02, 0.975), N(0.045, 0.906), N(0.100, 0.889), N(0.158, 0.884), N(0.240, 0.911), N(0.254, 0.931)], 30, false);
  strokePoly(crest, 1.4 * SS, hex('#8fc9de'), 0.34);
  const fr = mulberry32(0xf00d);
  for (let i = 0; i < 18; i++) {
    const idx = Math.floor(fr() * (crest.length - 1));
    const p = crest[idx];
    const r = (0.7 + fr() * 1.4) * SS;
    softDisc(p[0] + (fr() - 0.5) * 4 * SS, p[1] + (fr() - 0.5) * 4 * SS, r * 0.5, r * 0.9, hex('#d8f2fb'), 0.25 + fr() * 0.35);
  }
}

// ───────────────────────────── 8. VIGNETTE + GRADE ─────────────────────────────
{
  const cx = RW * 0.5, cy = RH * 0.46;
  const maxd = Math.hypot(RW * 0.5, RH * 0.54);
  blendRegion(0, 0, RW, RH, (x, y) => {
    const d = Math.hypot(x - cx, y - cy) / maxd;
    const a = clamp((d - 0.62) / 0.55);
    if (a <= 0) return null;
    return { c: hex('#02040f'), a: Math.pow(a, 1.7) * 0.34 };
  });
}

// ───────────────────────────── 9. DOWNSAMPLE 2x + PNG ─────────────────────────────
const out = Buffer.alloc(W * H * 3);
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) {
      const row = ((y * SS + sy) * RW + x * SS) * 3;
      for (let sx = 0; sx < SS; sx++) {
        const i = row + sx * 3;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      }
    }
    const n = SS * SS;
    const o = (y * W + x) * 3;
    const dz = (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.47);   // deterministic ordered dither
    out[o] = Math.round(clamp(r / n + dz, 0, 255));
    out[o + 1] = Math.round(clamp(g / n + dz, 0, 255));
    out[o + 2] = Math.round(clamp(b / n + dz, 0, 255));
  }
}

// dither-free gentle contrast/saturation lift
for (let i = 0; i < out.length; i += 3) {
  const r = out[i], g = out[i + 1], b = out[i + 2];
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  out[i] = Math.round(clamp(l + (r - l) * 1.10, 0, 255));
  out[i + 1] = Math.round(clamp(l + (g - l) * 1.10, 0, 255));
  out[i + 2] = Math.round(clamp(l + (b - l) * 1.10, 0, 255));
}

// ── PNG encoder ──
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Buffer, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const o = y * (1 + W * 3);
  raw[o] = 0;
  out.copy(raw, o + 1, y * W * 3, (y + 1) * W * 3);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // color type RGB
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'entry.png'), png);
console.log(`wrote ${join(dir, 'entry.png')} ${png.length} bytes`);
