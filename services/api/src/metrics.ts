import type { GraphSnapshot } from "@signal-sync/contracts";

export interface TrafficMetrics {
  avgWaitGlobal: number;
  maxCongestionEdgeId: string;
  maxCongestionLoad: number;
  totalVehicles: number;
}

export function computeMetrics(snapshot: GraphSnapshot): TrafficMetrics {
  let totalV = 0;
  let waitSum = 0;
  let maxEdge = { id: "", load: 0 };
  for (const e of snapshot.edges) {
    totalV += e.queue_length;
    waitSum += e.avg_wait_time;
    const load = e.queue_length * e.avg_wait_time;
    if (load > maxEdge.load) {
      maxEdge = { id: e.edge_id ?? `${e.from}-${e.to}`, load };
    }
  }
  const n = snapshot.edges.length || 1;
  return {
    avgWaitGlobal: waitSum / n,
    maxCongestionEdgeId: maxEdge.id || "—",
    maxCongestionLoad: maxEdge.load,
    totalVehicles: totalV,
  };
}
