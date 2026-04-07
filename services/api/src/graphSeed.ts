/**
 * Graph bootstrap: topology and capacities come from JSON (`data/network.json`), not hard-coded edges.
 * That file defines the 10-node demo city (arterial A–E, alternate F, commercial C/D/I, hospital H, etc.).
 */
import type { GraphEdge, GraphSnapshot } from "@signal-sync/contracts";
import {
  loadNetworkFile,
  networkToGraphNodes,
  initialEdgesFromNetwork,
  type NetworkFile,
} from "./loadNetwork.js";

let cachedNetwork: NetworkFile | null = null;

export function getNetwork(): NetworkFile {
  if (!cachedNetwork) {
    cachedNetwork = loadNetworkFile();
  }
  return cachedNetwork;
}

/** Reload graph from disk (tests / operator tooling). */
export function reloadNetwork(): NetworkFile {
  cachedNetwork = loadNetworkFile();
  return cachedNetwork;
}

export function initialSnapshot(): GraphSnapshot {
  const nf = getNetwork();
  const ts = Date.now();
  return {
    timestamp_ms: ts,
    nodes: networkToGraphNodes(nf),
    edges: initialEdgesFromNetwork(nf, 0),
  };
}

/**
 * Reload `network.json` and rebuild snapshot edges (capacity/arterial/topology).
 * Preserves existing queue/wait for edges that still exist (by `edge_id`).
 */
export function reloadSnapshot(current: GraphSnapshot, tick: number): GraphSnapshot {
  const nf = reloadNetwork();
  const seeded = initialEdgesFromNetwork(nf, tick);
  const byEdgeId = new Map<string, GraphEdge>();
  for (const e of current.edges) {
    const id = e.edge_id ?? `${e.from}-${e.to}`;
    byEdgeId.set(id, e);
  }
  return {
    timestamp_ms: Date.now(),
    nodes: networkToGraphNodes(nf),
    edges: seeded.map((e) => {
      const prev = byEdgeId.get(e.edge_id ?? `${e.from}-${e.to}`);
      return prev
        ? { ...e, queue_length: prev.queue_length, avg_wait_time: prev.avg_wait_time }
        : e;
    }),
  };
}

export function staticFallbackSchedule() {
  const nf = getNetwork();
  const eq = { n: 15, e: 15, s: 15, w: 15 } as const;
  return nf.nodes.map((n) => ({
    id: n.id,
    phases: { ...eq },
    cycle_seconds: 60,
  }));
}
