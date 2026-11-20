// Bake the smoke puff atlases (src/puffbake.js) and write them to assets/smoke/ as PNGs. Run after changing the bake:
//   node tools/bake-puffs.mjs [size per puff, default 256]
// No dependencies: a minimal PNG writer (RGBA, 8 bits, no filtering) on Node's zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { bakePuffData } from '../src/puffbake.js';

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
function png(rgba, W, H) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1); }   // row 0 (the bottom, for WebGL) first
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const N = parseInt(process.argv[2] || '256', 10), t0 = Date.now();
const { A, B, W, H } = bakePuffData(N);
const out = new URL('../assets/smoke/', import.meta.url);
writeFileSync(new URL('puffs-a.png', out), png(A, W, H)); writeFileSync(new URL('puffs-b.png', out), png(B, W, H));
console.log(`baked ${W}×${H} atlases (${N} px a puff) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
