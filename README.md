# SignalSync

Hackathon build: **graph-native adaptive traffic signals** with a **Rust** optimization core, **Node/Express** orchestration, and a **Next.js** dashboard.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/) (stable) and `cargo`
- Windows: Rust produces `target/release/signal-sync-core.exe` (used by the API automatically)

## Setup

```bash
npm install
```

This builds `@signal-sync/contracts` via `postinstall`. Build the Rust binary once (or use `npm run build`):

```bash
npm run build:rust
```

## Run (development)

Terminal 1 — API (port **3001**):

```bash
npm run dev:api
```

Terminal 2 — Dashboard (port **3000**):

```bash
npm run dev:dashboard
```

Open [http://localhost:3000](http://localhost:3000). The UI polls `http://localhost:3001` by default.

### Environment (optional)

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | Dashboard API base URL (default `http://localhost:3001`) |
| `NETWORK_CONFIG_PATH` | Absolute path to a custom **network JSON** file (see below) |
| `RUST_TIMEOUT_MS` | Kill Rust optimizer after this many ms (default **50**) |
| `APPROVAL_REQUIRED=true` | New plans stay **proposed** until **Approve** in the UI |
| `EV_EDGE_SECONDS` | Seconds to traverse one edge for EV animation (default **10**) |
| `SIGNAL_SYNC_CORE_PATH` | Override path to `signal-sync-core` binary |

### Road network (not hard-coded in code)

The city graph is loaded from [`services/api/data/network.json`](services/api/data/network.json): nodes (positions, zones, tags), directed edges (capacity, arterial flag, approach). Change that file to change topology without editing TypeScript.

### Structured logs

JSON lines are appended to `services/api/logs/signal-sync.jsonl` (created automatically).

## Behavior (high level)

- **Simulation**: flow-based updates (demand, signal-limited outflow, downstream spill, rush-hour multiplier, commercial/hospital bumps). Hotspot **injects** extra demand on incident links (no naive global multiply).
- **Forecast**: last **5** queue samples per edge; slight weight adjustment toward trend before Rust runs.
- **Rust**: routing cost `avg_wait_time + queue_length / capacity`; **weighted Dijkstra** for emergency route and pressure path; phases from directional congestion weights.
- **Emergency**: full route returned as `emergency_route_path`; API advances an **EV** marker along the path; ETA proxy before/after preemption.
- **Operator approval** (when `APPROVAL_REQUIRED=true`): **Proposed** vs **Active** tables; **Reject** drops the proposal; **Approve** applies it.
- On Rust timeout/error, the API keeps the **last applied** plan or **static** equal splits.

## Production build

```bash
npm run build
npm run start -w @signal-sync/api
npm run start -w @signal-sync/dashboard
```

## Layout

| Path | Role |
|------|------|
| `packages/contracts` | Shared TypeScript types (mirrors Rust JSON) |
| `crates/signal-sync-core` | Rust library + binary: stdin JSON → stdout JSON |
| `services/api/data/network.json` | City graph definition |
| `services/api` | Express, simulation, forecast, metrics, logs, data-source interface |
| `apps/dashboard` | Next.js + Tailwind dashboard |

## License

MIT (adjust as needed for your hackathon submission).
