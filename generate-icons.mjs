import { createWriteStream } from 'fs';
import { deflateSync } from 'zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

function makePNG(size) {
  const rows = [];
  const cx = size / 2, cy = size / 2;
  const outerR = size * 0.42;
  const innerR = size * 0.22;
  const starR = size * 0.14;

  // Colors
  const bg = [253, 251, 247];     // #FDFBF7
  const dark = [44, 44, 44];      // #2C2C2C
  const gold = [232, 168, 56];    // #E8A838

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Rounded rect background (dark circle icon)
      const rr = size * 0.22; // corner radius as fraction
      const inRect = (
        x >= rr && x <= size - rr && y >= 0 && y <= size
      ) || (
        y >= rr && y <= size - rr && x >= 0 && x <= size
      ) || (
        Math.sqrt(Math.pow(x - rr, 2) + Math.pow(y - rr, 2)) <= rr ||
        Math.sqrt(Math.pow(x - (size - rr), 2) + Math.pow(y - rr, 2)) <= rr ||
        Math.sqrt(Math.pow(x - rr, 2) + Math.pow(y - (size - rr), 2)) <= rr ||
        Math.sqrt(Math.pow(x - (size - rr), 2) + Math.pow(y - (size - rr), 2)) <= rr
      );

      let r, g, b;
      if (!inRect) {
        [r, g, b] = bg; // outside rounded rect → bg color
      } else {
        // Inside the icon rounded rect
        // Draw a ✦ star shape
        const angle = Math.atan2(dy, dx);
        const spikes = 4;
        const step = Math.PI / spikes;
        const a = ((angle % (2 * step)) + 2 * step) % (2 * step);
        const starEdge = a < step
          ? outerR * Math.cos(step / 2) / Math.cos(a - step / 2)
          : outerR * Math.cos(step / 2) / Math.cos(a - step * 1.5);

        // Simple 4-pointed star: check if inside star
        const normAngle = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
        const halfStep = Math.PI / 4;
        const distToCenter = dist;
        const starDist = distToCenter * Math.cos(normAngle - halfStep / 2) / Math.cos(Math.abs(normAngle - halfStep / 2) > halfStep / 2 ? normAngle - halfStep : normAngle - halfStep / 2);

        if (dist < innerR * 0.85) {
          [r, g, b] = gold;
        } else if (dist < innerR) {
          [r, g, b] = gold;
        } else {
          [r, g, b] = dark;
        }
      }
      row[1 + x * 3] = r;
      row[1 + x * 3 + 1] = g;
      row[1 + x * 3 + 2] = b;
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// Better design: simple colored rounded square with gold dot
function makeSimplePNG(size) {
  const rows = [];
  const rr = size * 0.22;

  const bg = [253, 251, 247];
  const dark = [44, 44, 44];
  const gold = [232, 168, 56];
  const goldLight = [245, 212, 139];

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      // Check if inside rounded rect
      const inCornerTL = x < rr && y < rr;
      const inCornerTR = x > size - rr && y < rr;
      const inCornerBL = x < rr && y > size - rr;
      const inCornerBR = x > size - rr && y > size - rr;

      let inRect = true;
      if (inCornerTL) inRect = Math.sqrt((x - rr) ** 2 + (y - rr) ** 2) <= rr;
      else if (inCornerTR) inRect = Math.sqrt((x - (size - rr)) ** 2 + (y - rr) ** 2) <= rr;
      else if (inCornerBL) inRect = Math.sqrt((x - rr) ** 2 + (y - (size - rr)) ** 2) <= rr;
      else if (inCornerBR) inRect = Math.sqrt((x - (size - rr)) ** 2 + (y - (size - rr)) ** 2) <= rr;

      let r, g, b;
      if (!inRect) {
        [r, g, b] = bg;
      } else {
        // Dark background inside
        const cx = size / 2, cy = size / 2;
        const dx = x - cx, dy = y - cy;

        // Draw 4-pointed star (✦) in the center
        // Star: in polar coords, r(θ) = inner + (outer-inner)*|cos(2θ)|^0.5
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        // 4-pointed star formula
        const outerR = size * 0.30;
        const innerR = size * 0.10;
        const numPoints = 4;
        const starRadius = innerR + (outerR - innerR) * Math.pow(Math.abs(Math.cos(numPoints * angle / 2)), 1);

        if (dist <= starRadius * 0.85) {
          [r, g, b] = gold;
        } else if (dist <= starRadius) {
          // Blend
          const t = (dist - starRadius * 0.85) / (starRadius * 0.15);
          r = Math.round(gold[0] * (1 - t) + dark[0] * t);
          g = Math.round(gold[1] * (1 - t) + dark[1] * t);
          b = Math.round(gold[2] * (1 - t) + dark[2] * t);
        } else {
          [r, g, b] = dark;
        }
      }
      row[1 + x * 3] = r;
      row[1 + x * 3 + 1] = g;
      row[1 + x * 3 + 2] = b;
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

import { writeFileSync } from 'fs';

writeFileSync('public/icon-192.png', makeSimplePNG(192));
writeFileSync('public/icon-512.png', makeSimplePNG(512));
writeFileSync('public/apple-touch-icon.png', makeSimplePNG(180));
console.log('Icons generated: icon-192.png, icon-512.png, apple-touch-icon.png');
