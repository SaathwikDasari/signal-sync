import type { GraphSnapshot } from "@signal-sync/contracts";
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

export function staticFallbackSchedule() {
  const nf = getNetwork();
  const eq = { n: 15, e: 15, s: 15, w: 15 } as const;
  return nf.nodes.map((n) => ({
    id: n.id,
    phases: { ...eq },
    cycle_seconds: 60,
  }));
}
