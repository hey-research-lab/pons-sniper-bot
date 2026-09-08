export type Flags = Record<string, string | boolean>;

export function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

export function flagString(flags: Flags, name: string, fallback?: string): string {
  const value = flags[name];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

export function flagOptional(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function flagInt(flags: Flags, name: string, fallback: number): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}
