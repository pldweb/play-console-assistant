/**
 * Generates the extension's PNG icons (a simple badge) without external
 * tools. Run: node scripts/generate-icons.mjs
 */
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Rounded square in teal with a white "play" triangle and a check notch.
function pixel(x, y, s) {
  const r = s * 0.2;
  const cx = Math.min(Math.max(x + 0.5, r), s - r);
  const cy = Math.min(Math.max(y + 0.5, r), s - r);
  const inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
  if (!inside) return [0, 0, 0, 0];
  const u = (x + 0.5) / s;
  const v = (y + 0.5) / s;
  const inTri = u > 0.34 && u < 0.74 && Math.abs(v - 0.5) < (0.74 - u) * 0.62;
  return inTri ? [255, 255, 255, 255] : [16, 110, 120, 255];
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png(size, pixel));
}
console.log('icons written');
