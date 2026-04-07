/** Shared JSON contracts between API, dashboard, and Rust core (mirror field names). */

export type Direction = "n" | "e" | "s" | "w";

export interface GraphEdge {
  /** Stable id for history / forecasting (from network data). */
  edge_id?: string;
  from: string;
  to: string;
  /** Approach direction at `to` intersection (incoming leg). */
  approach: Direction;
  queue_length: number;
  avg_wait_time: number;
  /** Vehicles/hour capacity for this link (used in routing cost). */
  capacity: number;
  /** Optional: main arterial (simulation + rush hour). */
  arterial?: boolean;
}

export interface GraphNode {
  id: string;
  label?: string;
  x?: number;
  y?: number;
  zone?: string;
  tags?: string[];
}

export interface GraphSnapshot {
  timestamp_ms: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface EmergencyRouteRequest {
  /** Current intersection node id (EV position). */
  current_node_id: string;
  destination_node_id: string;
  /** Vehicle speed m/s (optional, for ETA display). */
  speed_mps?: number;
}

export interface OptimizeInput {
  snapshot: GraphSnapshot;
  /** When set, core computes green corridor for next 3 intersections along shortest path. */
  emergency?: EmergencyRouteRequest | null;
}

export interface IntersectionPhasePlan {
  id: string;
  phases: Record<Direction, number>;
  cycle_seconds: number;
}

export interface SignalPlan {
  intersections: IntersectionPhasePlan[];
  /** High-pressure path nodes (congestion routing). */
  pressure_path: string[];
  /** Preempted intersection ids (max 3 ahead of EV). */
  emergency_preemption_nodes: string[];
  /** Full node path for active emergency (when present). */
  emergency_route_path?: string[];
  /** Rust-reported optimization time in microseconds (for dashboard). */
  compute_us: number;
}

export interface OptimizeOutput {
  ok: boolean;
  plan: SignalPlan | null;
  error?: string;
}

/** EV position for dashboard animation (API-computed each tick). */
export interface EmergencyVehicleState {
  active: boolean;
  path: string[];
  /** Index into path: current node is path[pathIndex]. */
  path_index: number;
  /** 0–1 progress along edge from path[path_index] to path[path_index+1]. */
  edge_progress: number;
  /** ETA seconds (after optimization / preemption). */
  eta_seconds_after: number | null;
  /** ETA if no preemption (same path, congested cost). */
  eta_seconds_before: number | null;
}
