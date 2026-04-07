import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Direction, GraphEdge, GraphNode } from "@signal-sync/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface NetworkFileEdge {
  id: string;
  from: string;
  to: string;
  approach: Direction;
  capacity: number;
  arterial?: boolean;
}

export interface NetworkFileNode {
  id: string;
  label?: string;
  x: number;
  y: number;
  zone?: string;
  tags?: string[];
}

export interface NetworkFile {
  meta?: { name?: string; description?: string };
  nodes: NetworkFileNode[];
  edges: NetworkFileEdge[];
}

/** Deterministic seed from edge id + tick (no Math.random). */
export function det01(tick: number, edgeId: string): number {
  let h = 0;
  for (let i = 0; i < edgeId.length; i++) {
    h = (h * 31 + edgeId.charCodeAt(i)) >>> 0;
  }
  return (((tick * 1103515245 + h) >>> 0) % 1000) / 1000;
}

export function resolveNetworkPath(): string {
  const env = process.env.NETWORK_CONFIG_PATH;
  if (env && existsSync(env)) return path.resolve(env);
  return path.join(__dirname, "../data/network.json");
}

export function loadNetworkFile(customPath?: string): NetworkFile {
  const p = customPath && existsSync(customPath) ? customPath : resolveNetworkPath();
  const raw = readFileSync(p, "utf-8");
  return JSON.parse(raw) as NetworkFile;
}

export function networkToGraphNodes(nf: NetworkFile): GraphNode[] {
  return nf.nodes.map((n) => ({
    id: n.id,
    label: n.label ?? n.id,
    x: n.x,
    y: n.y,
    zone: n.zone,
    tags: n.tags,
  }));
}

export function initialEdgesFromNetwork(nf: NetworkFile, tick: number): GraphEdge[] {
  return nf.edges.map((e) => {
    const u = det01(tick, e.id);
    const base = 0.08 + u * 0.06;
    const cap = e.capacity;
    const queue = cap * base;
    const util = queue / cap;
    const avg_wait = 6 + util * util * 45;
    return {
      edge_id: e.id,
      from: e.from,
      to: e.to,
      approach: e.approach,
      queue_length: queue,
      avg_wait_time: avg_wait,
      capacity: cap,
      arterial: e.arterial,
    };
  });
}
