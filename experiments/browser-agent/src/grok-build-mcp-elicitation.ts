import type { McpJson, McpJsonObject } from "./grok-build-mcp-protocol.js";

export const ELICITATION_LIMITS = {
  fields: 32, nameChars: 64, titleChars: 128, descriptionChars: 512,
  enumValues: 32, enumValueChars: 128, draftChars: 4_096, schemaBytes: 64 * 1_024,
} as const;

export interface ElicitationOption { value: string; label: string }
export type ElicitationFieldKind =
  | { type: "string"; format?: "email" | "uri" | "date" | "date-time"; minLength?: number; maxLength?: number; default?: string }
  | { type: "number"; minimum?: number; maximum?: number; default?: string }
  | { type: "integer"; minimum?: bigint; maximum?: bigint; default?: string }
  | { type: "boolean"; default: boolean }
  | { type: "single-select"; options: ElicitationOption[]; defaultIndex?: number }
  | { type: "multi-select"; options: ElicitationOption[]; minItems?: number; maxItems?: number; defaultIndexes: number[] }
  | { type: "unsupported"; reason: string };
export interface ElicitationFieldSpec { name: string; title: string; description?: string; required: boolean; kind: ElicitationFieldKind }
export type ElicitationFieldValue =
  | { type: "draft"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "choice"; index?: number }
  | { type: "multi-choice"; indexes: number[] };
export interface ElicitationValidationError { field: string; message: string }

export function parseElicitationFormSchema(schema: McpJson): ElicitationFieldSpec[] {
  const root = object(schema);
  if (!root) throw new Error("requestedSchema must be a JSON object");
  if (typeof root.type === "string" && root.type !== "object") throw new Error('requestedSchema.type must be "object"');
  const properties = object(root.properties);
  if (!properties) throw new Error("requestedSchema.properties is required");
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > ELICITATION_LIMITS.schemaBytes) throw new Error(`requestedSchema exceeds ${ELICITATION_LIMITS.schemaBytes} bytes`);
  const entries = Object.entries(properties);
  if (entries.length > ELICITATION_LIMITS.fields) throw new Error(`requestedSchema.properties exceeds ${ELICITATION_LIMITS.fields} fields`);
  const required = new Set(Array.isArray(root.required) ? root.required.filter((value): value is string => typeof value === "string") : []);
  return entries.map(([name, raw]) => parseField(name, raw, required.has(name)));
}

export function validateElicitationForm(
  specs: readonly ElicitationFieldSpec[], values: readonly ElicitationFieldValue[],
): { content: McpJsonObject } | { errors: ElicitationValidationError[] } {
  const content: McpJsonObject = {};
  const errors: ElicitationValidationError[] = [];
  specs.forEach((spec, index) => {
    const result = validateField(spec, values[index] ?? { type: "draft", value: "" });
    if ("error" in result) errors.push({ field: spec.name, message: result.error });
    else if (result.value !== undefined) content[spec.name] = result.value;
  });
  return errors.length ? { errors } : { content };
}

/** Validates UI-produced accept content a second time before it reaches MCP. */
export function validateElicitationContent(schema: McpJsonObject, content: McpJson): McpJsonObject | undefined {
  const submitted = object(content);
  if (!submitted) return undefined;
  let specs: ElicitationFieldSpec[];
  try { specs = parseElicitationFormSchema(schema); } catch { return undefined; }
  const values = specs.map((spec): ElicitationFieldValue => contentToValue(spec, submitted[spec.name]));
  const validated = validateElicitationForm(specs, values);
  return "content" in validated ? validated.content : undefined;
}

function parseField(name: string, raw: McpJson, required: boolean): ElicitationFieldSpec {
  if ([...name].length > ELICITATION_LIMITS.nameChars) throw new Error(`requestedSchema property name exceeds ${ELICITATION_LIMITS.nameChars} characters`);
  const property = object(raw) ?? {};
  const title = typeof property.title === "string" ? property.title : name;
  if ([...title].length > ELICITATION_LIMITS.titleChars) throw new Error(`requestedSchema title exceeds ${ELICITATION_LIMITS.titleChars} characters`);
  const description = typeof property.description === "string" ? property.description : undefined;
  if (description && [...description].length > ELICITATION_LIMITS.descriptionChars) throw new Error(`requestedSchema description exceeds ${ELICITATION_LIMITS.descriptionChars} characters`);
  if (typeof property.default === "string" && [...property.default].length > ELICITATION_LIMITS.draftChars) throw new Error(`requestedSchema default exceeds ${ELICITATION_LIMITS.draftChars} characters`);
  const defaultText = scalarString(property.default);
  const legacy = Array.isArray(property.enum) ? optionsFromEnum(property.enum, Array.isArray(property.enumNames) ? property.enumNames : undefined) : [];
  if (legacy.length || Array.isArray(property.enum)) return field(name, title, description, required, selectKind(legacy, defaultText));
  const oneOf = Array.isArray(property.oneOf) ? optionsFromConst(property.oneOf) : [];
  if (oneOf.length) return field(name, title, description, required, selectKind(oneOf, defaultText));
  const type = typeof property.type === "string" ? property.type : "string";
  let kind: ElicitationFieldKind;
  if (type === "string") { const format = allowedFormat(property.format); const minLength = uint(property.minLength); const maxLength = uint(property.maxLength); kind = { type, ...(format ? { format } : {}), ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(defaultText === undefined ? {} : { default: defaultText }) }; }
  else if (type === "number") { const minimum = finite(property.minimum); const maximum = finite(property.maximum); kind = { type, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }), ...(defaultText === undefined ? {} : { default: defaultText }) }; }
  else if (type === "integer") { const minimum = integerBound(property.minimum, true); const maximum = integerBound(property.maximum, false); kind = { type, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }), ...(defaultText === undefined ? {} : { default: defaultText }) }; }
  else if (type === "boolean") kind = { type, default: property.default === true };
  else if (type === "array") kind = multiSelectKind(property);
  else kind = { type: "unsupported", reason: `unsupported type "${type}"` };
  return field(name, title, description, required, kind);
}

function validateField(spec: ElicitationFieldSpec, input: ElicitationFieldValue): { value?: McpJson } | { error: string } {
  const kind = spec.kind;
  if (kind.type === "unsupported") return spec.required ? { error: "unsupported field type" } : {};
  if (kind.type === "boolean") return input.type === "boolean" ? { value: input.value } : { error: "invalid value" };
  if (kind.type === "single-select") {
    if (input.type !== "choice") return { error: "invalid value" };
    const selected = input.index === undefined ? undefined : kind.options[input.index];
    return selected ? { value: selected.value } : spec.required ? { error: "required" } : {};
  }
  if (kind.type === "multi-select") {
    if (input.type !== "multi-choice") return { error: "invalid value" };
    const selected = input.indexes.flatMap((index) => kind.options[index] ? [kind.options[index]!.value] : []);
    if (kind.minItems !== undefined && selected.length < kind.minItems) return { error: `select at least ${kind.minItems}` };
    if (kind.maxItems !== undefined && selected.length > kind.maxItems) return { error: `select at most ${kind.maxItems}` };
    return selected.length || spec.required ? { value: selected } : {};
  }
  if (input.type !== "draft") return { error: "invalid value" };
  if (kind.type === "string") {
    const value = input.value;
    if (!value) return spec.required ? { error: "required" } : {};
    if (kind.minLength !== undefined && [...value].length < kind.minLength) return { error: `min length ${kind.minLength}` };
    if (kind.maxLength !== undefined && [...value].length > kind.maxLength) return { error: `max length ${kind.maxLength}` };
    const formatError = kind.format ? validateFormat(kind.format, value) : undefined;
    return formatError ? { error: formatError } : { value };
  }
  const value = input.value.trim();
  if (!value) return spec.required ? { error: "required" } : {};
  if (kind.type === "integer") {
    if (!/^[+-]?\d+$/u.test(value)) return { error: "must be an integer" };
    const parsed = BigInt(value);
    if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) return { error: "must be an integer" };
    if (kind.minimum !== undefined && parsed < kind.minimum) return { error: `min ${kind.minimum}` };
    if (kind.maximum !== undefined && parsed > kind.maximum) return { error: `max ${kind.maximum}` };
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      const rawJson = (JSON as typeof JSON & { rawJSON?(text: string): unknown }).rawJSON;
      return rawJson ? { value: rawJson(parsed.toString()) as McpJson } : { error: "integer exceeds browser JSON safe range" };
    }
    return { value: Number(parsed) };
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) return { error: "invalid number" };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { error: "invalid number" };
  if (kind.minimum !== undefined && parsed < kind.minimum) return { error: `min ${kind.minimum}` };
  if (kind.maximum !== undefined && parsed > kind.maximum) return { error: `max ${kind.maximum}` };
  return { value: parsed };
}

function contentToValue(spec: ElicitationFieldSpec, value: McpJson | undefined): ElicitationFieldValue {
  if (spec.kind.type === "boolean") return typeof value === "boolean" ? { type: "boolean", value } : { type: "draft", value: "" };
  if (spec.kind.type === "single-select") { const kind = spec.kind; return { type: "choice", ...(typeof value === "string" ? { index: kind.options.findIndex((option) => option.value === value) } : {}) }; }
  if (spec.kind.type === "multi-select") { const kind = spec.kind; return { type: "multi-choice", indexes: Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [kind.options.findIndex((option) => option.value === item)] : []).filter((index) => index >= 0) : [] }; }
  const raw = object(value)?.rawJSON;
  return { type: "draft", value: value === undefined ? "" : typeof value === "string" ? value : typeof raw === "string" ? raw : String(value) };
}

function multiSelectKind(property: McpJsonObject): ElicitationFieldKind {
  const items = object(property.items);
  if (!items) return { type: "unsupported", reason: "array without items" };
  const options = Array.isArray(items.enum) ? optionsFromEnum(items.enum) : Array.isArray(items.anyOf) ? optionsFromConst(items.anyOf) : Array.isArray(items.oneOf) ? optionsFromConst(items.oneOf) : [];
  if (!options.length) return { type: "unsupported", reason: "array without enum items" };
  checkOptions(options);
  const defaults = Array.isArray(property.default) ? property.default : [];
  const minItems = uint(property.minItems); const maxItems = uint(property.maxItems);
  return { type: "multi-select", options, ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }), defaultIndexes: defaults.flatMap((value) => typeof value === "string" ? [options.findIndex((option) => option.value === value)] : []).filter((index) => index >= 0) };
}

function optionsFromEnum(values: McpJson[], labels?: McpJson[]): ElicitationOption[] {
  const options = values.flatMap((value, index) => { const text = scalarString(value); return text === undefined ? [] : [{ value: text, label: typeof labels?.[index] === "string" ? labels[index] as string : text }]; });
  checkOptions(options); return options;
}
function optionsFromConst(entries: McpJson[]): ElicitationOption[] { const options = entries.flatMap((raw) => { const entry = object(raw); const value = typeof entry?.const === "string" ? entry.const : undefined; return value ? [{ value, label: typeof entry?.title === "string" ? entry.title : value }] : []; }); checkOptions(options); return options; }
function checkOptions(options: ElicitationOption[]): void { if (options.length > ELICITATION_LIMITS.enumValues) throw new Error(`requestedSchema enum exceeds ${ELICITATION_LIMITS.enumValues} values`); if (options.some((option) => [...option.value].length > ELICITATION_LIMITS.enumValueChars || [...option.label].length > ELICITATION_LIMITS.enumValueChars)) throw new Error(`requestedSchema enum value exceeds ${ELICITATION_LIMITS.enumValueChars} characters`); }
function selectKind(options: ElicitationOption[], defaultValue?: string): ElicitationFieldKind { checkOptions(options); const index = defaultValue === undefined ? -1 : options.findIndex((option) => option.value === defaultValue); return { type: "single-select", options, ...(index >= 0 ? { defaultIndex: index } : {}) }; }
function field(name: string, title: string, description: string | undefined, required: boolean, kind: ElicitationFieldKind): ElicitationFieldSpec { return { name, title, ...(description === undefined ? {} : { description }), required, kind }; }
function allowedFormat(value: McpJson | undefined): "email" | "uri" | "date" | "date-time" | undefined { return value === "email" || value === "uri" || value === "date" || value === "date-time" ? value : undefined; }
function validateFormat(format: "email" | "uri" | "date" | "date-time", value: string): string | undefined {
  if (format === "email") { const [local, ...domains] = value.split("@"); const labels = domains[0]?.split(".") ?? []; return local && [...local].length <= 64 && !/\s|@/u.test(local) && domains.length === 1 && labels.length >= 2 && labels.every((label) => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-") && /^[A-Za-z0-9-]+$/u.test(label)) ? undefined : "invalid email"; }
  if (format === "uri") { try { const url = new URL(value); return url.protocol ? undefined : "invalid URI"; } catch { return "invalid URI"; } }
  if (format === "date") return validDate(value) ? undefined : "use YYYY-MM-DD";
  return validDateTime(value) ? undefined : "use RFC 3339 date-time";
}
function validDate(value: string): boolean { const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value); if (!match) return false; const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]); if (month < 1 || month > 12) return false; const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; return day >= 1 && day <= days[month - 1]!; }
function validDateTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && !Number.isNaN(Date.parse(value)); }
function integerBound(value: McpJson | undefined, lower: boolean): bigint | undefined { if (typeof value !== "number" || !Number.isFinite(value)) return undefined; const tightened = lower ? Math.ceil(value) : Math.floor(value); return Number.isSafeInteger(tightened) ? BigInt(tightened) : undefined; }
function finite(value: McpJson | undefined): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function uint(value: McpJson | undefined): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function scalarString(value: McpJson | undefined): string | undefined { return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined; }
function object(value: McpJson | undefined): McpJsonObject | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined; }
