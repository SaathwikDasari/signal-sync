import { appendFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, "../../logs");
const logFile = path.join(logDir, "signal-sync.jsonl");

export function logStructured(event: string, data: Record<string, unknown>): void {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...data,
      }) + "\n";
    appendFileSync(logFile, line, "utf8");
  } catch {
    /* avoid crashing API on log failure */
  }
}
