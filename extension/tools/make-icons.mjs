// Zero-dependency icon generator: node extension/tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const segDist = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const clamp = (v) => Math.max(0, Math.min(1, v));

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [14, 16, 19], fg = [242, 112, 58];
  const SS = 4; // supersampling
  const R = 0.42, ring = Math.max(0.07, 1.6 / size) ; // ring radius and half-width in unit coords
  const m = [[0.3, 0.68], [0.3, 0.32], [0.5, 0.56], [0.7, 0.32], [0.7, 0.68]];
  const mw = Math.max(0.05, 1.3 / size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cov = 0, inside = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      // rounded square background
      const rx = Math.abs(u - 0.5) - 0.5 + 0.2, ry = Math.abs(v - 0.5) - 0.5 + 0.2;
      if (Math.hypot(Math.max(rx, 0), Math.max(ry, 0)) + Math.min(Math.max(rx, ry), 0) > 0.2) continue;
      inside++;
      const d = Math.hypot(u - 0.5, v - 0.5);
      let on = Math.abs(d - R) <= ring;
      if (!on) for (let i = 0; i < m.length - 1; i++) if (segDist(u, v, ...m[i], ...m[i + 1]) <= mw) { on = true; break; }
      if (on) cov++;
    }
    const total = SS * SS, a = inside / total, f = inside ? cov / inside : 0;
    const o = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(bg[c] + (fg[c] - bg[c]) * clamp(f));
    px[o + 3] = Math.round(255 * a);
  }
  return px;
}
for (const s of [16, 32, 48, 128]) writeFileSync(join(out, `icon${s}.png`), png(s, render(s)));
console.log("icons written to", out);
