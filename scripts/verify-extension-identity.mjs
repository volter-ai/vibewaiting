#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
);
const nativeInstall = await readFile(
  new URL("../src/native-install.ts", import.meta.url),
  "utf8",
);

if (typeof manifest.key !== "string" || !manifest.key.trim())
  throw new Error("extension/manifest.json must contain the Chrome Web Store public key");

const digest = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest()
  .subarray(0, 16);
const derivedId = [...digest]
  .map(
    (byte) =>
      String.fromCharCode(97 + (byte >> 4)) +
      String.fromCharCode(97 + (byte & 0x0f)),
  )
  .join("");
const nativeId = nativeInstall.match(
  /DEVELOPMENT_EXTENSION_ID\s*=\s*"([a-p]{32})"/,
)?.[1];
if (!nativeId)
  throw new Error("src/native-install.ts does not declare DEVELOPMENT_EXTENSION_ID");
if (nativeId !== derivedId)
  throw new Error(
    `native host allows ${nativeId}, but the manifest public key produces ${derivedId}`,
  );

const expectedFlag = process.argv.indexOf("--expected");
const expected = expectedFlag >= 0 ? process.argv[expectedFlag + 1]?.trim() : "";
if (expectedFlag >= 0 && !expected)
  throw new Error("--expected requires the final Chrome Web Store extension ID");
if (expected && expected !== derivedId)
  throw new Error(
    `Chrome Web Store item is ${expected}, but this release produces ${derivedId}`,
  );

process.stdout.write(`extension identity verified: ${derivedId}\n`);
