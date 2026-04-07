"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GraphEdge, GraphSnapshot, SignalPlan } from "@signal-sync/contracts";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type EmergencyVehicleApi = {
  active: boolean;
  path: string[];
  path_index: number;
  edge_progress: number;
  eta_seconds_before: number | null;
  eta_seconds_after: number | null;
};

type MetricsApi = {
  avgWaitGlobal: number;
  /** Shadow baseline (fixed timing) metrics for A/B comparison. */
  avgWaitShadow: number | null;
  maxCongestionEdgeId: string;
  maxCongestionLoad: number;
  totalVehicles: number;
  totalVehiclesShadow: number | null;
  etaBefore: number | null;
  etaAfter: number | null;
  baselineAvgWait: number | null;
  avgWaitDeltaVsBaseline: number | null;
  avgWaitDeltaVsShadow: number | null;
};

type Capabilities = Record<string, boolean>;

type ApiState = {
  snapshot: GraphSnapshot;
  plan: SignalPlan | null;
  proposedPlan: SignalPlan | null;
  approvalRequired: boolean;
  capabilities?: Capabilities;
  simulationRunning: boolean;
  hotspotNodeId: string | null;
  emergency: { current_node_id: string; destination_node_id: string } | null;
  lastOptimizeMs: number;
  lastComputeUs: number;
  lastSimulationStepMs: number;
  fallback: string;
  cycleSeconds: number;
  cycleCount: number;
  metrics: MetricsApi;
  emergencyVehicle: EmergencyVehicleApi;
};

function edgeLoad(e: GraphEdge): number {
  const cap = e.capacity ?? 1;
  return (e.queue_length / cap) * e.avg_wait_time;
}

function evPosition(
  nodes: GraphSnapshot["nodes"],
  ev: EmergencyVehicleApi
): { x: number; y: number } | null {
  if (!ev.active || ev.path.length < 1) return null;
  if (ev.path.length === 1) {
    const n = nodes.find((x) => x.id === ev.path[0]);
    return n?.x != null && n?.y != null ? { x: n.x, y: n.y } : null;
  }
  const i = Math.min(ev.path_index, ev.path.length - 1);
  const fromId = ev.path[i];
  const toId = ev.path[Math.min(i + 1, ev.path.length - 1)];
  const a = nodes.find((n) => n.id === fromId);
  const b = nodes.find((n) => n.id === toId);
  if (a?.x == null || a?.y == null || b?.x == null || b?.y == null) return null;
  if (i >= ev.path.length - 1) return { x: b.x, y: b.y };
  const p = ev.edge_progress;
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
}

export default function Home() {
  const [state, setState] = useState<ApiState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [customFrom, setCustomFrom] = useState<string>("A");
  const [customTo, setCustomTo] = useState<string>("H");

  const fetchState = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/state`);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as ApiState;
      setState(j);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void fetchState();
    const id = setInterval(() => void fetchState(), 1000);
    return () => clearInterval(id);
  }, [fetchState]);

  const post = async (path: string, body?: object) => {
    await fetch(`${API}${path}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    void fetchState();
  };

  const viewBox = useMemo(() => {
    if (!state?.snapshot.nodes.length) return "0 0 520 420";
    let maxX = 0;
    let maxY = 0;
    for (const n of state.snapshot.nodes) {
      if (n.x != null) maxX = Math.max(maxX, n.x);
      if (n.y != null) maxY = Math.max(maxY, n.y);
    }
    return `0 0 ${maxX + 60} ${maxY + 60}`;
  }, [state?.snapshot.nodes]);

  const maxLoad = useMemo(() => {
    if (!state?.snapshot.edges.length) return 1;
    return Math.max(...state.snapshot.edges.map(edgeLoad), 1);
  }, [state]);

  const appliedById = useMemo(() => {
    const m = new Map<string, SignalPlan["intersections"][0]>();
    state?.plan?.intersections.forEach((p) => m.set(p.id, p));
    return m;
  }, [state?.plan]);

  const proposedById = useMemo(() => {
    const m = new Map<string, SignalPlan["intersections"][0]>();
    state?.proposedPlan?.intersections.forEach((p) => m.set(p.id, p));
    return m;
  }, [state?.proposedPlan]);

  const pressureSet = useMemo(
    () => new Set(state?.plan?.pressure_path ?? []),
    [state?.plan?.pressure_path]
  );
  const preemptSet = useMemo(
    () => new Set(state?.plan?.emergency_preemption_nodes ?? []),
    [state?.plan?.emergency_preemption_nodes]
  );

  const evPos = state ? evPosition(state.snapshot.nodes, state.emergencyVehicle) : null;
  const nodeIds = useMemo(() => (state?.snapshot.nodes ?? []).map((n) => n.id), [state?.snapshot.nodes]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex flex-col gap-2 border-b border-slate-800 pb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-white">SignalSync</h1>
        <p className="text-slate-400">
          Living city network · flow simulation · weighted routing · forecast layer · operator approval
        </p>
        {err && <p className="text-amber-400">API: {err}</p>}
        {state?.capabilities && (
          <p className="text-xs text-slate-500">
            Backend: weighted routing · flow sim · forecast · EV · metrics · logs ·{" "}
            <span className="text-slate-400">
              {state.approvalRequired ? "approval required" : "auto-apply plans"}
            </span>
            {" · "}
            <a className="text-blue-400 underline" href={`${API}/api/info`} target="_blank" rel="noreferrer">
              /api/info
            </a>
          </p>
        )}
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
          <p className="text-xs uppercase text-slate-500">Avg wait (global)</p>
          <p className="text-2xl font-semibold text-white">
            {state?.metrics.avgWaitGlobal != null ? state.metrics.avgWaitGlobal.toFixed(1) : "—"}s
          </p>
          {state?.metrics.avgWaitShadow != null ? (
            <p className="mt-1 text-xs text-slate-500">
              vs fixed-timing{" "}
              <span className="font-mono text-slate-200">{state.metrics.avgWaitShadow.toFixed(1)}s</span>{" "}
              {state.metrics.avgWaitDeltaVsShadow != null ? (
                <>
                  (
                  <span
                    className={
                      state.metrics.avgWaitDeltaVsShadow > 0 ? "text-amber-400" : "text-emerald-400"
                    }
                  >
                    {state.metrics.avgWaitDeltaVsShadow > 0 ? "+" : ""}
                    {state.metrics.avgWaitDeltaVsShadow.toFixed(1)}s
                  </span>
                  )
                </>
              ) : null}
            </p>
          ) : state?.metrics.avgWaitDeltaVsBaseline != null && state.metrics.baselineAvgWait != null ? (
            <p className="mt-1 text-xs text-slate-500">
              vs baseline {state.metrics.baselineAvgWait.toFixed(1)}s (
              <span
                className={
                  state.metrics.avgWaitDeltaVsBaseline > 0 ? "text-amber-400" : "text-emerald-400"
                }
              >
                {state.metrics.avgWaitDeltaVsBaseline > 0 ? "+" : ""}
                {state.metrics.avgWaitDeltaVsBaseline.toFixed(1)}s
              </span>
              )
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-600">Baseline captured when sim starts</p>
          )}
        </div>
        <div className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
          <p className="text-xs uppercase text-slate-500">Max congestion edge</p>
          <p className="truncate font-mono text-sm text-amber-200">{state?.metrics.maxCongestionEdgeId ?? "—"}</p>
          <p className="text-xs text-slate-500">
            load {state?.metrics.maxCongestionLoad != null ? state.metrics.maxCongestionLoad.toFixed(0) : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
          <p className="text-xs uppercase text-slate-500">Vehicles (system)</p>
          <p className="text-2xl font-semibold text-white">
            {state?.metrics.totalVehicles != null ? state.metrics.totalVehicles.toFixed(0) : "—"}
          </p>
          {state?.metrics.totalVehiclesShadow != null ? (
            <p className="mt-1 text-xs text-slate-500">
              fixed-timing{" "}
              <span className="font-mono text-slate-200">{state.metrics.totalVehiclesShadow.toFixed(0)}</span>
            </p>
          ) : null}
        </div>
        <div className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
          <p className="text-xs uppercase text-slate-500">Emergency ETA (proxy)</p>
          <p className="text-sm text-slate-300">
            before:{" "}
            <span className="font-mono text-white">
              {state?.metrics.etaBefore != null ? `${state.metrics.etaBefore.toFixed(1)}s` : "—"}
            </span>
          </p>
          <p className="text-sm text-slate-300">
            after:{" "}
            <span className="font-mono text-emerald-400">
              {state?.metrics.etaAfter != null ? `${state.metrics.etaAfter.toFixed(1)}s` : "—"}
            </span>
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4 lg:col-span-2">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-slate-500">
            Live network
          </h2>
          <div className="relative h-[380px] w-full rounded-lg bg-slate-950/50">
            {state && (
              <svg className="absolute inset-0 h-full w-full" viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
                {state.snapshot.edges.map((e) => {
                  const a = state.snapshot.nodes.find((n) => n.id === e.from);
                  const b = state.snapshot.nodes.find((n) => n.id === e.to);
                  if (a?.x == null || b?.x == null) return null;
                  const load = edgeLoad(e) / maxLoad;
                  const stroke = `hsl(${120 - load * 120} 70% 50%)`;
                  const w = 2 + load * 8;
                  return (
                    <line
                      key={e.edge_id ?? `${e.from}-${e.to}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={stroke}
                      strokeWidth={w}
                      strokeLinecap="round"
                      opacity={0.85}
                    />
                  );
                })}
                {state.snapshot.nodes.map((n) => {
                  if (n.x == null || n.y == null) return null;
                  const active = pressureSet.has(n.id) || preemptSet.has(n.id);
                  const fill = preemptSet.has(n.id)
                    ? "#f59e0b"
                    : pressureSet.has(n.id)
                      ? "#22c55e"
                      : n.tags?.includes("hospital")
                        ? "#be123c"
                        : "#1e3a5f";
                  return (
                    <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                      <circle
                        r={active ? 22 : n.tags?.includes("hospital") ? 20 : 18}
                        fill={fill}
                        stroke="#e2e8f0"
                        strokeWidth={1.5}
                      />
                      <text
                        textAnchor="middle"
                        dy="0.35em"
                        fill="white"
                        className="text-sm font-semibold"
                      >
                        {n.label ?? n.id}
                      </text>
                    </g>
                  );
                })}
                {evPos && (
                  <g transform={`translate(${evPos.x},${evPos.y})`}>
                    <circle r={10} fill="#fbbf24" stroke="#0f172a" strokeWidth={2} />
                    <text textAnchor="middle" dy="4" className="text-[10px] font-bold" fill="#0f172a">
                      EV
                    </text>
                  </g>
                )}
              </svg>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Edge thickness: congestion proxy (queue/capacity × wait). Hospital node in red. EV marker follows
            weighted route.
          </p>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-slate-500">
              Performance
            </h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Fallback</dt>
                <dd className="font-mono text-emerald-400">{state?.fallback ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">API optimize</dt>
                <dd className="font-mono">
                  {state?.lastOptimizeMs != null ? `${state.lastOptimizeMs.toFixed(1)} ms` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Rust compute</dt>
                <dd className="font-mono">
                  {state?.lastComputeUs != null ? `${state.lastComputeUs} µs` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Sim step</dt>
                <dd className="font-mono">
                  {state?.lastSimulationStepMs != null ? `${state.lastSimulationStepMs.toFixed(2)} ms` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Cycles</dt>
                <dd className="font-mono">{state?.cycleCount ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Simulation</dt>
                <dd>{state?.simulationRunning ? "running" : "stopped"}</dd>
              </div>
            </dl>
          </div>

          {state?.approvalRequired && (
            <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-4">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wider text-amber-200">
                Operator approval
              </h2>
              <p className="mb-3 text-xs text-amber-100/80">
                Review proposed timings, then apply or keep the previous active plan.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                  onClick={() => void post("/api/plan/approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                  onClick={() => void post("/api/plan/reject")}
                >
                  Reject
                </button>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-slate-500">
              Controls
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
                onClick={() => void post("/api/simulation/start")}
              >
                Start
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                onClick={() => void post("/api/simulation/stop")}
              >
                Stop
              </button>
              <button
                type="button"
                className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200 hover:bg-amber-950/70"
                onClick={() => void post("/api/hotspot", { nodeId: "C" })}
              >
                Hotspot C (commercial)
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                onClick={() => void post("/api/hotspot", { nodeId: null })}
              >
                Clear hotspot
              </button>
              <button
                type="button"
                className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
                onClick={() =>
                  void post("/api/emergency", {
                    current_node_id: "A",
                    destination_node_id: "E",
                  })
                }
              >
                EV A→E (arterial)
              </button>
              <button
                type="button"
                className="rounded-lg bg-rose-800 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700"
                onClick={() =>
                  void post("/api/emergency", {
                    current_node_id: "C",
                    destination_node_id: "H",
                  })
                }
              >
                EV C→H (hospital)
              </button>
              <div className="mt-2 w-full rounded-lg border border-slate-700/80 bg-slate-950/40 p-2">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Custom EV route
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-400">
                    From{" "}
                    <select
                      className="ml-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                    >
                      {nodeIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-400">
                    To{" "}
                    <select
                      className="ml-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                    >
                      {nodeIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="rounded-lg bg-yellow-500 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-yellow-400 disabled:opacity-50"
                    disabled={!customFrom || !customTo || customFrom === customTo}
                    onClick={() =>
                      void post("/api/emergency", {
                        current_node_id: customFrom,
                        destination_node_id: customTo,
                      })
                    }
                  >
                    Dispatch EV
                  </button>
                  <span className="text-xs text-slate-500">
                    Route appears in Proposed plan + EV marker.
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                onClick={async () => {
                  await fetch(`${API}/api/emergency`, { method: "DELETE" });
                  void fetchState();
                }}
              >
                Clear EV
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                onClick={() => void post("/api/optimize")}
              >
                Optimize now
              </button>
            </div>
          </div>
        </aside>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-slate-500">
            Active plan (applied)
          </h2>
          <PlanTable nodes={state?.snapshot.nodes} planById={appliedById} />
          {state?.plan?.pressure_path?.length ? (
            <p className="mt-3 text-xs text-slate-500">
              Pressure path: {state.plan.pressure_path.join(" → ")}
            </p>
          ) : null}
          {state?.plan?.emergency_preemption_nodes?.length ? (
            <p className="mt-1 text-xs text-amber-400/90">
              Emergency preemption: {state.plan.emergency_preemption_nodes.join(", ")}
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-800 bg-[var(--panel)] p-4">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-slate-500">
            Proposed plan (optimizer)
          </h2>
          <PlanTable nodes={state?.snapshot.nodes} planById={proposedById} />
          {state?.proposedPlan?.emergency_route_path?.length ? (
            <p className="mt-3 text-xs text-slate-500">
              Emergency route: {state.proposedPlan.emergency_route_path.join(" → ")}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function PlanTable({
  nodes,
  planById,
}: {
  nodes: GraphSnapshot["nodes"] | undefined;
  planById: Map<string, SignalPlan["intersections"][0]>;
}) {
  if (!nodes?.length) return <p className="text-sm text-slate-500">No graph</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700 text-slate-500">
            <th className="py-2 pr-4">Node</th>
            <th className="py-2 pr-4">N</th>
            <th className="py-2 pr-4">E</th>
            <th className="py-2 pr-4">S</th>
            <th className="py-2 pr-4">W</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const p = planById.get(n.id);
            return (
              <tr key={n.id} className="border-b border-slate-800/80">
                <td className="py-2 font-medium">{n.id}</td>
                <td className="font-mono">{p?.phases.n ?? "—"}</td>
                <td className="font-mono">{p?.phases.e ?? "—"}</td>
                <td className="font-mono">{p?.phases.s ?? "—"}</td>
                <td className="font-mono">{p?.phases.w ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
