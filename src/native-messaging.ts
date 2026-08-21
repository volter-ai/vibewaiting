import { randomUUID } from "node:crypto";
import type { NativeHostEvent } from "./extension-protocol.js";
import { VIBEWAITING_EXTENSION_PROTOCOL } from "./extension-protocol.js";

export const MAX_NATIVE_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_NATIVE_OUTPUT_BYTES = 900_000;
const CHUNK_DATA_BYTES = 600_000;

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > MAX_NATIVE_INPUT_BYTES) {
    throw new Error(`native message exceeds ${MAX_NATIVE_INPUT_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Incrementally decodes Chromium/Firefox native-messaging frames across arbitrary stdio chunks. */
export class NativeMessageDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.pending =
      this.pending.byteLength === 0
        ? chunk
        : Buffer.concat([this.pending, chunk]);
    const messages: unknown[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length > MAX_NATIVE_INPUT_BYTES)
        throw new Error(
          `native message exceeds ${MAX_NATIVE_INPUT_BYTES} bytes`,
        );
      if (this.pending.byteLength < length + 4) break;
      const payload = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      messages.push(JSON.parse(payload.toString("utf8")) as unknown);
    }
    return messages;
  }

  finish(): void {
    if (this.pending.byteLength !== 0)
      throw new Error("native message stream ended mid-frame");
  }
}

/** Keeps every host→browser message below the browser's 1 MiB native-messaging ceiling. */
export function chunkNativeEvent(
  event: Exclude<NativeHostEvent, { type: "chunk" }>,
): NativeHostEvent[] {
  const serialized = Buffer.from(JSON.stringify(event), "utf8");
  if (serialized.byteLength <= MAX_NATIVE_OUTPUT_BYTES) return [event];
  const id = randomUUID();
  const encoded = serialized.toString("base64");
  const total = Math.ceil(encoded.length / CHUNK_DATA_BYTES);
  return Array.from({ length: total }, (_, index) => ({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "chunk",
    id,
    index,
    total,
    data: encoded.slice(
      index * CHUNK_DATA_BYTES,
      (index + 1) * CHUNK_DATA_BYTES,
    ),
  }));
}
