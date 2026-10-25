import { deflateSync, inflateSync } from "node:zlib";

const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
};

/** A small RGB PNG. The word exists as pixels, not as a text chunk. */
export function labelPng(word: string, scale = 12): Buffer {
  const gap = Math.max(4, Math.round(scale * 0.8));
  const pad = Math.max(8, Math.round(scale * 1.6));
  const glyphWidth = 5 * scale;
  const width = pad * 2 + word.length * glyphWidth + Math.max(0, word.length - 1) * gap;
  const height = pad * 2 + 7 * scale;
  const rgb = Buffer.alloc(width * height * 3, 255);
  let cursor = pad;
  for (const char of word) {
    const rows = GLYPHS[char];
    if (!rows) throw new Error(`label font has no glyph for ${char}`);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] !== "1") continue;
        fill(rgb, width, cursor + x * scale, pad + y * scale, scale, scale);
      }
    });
    cursor += glyphWidth + gap;
  }
  return encodePng(width, height, rgb);
}

function fill(rgb: Buffer, width: number, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const index = (y * width + x) * 3;
      rgb[index] = 20;
      rgb[index + 1] = 24;
      rgb[index + 2] = 28;
    }
  }
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export interface PngInspection {
  png: boolean;
  width: number;
  height: number;
  dark: number;
  decoded: boolean;
}

/** Reads the PNG header and counts dark pixels when every scanline is unfiltered. */
export function inspectPng(png: Buffer): PngInspection {
  const blank = (pngOk: boolean, width = 0, height = 0): PngInspection => ({ png: pngOk, width, height, dark: 0, decoded: false });
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return blank(false);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const color = png[25];
  if (width < 1 || height < 1 || width > 10_000 || height > 10_000) return blank(true, width, height);
  const parts: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > png.length) break;
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const channels = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!channels || parts.length === 0) return blank(true, width, height);
  try {
    const raw = inflateSync(Buffer.concat(parts));
    const stride = width * channels;
    const pixels = unfilter(raw, height, stride, channels);
    if (pixels.length !== height * stride) return blank(true, width, height);
    let dark = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * channels;
        const red = pixels[index] ?? 255;
        const green = pixels[index + 1] ?? 255;
        const blue = pixels[index + 2] ?? 255;
        if (red < 48 && green < 48 && blue < 48) dark += 1;
      }
    }
    return { png: true, width, height, dark, decoded: true };
  } catch {
    return blank(true, width, height);
  }
}

function unfilter(raw: Buffer, height: number, stride: number, channels: number): Buffer {
  if (raw.length < height * (stride + 1)) return Buffer.alloc(0);
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 255;
    if (filter > 4) return Buffer.alloc(0);
    const row = y * (stride + 1) + 1;
    const dest = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (out[dest + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[dest - stride + x] ?? 0) : 0;
      const upLeft = x >= channels && y > 0 ? (out[dest - stride + x - channels] ?? 0) : 0;
      const value = raw[row + x] ?? 0;
      const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upLeft) : 0;
      out[dest + x] = (value + predicted) & 255;
    }
  }
  return out;
}

/** Crops the page around the picture and enlarges it. The word stays in the pixels. */
export function cropForReading(png: Buffer): Buffer {
  const decoded = decodeRgb(png);
  if (!decoded || decoded.width < 800 || decoded.height < 200) return png;
  const x0 = Math.floor(decoded.width * 0.1);
  const x1 = Math.floor(decoded.width * 0.9);
  const y0 = Math.floor(decoded.height * 0.2);
  const y1 = Math.floor(decoded.height * 0.84);
  const cropW = Math.max(1, x1 - x0);
  const cropH = Math.max(1, y1 - y0);
  const scale = 2;
  const rgb = Buffer.alloc(cropW * scale * cropH * scale * 3, 255);
  for (let y = 0; y < cropH; y += 1) {
    for (let x = 0; x < cropW; x += 1) {
      const src = ((y0 + y) * decoded.width + (x0 + x)) * decoded.channels;
      const red = decoded.raw[src] ?? 255;
      const green = decoded.raw[src + 1] ?? 255;
      const blue = decoded.raw[src + 2] ?? 255;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const dest = ((y * scale + dy) * cropW * scale + (x * scale + dx)) * 3;
          rgb[dest] = red;
          rgb[dest + 1] = green;
          rgb[dest + 2] = blue;
        }
      }
    }
  }
  return encodePng(cropW * scale, cropH * scale, rgb);
}

function decodeRgb(png: Buffer): { raw: Buffer; width: number; height: number; channels: number } | undefined {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const color = png[25] ?? 0;
  const channels = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!channels) return undefined;
  const parts: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > png.length) break;
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (parts.length === 0) return undefined;
  try {
    const raw = unfilter(inflateSync(Buffer.concat(parts)), height, width * channels, channels);
    if (raw.length !== height * width * channels) return undefined;
    return { raw, width, height, channels };
  } catch {
    return undefined;
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}
