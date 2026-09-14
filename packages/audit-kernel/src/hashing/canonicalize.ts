/**
 * RFC 8785-compatible JSON canonicalization for Kernel payloads.
 *
 * Restricted to JSON null, boolean, integer, string, array, and object.
 * Non-integers and non-finite numbers are rejected so hash input cannot
 * depend on floating-point serialization.
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error("canonical JSON only accepts finite integers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new Error(`unsupported canonical JSON type: ${typeof value}`);
}
