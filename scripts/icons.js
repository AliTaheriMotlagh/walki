'use strict';

// Renders the walki app icon (signal dot + radio waves) to PNG with no
// dependencies, so home-screen icons look crisp on iOS and Android.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const BG = [255, 90, 31];
const FG = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Signed distance (in px) to an arc stroke with round caps.
function arcDistance(x, y, r, half, width) {
  const ang = Math.atan2(y, x);
  if (Math.abs(ang) <= half) return Math.abs(Math.hypot(x, y) - r) - width / 2;
  const ex = r * Math.cos(half);
  const ey = r * Math.sin(half) * Math.sign(y || 1);
  return Math.hypot(x - ex, y - ey) - width / 2;
}

function shape(x, y, s) {
  const dot = Math.hypot(x, y) - 0.095 * s;
  const w = 0.05 * s;
  const half = (42 * Math.PI) / 180;
  let d = dot;
  for (const r of [0.2 * s, 0.305 * s]) {
    d = Math.min(d, arcDistance(x, y, r, half, w), arcDistance(-x, y, r, half, w));
  }
  return d;
}

function render(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const c = size / 2;
  const SS = 4; // supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS - c;
          const y = py + (sy + 0.5) / SS - c;
          if (shape(x, y, size) <= 0) cover++;
        }
      const a = cover / (SS * SS);
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] * (1 - a) + FG[i] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log('wrote', name);
}
