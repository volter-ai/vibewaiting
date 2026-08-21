import { describe, expect, it } from "vitest";
import { VIBEWAITING_EXTENSION_PROTOCOL } from "../src/extension-protocol.js";
import {
  chunkNativeEvent,
  encodeNativeMessage,
  MAX_NATIVE_OUTPUT_BYTES,
  NativeMessageDecoder,
} from "../src/native-messaging.js";

describe("native extension transport", () => {
  it("survives arbitrary stdio fragmentation and keeps a large state projection below the browser ceiling", () => {
    const first = {
      protocol: VIBEWAITING_EXTENSION_PROTOCOL,
      type: "status",
      phase: "ready",
    } as const;
    const second = {
      protocol: VIBEWAITING_EXTENSION_PROTOCOL,
      type: "patch",
      patch: { transcript: "x".repeat(MAX_NATIVE_OUTPUT_BYTES) },
    } as const;
    const framed = Buffer.concat([
      encodeNativeMessage(first),
      encodeNativeMessage(second),
    ]);
    const decoder = new NativeMessageDecoder();
    const decoded = [
      ...decoder.push(framed.subarray(0, 3)),
      ...decoder.push(framed.subarray(3, 19)),
      ...decoder.push(framed.subarray(19, 70_013)),
      ...decoder.push(framed.subarray(70_013)),
    ];
    decoder.finish();
    expect(decoded).toEqual([first, second]);

    const chunks = chunkNativeEvent(second);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(encodeNativeMessage(chunk).byteLength).toBeLessThan(1_000_000);
    const encoded = chunks
      .map((chunk) => (chunk.type === "chunk" ? chunk.data : ""))
      .join("");
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(
      second,
    );
  });
});
