import type { GraphEdge, GraphSnapshot } from "@signal-sync/contracts";

export function routingCost(e: GraphEdge): number {
  return e.avg_wait_time + e.queue_length / Math.max(e.capacity, 1);
}

/** Sum routing costs along a node path (directed edges). */
export function pathCost(snapshot: GraphSnapshot, nodes: string[]): number {
  let sum = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const edge = snapshot.edges.find((e) => e.from === a && e.to === b);
    if (edge) sum += routingCost(edge);
  }
  return sum;
}

/** ETA proxy after preemption: reduce cost on segments entering preempted nodes. */
export function pathCostWithPreemption(
  snapshot: GraphSnapshot,
  nodes: string[],
  preemptNodes: Set<string>
): number {
  let sum = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const edge = snapshot.edges.find((e) => e.from === a && e.to === b);
    if (!edge) continue;
    let c = routingCost(edge);
    if (preemptNodes.has(b)) c *= 0.48;
    sum += c;
  }
  return sum;
}
