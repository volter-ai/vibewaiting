import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createMobileIconPng(size) {
  if (!Number.isInteger(size) || size < 16 || size > 1024)
    throw new Error("Icon size must be an integer from 16 through 1024");
  const pixels = Buffer.alloc(size * size * 4);
  const background = [17, 19, 24, 255];
  const foreground = [242, 242, 238, 255];
  const muted = [126, 132, 142, 255];
  const outer = rect(size, 0.2, 0.24, 0.6, 0.47, 0.115);
  const inner = rect(size, 0.265, 0.305, 0.47, 0.285, 0.062);
  const dots = [0.37, 0.5, 0.63].map((x) => ({
    x: x * size,
    y: 0.447 * size,
    radius: 0.025 * size,
  }));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let color = background;
      if (
        inRoundedRect(x, y, outer) ||
        inTriangle(x, y, 0.29 * size, 0.67 * size, 0.25 * size, 0.79 * size, 0.43 * size, 0.69 * size)
      )
        color = foreground;
      if (inRoundedRect(x, y, inner)) color = background;
      if (dots.some((dot) => Math.hypot(x - dot.x, y - dot.y) <= dot.radius))
        color = muted;
      const offset = (y * size + x) * 4;
      pixels.set(color, offset);
    }
  }
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const outputOffset = y * (size * 4 + 1);
    scanlines[outputOffset] = 0;
    pixels.copy(scanlines, outputOffset + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function rect(size, x, y, width, height, radius) {
  return {
    x: x * size,
    y: y * size,
    width: width * size,
    height: height * size,
    radius: radius * size,
  };
}

function inRoundedRect(x, y, value) {
  const nearestX = Math.max(value.x + value.radius, Math.min(x, value.x + value.width - value.radius));
  const nearestY = Math.max(value.y + value.radius, Math.min(y, value.y + value.height - value.radius));
  return (
    x >= value.x &&
    x <= value.x + value.width &&
    y >= value.y &&
    y <= value.y + value.height &&
    Math.hypot(x - nearestX, y - nearestY) <= value.radius
  );
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const area = (x1, y1, x2, y2, x3, y3) =>
    Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2);
  const whole = area(ax, ay, bx, by, cx, cy);
  return Math.abs(
    area(px, py, bx, by, cx, cy) +
      area(ax, ay, px, py, cx, cy) +
      area(ax, ay, bx, by, px, py) -
      whole,
  ) < 0.5;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
