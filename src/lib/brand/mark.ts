/**
 * V12.2 logo mark pixels and the favicon.ico container.
 * Colors live in `colors.ts` so the icon image does not import zlib.
 */
import { crc32, deflateSync } from "node:zlib";

import { MARK_DARK, MARK_LIME } from "@/lib/brand/colors";

function rgba(hex: string): readonly [number, number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ];
}

const DARK = rgba(MARK_DARK);
const LIME = rgba(MARK_LIME);

/** Lime disk, about 44% of the square, centered on the midnight field. */
export function markPixel(
  x: number,
  y: number,
  size: number,
): readonly [number, number, number, number] {
  if (size <= 0) return DARK;
  const center = (size - 1) / 2;
  const radius = size * 0.22;
  const dx = x - center;
  const dy = y - center;
  return dx * dx + dy * dy <= radius * radius ? LIME : DARK;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function encodeMarkPng(size: number): Buffer {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = markPixel(x, y, size);
      const index = row + 1 + x * 4;
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
      raw[index + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO container of PNG images. Width 256 is stored as 0, per the ICO spec. */
export function encodeIco(sizes: readonly number[]): Buffer {
  const images = sizes.map((size) => encodeMarkPng(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  images.forEach((png, index) => {
    const size = sizes[index]!;
    const base = index * 16;
    entries[base] = size >= 256 ? 0 : size;
    entries[base + 1] = size >= 256 ? 0 : size;
    entries.writeUInt16LE(1, base + 4);
    entries.writeUInt16LE(32, base + 6);
    entries.writeUInt32LE(png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images]);
}
