import express from "express";
import cors from "cors";
import type { EmergencyRouteRequest, GraphSnapshot, SignalPlan } from "@signal-sync/contracts";
import { initialSnapshot, staticFallbackSchedule } from "./graphSeed.js";
import { clampOutliers, tickSimulation } from "./simulationEngine.js";
import { runOptimizer } from "./rustBridge.js";
import { applyForecastSnapshot, pushHistory } from "./forecast.js";
import { computeMetrics } from "./metrics.js";
import { pathCost, pathCostWithPreemption } from "./pathUtils.js";
import { logStructured } from "./logger.js";

const PORT = Number(process.env.PORT) || 3001;
const CYCLE_MS = 30_000;
const RUST_TIMEOUT_MS = Number(process.env.RUST_TIMEOUT_MS) || 50;
const APPROVAL_REQUIRED = process.env.APPROVAL_REQUIRED === "true";
const EDGE_SECONDS = Number(process.env.EV_EDGE_SECONDS) || 10;

type FallbackState = "ok" | "timeout" | "rust_error" | "static_only";

let snapshot: GraphSnapshot = initialSnapshot();
let queueHistory = new Map<string, number[]>();
let appliedPlan: SignalPlan | null = null;
let proposedPlan: SignalPlan | null = null;
let simulationRunning = false;
let hotspotNodeId: string | null = null;
let emergency: EmergencyRouteRequest | null = null;
let lastOptimizeMs = 0;
let lastComputeUs = 0;
let lastSimulationStepMs = 0;
let fallback: FallbackState = "ok";
let cycleCount = 0;
let tickCount = 0;
let optimizing = false;
let baselineAvgWait: number | null = null;

/** EV animation along `emergency_route_path`. */
let evState: {
  path: string[];
  pathIndex: number;
  edgeProgress: number;
} | null = null;

function buildStaticPlan(): SignalPlan {
  return {
    intersections: staticFallbackSchedule().map((x) => ({
      id: x.id,
      phases: { ...x.phases },
      cycle_seconds: x.cycle_seconds,
    })),
    pressure_path: [],
    emergency_preemption_nodes: [],
    emergency_route_path: undefined,
    compute_us: 0,
  };
}

function recordHistoryFromSnapshot(s: GraphSnapshot): void {
  for (const e of s.edges) {
    const id = e.edge_id ?? `${e.from}-${e.to}`;
    pushHistory(queueHistory, id, e.queue_length);
  }
}

function computeEtaPair(s: GraphSnapshot, plan: SignalPlan | null): {
  etaBefore: number | null;
  etaAfter: number | null;
} {
  if (!emergency || !plan?.emergency_route_path?.length) {
    return { etaBefore: null, etaAfter: null };
  }
  const path = plan.emergency_route_path;
  const preempt = new Set(plan.emergency_preemption_nodes);
  return {
    etaBefore: pathCost(s, path),
    etaAfter: pathCostWithPreemption(s, path, preempt),
  };
}

function syncEvFromPlan(plan: SignalPlan | null): void {
  if (!emergency || !plan?.emergency_route_path?.length) {
    evState = null;
    return;
  }
  const path = plan.emergency_route_path;
  if (!evState || JSON.stringify(evState.path) !== JSON.stringify(path)) {
    evState = { path, pathIndex: 0, edgeProgress: 0 };
  }
}

async function runCycle(): Promise<void> {
  if (optimizing) return;
  optimizing = true;
  recordHistoryFromSnapshot(snapshot);
  if (simulationRunning && baselineAvgWait === null) {
    baselineAvgWait = computeMetrics(snapshot).avgWaitGlobal;
  }
  const clamped = clampOutliers(snapshot);
  const forRust = applyForecastSnapshot(clamped, queueHistory);
  const t0 = performance.now();
  const result = await runOptimizer(
    {
      snapshot: forRust,
      emergency: emergency ?? undefined,
    },
    RUST_TIMEOUT_MS
  );
  lastOptimizeMs = performance.now() - t0;
  try {
    if (result.ok && result.plan) {
      proposedPlan = result.plan;
      lastComputeUs = result.plan.compute_us;
      fallback = "ok";
      if (!APPROVAL_REQUIRED) {
        appliedPlan = proposedPlan;
      }
      syncEvFromPlan(appliedPlan ?? proposedPlan);
      logStructured("optimize_ok", {
        rust_us: result.plan.compute_us,
        api_ms: lastOptimizeMs,
        approval_pending: APPROVAL_REQUIRED,
      });
      return;
    }
    if (result.error?.includes("timeout")) {
      fallback = "timeout";
    } else {
      fallback = "rust_error";
    }
    logStructured("optimize_fail", { error: result.error ?? "unknown", api_ms: lastOptimizeMs });
    if (appliedPlan) {
      return;
    }
    appliedPlan = buildStaticPlan();
    proposedPlan = appliedPlan;
    fallback = "static_only";
  } finally {
    optimizing = false;
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, dataSource: "simulation" });
});

app.get("/api/state", (_req, res) => {
  const metrics = computeMetrics(snapshot);
  const planForEta = appliedPlan ?? proposedPlan;
  const eta = computeEtaPair(snapshot, planForEta);
  const evCur = evState;
  res.json({
    snapshot,
    plan: appliedPlan,
    proposedPlan,
    approvalRequired: APPROVAL_REQUIRED,
    simulationRunning,
    hotspotNodeId,
    emergency,
    lastOptimizeMs,
    lastComputeUs,
    lastSimulationStepMs,
    fallback,
    cycleSeconds: CYCLE_MS / 1000,
    cycleCount,
    serverTime: Date.now(),
    metrics: {
      ...metrics,
      etaBefore: eta.etaBefore,
      etaAfter: eta.etaAfter,
      baselineAvgWait,
      avgWaitDeltaVsBaseline:
        baselineAvgWait != null ? metrics.avgWaitGlobal - baselineAvgWait : null,
    },
    emergencyVehicle: evCur
      ? {
          active: !!emergency,
          path: evCur.path,
          path_index: evCur.pathIndex,
          edge_progress: evCur.edgeProgress,
          eta_seconds_before: eta.etaBefore,
          eta_seconds_after: eta.etaAfter,
        }
      : {
          active: false,
          path: [],
          path_index: 0,
          edge_progress: 0,
          eta_seconds_before: eta.etaBefore,
          eta_seconds_after: eta.etaAfter,
        },
    trafficDataSource: "simulation",
  });
});

app.post("/api/simulation/start", (_req, res) => {
  simulationRunning = true;
  if (baselineAvgWait === null) {
    baselineAvgWait = computeMetrics(snapshot).avgWaitGlobal;
  }
  res.json({ ok: true, simulationRunning });
});

app.post("/api/simulation/stop", (_req, res) => {
  simulationRunning = false;
  res.json({ ok: true, simulationRunning });
});

app.post("/api/simulation/tick", (_req, res) => {
  tickCount += 1;
  const t0 = performance.now();
  snapshot = tickSimulation(snapshot, {
    running: simulationRunning,
    hotspotNodeId,
    appliedPlan,
    tickCount,
  });
  lastSimulationStepMs = performance.now() - t0;
  logStructured("simulation_tick", { ms: lastSimulationStepMs, tickCount });
  res.json({ ok: true, snapshot });
});

app.post("/api/hotspot", (req, res) => {
  const id = (req.body?.nodeId as string) || null;
  hotspotNodeId = id;
  res.json({ ok: true, hotspotNodeId });
});

app.post("/api/emergency", (req, res) => {
  const body = req.body as EmergencyRouteRequest;
  if (!body?.current_node_id || !body?.destination_node_id) {
    res.status(400).json({ ok: false, error: "current_node_id and destination_node_id required" });
    return;
  }
  emergency = {
    current_node_id: body.current_node_id,
    destination_node_id: body.destination_node_id,
    speed_mps: body.speed_mps,
  };
  evState = null;
  void runCycle().then(() => res.json({ ok: true, emergency, plan: appliedPlan, proposedPlan }));
});

app.delete("/api/emergency", (_req, res) => {
  emergency = null;
  evState = null;
  void runCycle().then(() => res.json({ ok: true, emergency: null, plan: appliedPlan, proposedPlan }));
});

app.post("/api/plan/approve", (_req, res) => {
  if (proposedPlan) {
    appliedPlan = proposedPlan;
    logStructured("plan_approved", { nodes: proposedPlan.intersections.length });
  }
  res.json({ ok: true, plan: appliedPlan, proposedPlan });
});

app.post("/api/plan/reject", (_req, res) => {
  proposedPlan = null;
  logStructured("plan_rejected", {});
  res.json({ ok: true, plan: appliedPlan, proposedPlan });
});

app.post("/api/optimize", async (_req, res) => {
  await runCycle();
  res.json({ ok: true, plan: appliedPlan, proposedPlan, lastOptimizeMs, fallback });
});

setInterval(() => {
  if (!evState || !emergency || evState.path.length < 2) return;
  evState.edgeProgress += 1 / EDGE_SECONDS;
  if (evState.edgeProgress >= 1) {
    evState.edgeProgress = 0;
    evState.pathIndex += 1;
    if (evState.pathIndex >= evState.path.length - 1) {
      evState.pathIndex = evState.path.length - 1;
      evState.edgeProgress = 1;
    }
  }
}, 1000);

setInterval(() => {
  tickCount += 1;
  const t0 = performance.now();
  snapshot = tickSimulation(snapshot, {
    running: simulationRunning,
    hotspotNodeId,
    appliedPlan,
    tickCount,
  });
  lastSimulationStepMs = performance.now() - t0;
  cycleCount += 1;
  logStructured("simulation_step", { ms: lastSimulationStepMs, cycle: cycleCount });
  void runCycle();
}, CYCLE_MS);

void runCycle().then(() => {
  if (!appliedPlan) {
    appliedPlan = buildStaticPlan();
  }
  app.listen(PORT, () => {
    logStructured("server_start", { port: PORT, approval: APPROVAL_REQUIRED });
    console.log(`SignalSync API http://localhost:${PORT}`);
  });
});
