#!/usr/bin/env node
// Generates the PNG asset placeholders required by Homey:
//   - assets/images/{small,large,xlarge}.png       (75 / 500 / 1000)
//   - drivers/<id>/assets/images/{small,large,xlarge}.png  (75 / 500 / 500)
//   - widgets/<id>/{preview-light,preview-dark}.png        (1024x... per widget gallery)
//
// Uses zero deps: writes raw PNG bytes (IHDR + IDAT + IEND) by hand.
// Each image is a tinted radial gradient evoking the Jellyfin colour palette.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const BRAND_A = [0x00, 0xa4, 0xdc]; // jellyfin cyan
const BRAND_B = [0xaa, 0x5c, 0xc3]; // jellyfin purple
const DARK_BG = [0x16, 0x1d, 0x2e];
const LIGHT_BG = [0xf2, 0xf3, 0xf7];

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tagBuf = Buffer.from(tag, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tagBuf, data])), 0);
  return Buffer.concat([len, tagBuf, data, crc]);
}

function writePng(filePath, width, height, pixelFn) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter 'none'
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const off = y * (stride + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, png);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Tile icon: rounded square (faked via mask) with diagonal gradient + simple "play triangle".
function iconPixel(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.46;
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  // Round mask
  if (d > radius) return [0, 0, 0, 0];

  // Gradient by angle/position
  const t = (x + y) / (w + h);
  const base = mix(BRAND_B, BRAND_A, t);

  // Inner triangle "play"
  const tri = Math.min(w, h) * 0.18;
  const cxT = cx - tri * 0.2;
  // Triangle bounded by three edges (pointing right)
  const tx = x - cxT;
  const ty = y - cy;
  const inTri =
    tx > -tri * 0.7 &&
    tx < tri &&
    Math.abs(ty) < tri - tx * 0.55 &&
    Math.abs(ty) < tri;
  if (inTri && tx > -tri * 0.55 && tx < tri * 0.95) {
    return [255, 255, 255, 245];
  }

  // Subtle ring shadow at edge
  const edge = (radius - d) / radius;
  if (edge < 0.04) {
    const fade = Math.max(0, edge / 0.04);
    return [base[0] * fade, base[1] * fade, base[2] * fade, Math.round(255 * fade)];
  }

  return [base[0], base[1], base[2], 255];
}

// Widget preview: shows server card layout
function widgetPreview(theme) {
  const bg = theme === 'dark' ? DARK_BG : LIGHT_BG;
  const fg = theme === 'dark' ? [240, 244, 252] : [30, 35, 48];
  const muted = theme === 'dark' ? [120, 130, 150] : [130, 138, 158];
  const cardBg = theme === 'dark' ? [26, 34, 53] : [255, 255, 255];

  return (x, y, w, h) => {
    // Page background
    if (
      x < w * 0.04 ||
      x > w * 0.96 ||
      y < h * 0.06 ||
      y > h * 0.94
    ) {
      return [...bg, 255];
    }
    // Card rounded background
    const inset = (x - w * 0.04) / (w * 0.92);
    const tint = mix(BRAND_B, BRAND_A, inset);
    // Header strip
    if (y < h * 0.22) {
      return [tint[0], tint[1], tint[2], 255];
    }
    // Three stat tiles in middle band
    if (y > h * 0.28 && y < h * 0.55) {
      const cellWidth = (w * 0.92) / 4;
      const cellX = Math.floor((x - w * 0.04) / cellWidth);
      const inCell =
        (x - w * 0.04) % cellWidth > cellWidth * 0.08 &&
        (x - w * 0.04) % cellWidth < cellWidth * 0.92;
      if (inCell) {
        const valColor = cellX % 2 === 0 ? BRAND_A : BRAND_B;
        return [valColor[0], valColor[1], valColor[2], theme === 'dark' ? 230 : 200];
      }
      return [...cardBg, 255];
    }
    // Now playing row
    if (y > h * 0.62 && y < h * 0.86) {
      const localX = x - w * 0.06;
      if (localX < w * 0.12) {
        return [...mix(cardBg, BRAND_A, 0.4), 255];
      }
      if (localX < w * 0.7) {
        return [...fg, 200];
      }
      return [...muted, 200];
    }
    return [...cardBg, 255];
  };
}

const tasks = [
  // App-level icons
  { file: 'assets/images/small.png',  w: 250,  h: 175,  fn: iconPixel },
  { file: 'assets/images/large.png',  w: 500,  h: 350,  fn: iconPixel },
  { file: 'assets/images/xlarge.png', w: 1000, h: 700,  fn: iconPixel },
  // Drivers
  { file: 'drivers/server/assets/images/small.png',  w: 75,   h: 75,   fn: iconPixel },
  { file: 'drivers/server/assets/images/large.png',  w: 500,  h: 500,  fn: iconPixel },
  { file: 'drivers/server/assets/images/xlarge.png', w: 1000, h: 1000, fn: iconPixel },
  { file: 'drivers/client/assets/images/small.png',  w: 75,   h: 75,   fn: iconPixel },
  { file: 'drivers/client/assets/images/large.png',  w: 500,  h: 500,  fn: iconPixel },
  { file: 'drivers/client/assets/images/xlarge.png', w: 1000, h: 1000, fn: iconPixel },
  // Widget previews
  { file: 'widgets/server_overview/preview-light.png', w: 800, h: 280, fn: widgetPreview('light') },
  { file: 'widgets/server_overview/preview-dark.png',  w: 800, h: 280, fn: widgetPreview('dark') },
  { file: 'widgets/now_playing/preview-light.png',     w: 800, h: 200, fn: widgetPreview('light') },
  { file: 'widgets/now_playing/preview-dark.png',      w: 800, h: 200, fn: widgetPreview('dark') },
];

for (const t of tasks) {
  writePng(path.join(root, t.file), t.w, t.h, t.fn);
  console.log('wrote', t.file);
}
console.log('Done.');
