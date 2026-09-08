const SECRET_KEYS = /private[_-]?key|seed|mnemonic|secret|credential/i;
const HEX_KEY = /0x[a-fA-F0-9]{64}/g;

export type LogFields = Record<string, unknown>;

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(HEX_KEY, "0x[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(inner);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function logEvent(event: string, fields: LogFields = {}): void {
  const payload = redact({
    ts: new Date().toISOString(),
    event,
    ...fields,
  });
  console.log(JSON.stringify(payload));
}
