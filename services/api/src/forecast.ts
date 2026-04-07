import type { GraphSnapshot } from "@signal-sync/contracts";

export const HISTORY_LEN = 5;

export function pushHistory(map: Map<string, number[]>, edgeId: string, q: number): void {
  const arr = [...(map.get(edgeId) ?? [])];
  arr.push(q);
  while (arr.length > HISTORY_LEN) arr.shift();
  map.set(edgeId, arr);
}

export function forecastMultiplier(edgeId: string, map: Map<string, number[]>): number {
  const arr = map.get(edgeId);
  if (!arr || arr.length < 2) return 1;
  const first = arr[0]!;
  const last = arr[arr.length - 1]!;
  const trend = (last - first) / (Math.abs(first) + 25);
  if (trend > 0.04) return 1 + Math.min(0.14, trend);
  if (trend < -0.04) return 1 + Math.max(-0.1, trend);
  return 1;
}

/** Slightly adjusts queues for the optimizer to anticipate trend (no ML). */
export function applyForecastSnapshot(snapshot: GraphSnapshot, map: Map<string, number[]>): GraphSnapshot {
  return {
    ...snapshot,
    edges: snapshot.edges.map((e) => {
      const id = e.edge_id ?? `${e.from}-${e.to}`;
      const m = forecastMultiplier(id, map);
      return { ...e, queue_length: Math.min(e.capacity * 2.5, e.queue_length * m) };
    }),
  };
}
