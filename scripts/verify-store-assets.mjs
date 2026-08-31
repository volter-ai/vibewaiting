#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../docs/assets/store/", import.meta.url));
const expected = new Map([
  ["messenger-1280x800.png", [1280, 800]],
  ["terminal-1280x800.png", [1280, 800]],
  ["website-access-1280x800.png", [1280, 800]],
  ["promo-440x280.png", [440, 280]],
]);

const problems = [];
for (const [name, [expectedWidth, expectedHeight]] of expected) {
  let bytes;
  try {
    bytes = await readFile(`${directory}/${name}`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      problems.push(`missing ${name}`);
      continue;
    }
    throw error;
  }
  const png = bytes.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const width = png && bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
  const height = png && bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
  const bitDepth = png && bytes.length >= 26 ? bytes[24] : 0;
  const colorType = png && bytes.length >= 26 ? bytes[25] : -1;
  if (!png) problems.push(`${name} is not a PNG`);
  else if (width !== expectedWidth || height !== expectedHeight)
    problems.push(`${name} is ${width}×${height}, expected ${expectedWidth}×${expectedHeight}`);
  else if (bitDepth !== 8 || colorType !== 2)
    problems.push(`${name} must be a 24-bit RGB PNG without an alpha channel`);
}

if (problems.length)
  throw new Error(`Chrome Web Store assets are incomplete:\n${problems.join("\n")}`);
process.stdout.write("Chrome Web Store assets verified\n");
