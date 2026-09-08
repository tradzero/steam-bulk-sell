import {readFile, writeFile, mkdir, copyFile, readdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
await mkdir(dist, {recursive: true});
for (const name of await readdir(resolve(root, 'static'))) await copyFile(resolve(root, 'static', name), resolve(dist, name));
function crc32(b) { let crc = 0xffffffff; for (const x of b) { crc ^= x; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), n = Buffer.alloc(4), crc = Buffer.alloc(4); n.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, crc]); }
function icon(size) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = x / size, b = y / size; let color = [27, 40, 56, 255];
    const stripe = [[.28, .38], [.45, .55], [.62, .72]].some(([low, high]) => b >= low && b <= high);
    if (a >= .23 && a <= .77 && stripe) color = [102, 192, 244, 255];
    data.set(color, y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [16, 48, 128]) await writeFile(resolve(dist, `icon-${size}.png`), icon(size));
const preview = resolve(root, '.preview'); await mkdir(preview, {recursive: true});
for (const name of await readdir(dist)) if (name !== 'SHA256SUMS') await copyFile(resolve(dist, name), resolve(preview, name));
await rm(resolve(dist, 'demo.js'), {force: true});
const sums = [];
for (const name of (await readdir(dist)).sort()) if (name !== 'SHA256SUMS') sums.push(`${createHash('sha256').update(await readFile(resolve(dist, name))).digest('hex')}  ${name}`);
await writeFile(resolve(dist, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log('Built dist/ (load unpacked) and .preview/ (local demo).');
