import {
  redactGrokBuildOtlpSpan,
  type GrokBuildOtlpAttribute,
  type GrokBuildOtlpRedactionContext,
  type GrokBuildOtlpSpan,
  type GrokBuildOtlpValue,
} from "./grok-build-otlp-redaction.js";

export interface GrokBuildOtlpExportRequest {
  resource: GrokBuildOtlpAttribute[];
  scope: {
    name: string;
    version?: string;
    attributes?: GrokBuildOtlpAttribute[];
    droppedAttributesCount?: number;
  };
  spans: GrokBuildOtlpSpan[];
  schemaUrl?: string;
}

export interface GrokBuildOtlpEncodeOptions {
  redaction?: GrokBuildOtlpRedactionContext;
  /** Defaults true, matching native's unconditional pre-export privacy gate. */
  redact?: boolean;
}

/** Encode OTLP ExportTraceServiceRequest using the standard protobuf wire schema. */
export function encodeGrokBuildOtlpExport(
  request: GrokBuildOtlpExportRequest,
  options: GrokBuildOtlpEncodeOptions = {},
): Uint8Array {
  const spans = options.redact === false
    ? request.spans
    : request.spans.map((span) => redactGrokBuildOtlpSpan(span, options.redaction));
  const resource = message((writer) => {
    for (const attribute of request.resource) writer.message(1, encodeAttribute(attribute));
  });
  const scope = message((writer) => {
    writer.string(1, request.scope.name);
    if (request.scope.version !== undefined) writer.string(2, request.scope.version);
    for (const attribute of request.scope.attributes ?? []) writer.message(3, encodeAttribute(attribute));
    if (request.scope.droppedAttributesCount !== undefined) writer.uint(4, request.scope.droppedAttributesCount);
  });
  const scopeSpans = message((writer) => {
    writer.message(1, scope);
    for (const span of spans) writer.message(2, encodeSpan(span));
    if (request.schemaUrl !== undefined) writer.string(3, request.schemaUrl);
  });
  const resourceSpans = message((writer) => {
    writer.message(1, resource);
    writer.message(2, scopeSpans);
    if (request.schemaUrl !== undefined) writer.string(3, request.schemaUrl);
  });
  return message((writer) => writer.message(1, resourceSpans));
}

function encodeSpan(span: GrokBuildOtlpSpan): Uint8Array {
  requireLength("traceId", span.traceId, 16);
  requireLength("spanId", span.spanId, 8);
  if (span.parentSpanId !== undefined) requireLength("parentSpanId", span.parentSpanId, 8);
  if (span.endTimeUnixNano < span.startTimeUnixNano) {
    throw new RangeError("OTLP span endTimeUnixNano precedes startTimeUnixNano");
  }
  return message((writer) => {
    writer.bytesField(1, span.traceId);
    writer.bytesField(2, span.spanId);
    if (span.traceState !== undefined) writer.string(3, span.traceState);
    if (span.parentSpanId !== undefined) writer.bytesField(4, span.parentSpanId);
    writer.string(5, span.name);
    if (span.kind !== undefined) writer.uint(6, span.kind);
    writer.fixed64(7, span.startTimeUnixNano);
    writer.fixed64(8, span.endTimeUnixNano);
    for (const attribute of span.attributes) writer.message(9, encodeAttribute(attribute));
    if (span.droppedAttributesCount !== undefined) writer.uint(10, span.droppedAttributesCount);
    for (const event of span.events ?? []) {
      writer.message(11, message((eventWriter) => {
        eventWriter.fixed64(1, event.timeUnixNano);
        eventWriter.string(2, event.name);
        for (const attribute of event.attributes) eventWriter.message(3, encodeAttribute(attribute));
        if (event.droppedAttributesCount !== undefined) eventWriter.uint(4, event.droppedAttributesCount);
      }));
    }
    if (span.droppedEventsCount !== undefined) writer.uint(12, span.droppedEventsCount);
    for (const link of span.links ?? []) {
      requireLength("link.traceId", link.traceId, 16);
      requireLength("link.spanId", link.spanId, 8);
      writer.message(13, message((linkWriter) => {
        linkWriter.bytesField(1, link.traceId);
        linkWriter.bytesField(2, link.spanId);
        if (link.traceState !== undefined) linkWriter.string(3, link.traceState);
        for (const attribute of link.attributes) linkWriter.message(4, encodeAttribute(attribute));
        if (link.droppedAttributesCount !== undefined) linkWriter.uint(5, link.droppedAttributesCount);
        if (link.flags !== undefined) linkWriter.fixed32(6, link.flags);
      }));
    }
    if (span.droppedLinksCount !== undefined) writer.uint(14, span.droppedLinksCount);
    if (span.status !== undefined) {
      writer.message(15, message((statusWriter) => {
        if (span.status?.message !== undefined) statusWriter.string(2, span.status.message);
        statusWriter.uint(3, span.status?.code ?? 0);
      }));
    }
    if (span.flags !== undefined) writer.fixed32(16, span.flags);
  });
}

function encodeAttribute(attribute: GrokBuildOtlpAttribute): Uint8Array {
  return message((writer) => {
    writer.string(1, attribute.key);
    writer.message(2, encodeAnyValue(attribute.value));
  });
}

function encodeAnyValue(value: GrokBuildOtlpValue): Uint8Array {
  return message((writer) => {
    if (typeof value === "string") writer.string(1, value);
    else if (typeof value === "boolean") writer.uint(2, value ? 1 : 0);
    else if (typeof value === "bigint") writer.int64(3, value);
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new RangeError("OTLP numeric attributes must be finite");
      if (Number.isSafeInteger(value)) writer.int64(3, BigInt(value));
      else writer.double(4, value);
    } else {
      writer.message(5, message((arrayWriter) => {
        for (const item of value) arrayWriter.message(1, encodeAnyValue(item));
      }));
    }
  });
}

function message(build: (writer: ProtobufWriter) => void): Uint8Array {
  const writer = new ProtobufWriter();
  build(writer);
  return writer.finish();
}

class ProtobufWriter {
  private readonly output: number[] = [];

  uint(field: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid uint value ${value}`);
    this.tag(field, 0);
    this.varint(BigInt(value));
  }

  int64(field: number, value: bigint): void {
    this.tag(field, 0);
    this.varint(BigInt.asUintN(64, value));
  }

  fixed32(field: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`invalid fixed32 value ${value}`);
    }
    this.tag(field, 5);
    for (let shift = 0; shift < 32; shift += 8) this.output.push((value >>> shift) & 0xff);
  }

  fixed64(field: number, value: bigint): void {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError(`invalid fixed64 value ${value}`);
    this.tag(field, 1);
    for (let shift = 0n; shift < 64n; shift += 8n) this.output.push(Number((value >> shift) & 0xffn));
  }

  double(field: number, value: number): void {
    this.tag(field, 1);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.output.push(...bytes);
  }

  string(field: number, value: string): void {
    this.bytesField(field, new TextEncoder().encode(value));
  }

  message(field: number, value: Uint8Array): void {
    this.bytesField(field, value);
  }

  bytesField(field: number, value: Uint8Array): void {
    this.tag(field, 2);
    this.varint(BigInt(value.byteLength));
    this.output.push(...value);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.output);
  }

  private tag(field: number, wire: number): void {
    if (!Number.isSafeInteger(field) || field <= 0) throw new RangeError(`invalid field ${field}`);
    this.varint(BigInt((field << 3) | wire));
  }

  private varint(value: bigint): void {
    let remaining = value;
    while (remaining >= 0x80n) {
      this.output.push(Number((remaining & 0x7fn) | 0x80n));
      remaining >>= 7n;
    }
    this.output.push(Number(remaining));
  }
}

function requireLength(name: string, value: Uint8Array, length: number): void {
  if (value.byteLength !== length) throw new RangeError(`OTLP ${name} must be ${length} bytes`);
}
