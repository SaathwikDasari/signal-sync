import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import type { OptimizeInput, OptimizeOutput } from "@signal-sync/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function coreBinaryPath(): string {
  const env = process.env.SIGNAL_SYNC_CORE_PATH;
  if (env) return env;
  const name = process.platform === "win32" ? "signal-sync-core.exe" : "signal-sync-core";
  return path.resolve(__dirname, "../../../target/release", name);
}

export function runOptimizer(
  input: OptimizeInput,
  timeoutMs: number
): Promise<OptimizeOutput> {
  const bin = coreBinaryPath();
  return new Promise((resolve) => {
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const payload = JSON.stringify(input);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        plan: null,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, plan: null, error: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        resolve({
          ok: false,
          plan: null,
          error: err || `exit ${code}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(out.trim()) as OptimizeOutput;
        resolve(parsed);
      } catch (e) {
        resolve({
          ok: false,
          plan: null,
          error: `bad json: ${e}; stderr=${err}`,
        });
      }
    });
    child.stdin?.write(payload);
    child.stdin?.end();
  });
}
