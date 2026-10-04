import { format } from "node:util";

const secrets = new Set<string>();
export function registerSecret(value: string): void { if (value) secrets.add(value); }
export function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const key of [process.env.NEXUS_API_KEY || "", ...secrets]) {
    if (!key) continue;
    for (const variant of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
      text = text.split(variant).join("[REDACTED]");
    }
  }
  return text.replace(/([?&](?:key|token|signature)=)[^&\s"']+/gi, "$1[REDACTED]");
}
export function installErrorRedaction(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => original(redact(format(...args)));
}
