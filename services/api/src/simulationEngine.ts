import type { GraphEdge, GraphSnapshot, SignalPlan } from "@signal-sync/contracts";
import { det01 } from "./loadNetwork.js";
import { getNetwork } from "./graphSeed.js";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function meanStd(edges: { queue_length: number; avg_wait_time: number }[]): { m: number; s: number } {
  if (edges.length === 0) return { m: 0, s: 1 };
  const w = edges.map((e) => e.queue_length * e.avg_wait_time);
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  const v = w.reduce((a, x) => a + (x - m) ** 2, 0) / w.length;
  return { m, s: Math.sqrt(v) || 1 };
}

/** 3σ clamp on synthetic spikes. */
export function clampOutliers(snapshot: GraphSnapshot): GraphSnapshot {
  const { m, s } = meanStd(snapshot.edges);
  const lo = m - 3 * s;
  const hi = m + 3 * s;
  return {
    ...snapshot,
    edges: snapshot.edges.map((e) => {
      const raw = e.queue_length * e.avg_wait_time;
      if (raw > hi) {
        const scale = hi / raw;
        return {
          ...e,
          queue_length: e.queue_length * Math.sqrt(scale),
          avg_wait_time: e.avg_wait_time * Math.sqrt(scale),
        };
      }
      if (raw < lo && raw > 0) {
        const scale = lo / raw;
        return {
          ...e,
          queue_length: e.queue_length * Math.sqrt(scale),
          avg_wait_time: e.avg_wait_time * Math.sqrt(scale),
        };
      }
      return { ...e };
    }),
  };
}

function rushHourMultiplier(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 7 && h < 9) return 1.38;
  if (h >= 17 && h < 19) return 1.3;
  if (h >= 11 && h < 14) return 1.08;
  return 0.78;
}

function commercialInflowMult(toNodeId: string): number {
  const nf = getNetwork();
  const n = nf.nodes.find((x) => x.id === toNodeId);
  if (!n?.tags?.includes("commercial")) return 1;
  return 1.42;
}

function greenFraction(edge: GraphEdge, plan: SignalPlan | null): number {
  if (!plan) return 0.22;
  const inter = plan.intersections.find((i) => i.id === edge.to);
  if (!inter) return 0.22;
  const g = inter.phases[edge.approach];
  const c = inter.cycle_seconds || 60;
  return clamp(g / c, 0.08, 0.92);
}

function delayFromUtil(util: number): number {
  return 5 + 55 * util * util;
}

/**
 * Flow-based traffic step: demand inflow, signal-limited outflow, downstream propagation.
 * Deterministic (uses clock + tick + edge ids only).
 */
export function tickSimulation(
  prev: GraphSnapshot,
  opts: {
    running: boolean;
    hotspotNodeId: string | null;
    appliedPlan: SignalPlan | null;
    tickCount: number;
  }
): GraphSnapshot {
  if (!opts.running) {
    return { ...prev, timestamp_ms: Date.now(), nodes: [...prev.nodes] };
  }
  const ts = Date.now();
  const rush = rushHourMultiplier(new Date(ts));
  const nf = getNetwork();
  const nodeById = new Map(nf.nodes.map((n) => [n.id, n]));

  const edges = prev.edges.map((e) => ({ ...e }));

  const propagate = new Map<string, number>();

  for (const e of edges) {
    const eid = e.edge_id ?? `${e.from}-${e.to}`;
    const cap = e.capacity;
    const util0 = e.queue_length / Math.max(cap, 1);
    const arterial = e.arterial ? 1.12 : 0.92;
    const toTags = nodeById.get(e.to)?.tags ?? [];
    const zoneBoost = toTags.includes("hospital") ? 1.15 : 1;
    let inflow =
      1.4 *
      arterial *
      rush *
      commercialInflowMult(e.to) *
      zoneBoost *
      (0.85 + 0.3 * det01(opts.tickCount, eid));

    if (opts.hotspotNodeId && (e.from === opts.hotspotNodeId || e.to === opts.hotspotNodeId)) {
      inflow += 2.8 + 1.8 * det01(opts.tickCount + 3, `${eid}-hot`);
    }

    const gf = greenFraction(e, opts.appliedPlan);
    const outflow = Math.min(e.queue_length, cap * 0.32 * gf);

    let q = e.queue_length + inflow - outflow;
    q = clamp(q, 0.2, cap * 2.8);

    e.queue_length = q;
    e.avg_wait_time = delayFromUtil(e.queue_length / Math.max(cap, 1));

    if (util0 > 0.62) {
      const spill = (util0 - 0.62) * cap * 0.12;
      for (const down of edges) {
        if (down.from === e.to) {
          const id = down.edge_id ?? `${down.from}-${down.to}`;
          propagate.set(id, (propagate.get(id) ?? 0) + spill);
        }
      }
    }
  }

  for (const e of edges) {
    const id = e.edge_id ?? `${e.from}-${e.to}`;
    const add = propagate.get(id);
    if (add && add > 0) {
      e.queue_length = clamp(e.queue_length + add, 0.2, e.capacity * 2.8);
      e.avg_wait_time = delayFromUtil(e.queue_length / Math.max(e.capacity, 1));
    }
  }

  return {
    timestamp_ms: ts,
    nodes: prev.nodes.map((n) => ({ ...n })),
    edges,
  };
}
