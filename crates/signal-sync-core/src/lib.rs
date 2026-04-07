use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    N,
    E,
    S,
    W,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub approach: Direction,
    #[serde(default)]
    pub queue_length: f64,
    #[serde(default)]
    pub avg_wait_time: f64,
    #[serde(default = "default_capacity")]
    pub capacity: f64,
    #[serde(default)] // Let Rust read the flag! Defaults to false if missing.
    pub arterial: bool, 
}

fn default_capacity() -> f64 {
    50.0
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GraphSnapshot {
    pub timestamp_ms: u64,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EmergencyRouteRequest {
    pub current_node_id: String,
    pub destination_node_id: String,
    #[serde(default)]
    pub speed_mps: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OptimizeInput {
    pub snapshot: GraphSnapshot,
    #[serde(default)]
    pub emergency: Option<EmergencyRouteRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IntersectionPhasePlan {
    pub id: String,
    pub phases: Phases,
    pub cycle_seconds: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Phases {
    pub n: u32,
    pub e: u32,
    pub s: u32,
    pub w: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SignalPlan {
    pub intersections: Vec<IntersectionPhasePlan>,
    pub pressure_path: Vec<String>,
    pub emergency_preemption_nodes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emergency_route_path: Option<Vec<String>>,
    pub compute_us: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OptimizeOutput {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<SignalPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

const CYCLE: u32 = 60;
const MIN_PHASE: u32 = 5;
const MAX_PHASE: u32 = 45;

/// Travel / routing cost: favors uncongested, high-capacity links.
pub fn routing_cost(e: &GraphEdge) -> f64 {
    let cap = e.capacity.max(1.0);
    
    // 1. The traffic delay
    let traffic_delay = e.avg_wait_time.max(0.0) + e.queue_length.max(0.0) / cap;
    
    // 2. The base traversal cost (even if empty, it takes time to drive down a road)
    // We give arterial roads a lower base cost to make them the preferred default path.
    let base_cost = if e.arterial { 1.0 } else { 3.0 }; 
    
    // Alternatively, you could factor capacity directly into the base cost:
    // let base_cost = 100.0 / cap; 

    base_cost + traffic_delay
}

fn phase_weight(e: &GraphEdge) -> f64 {
    (routing_cost(e) * e.queue_length.max(0.0)).min(1_000_000.0)
}

fn clamp_outliers(weights: &[f64]) -> Vec<f64> {
    if weights.is_empty() {
        return vec![];
    }
    let mean: f64 = weights.iter().sum::<f64>() / weights.len() as f64;
    let var: f64 = weights
        .iter()
        .map(|x| (x - mean).powi(2))
        .sum::<f64>()
        / weights.len() as f64;
    let sigma = var.sqrt().max(1.0);
    weights
        .iter()
        .map(|x| {
            let hi = mean + 3.0 * sigma;
            let lo = (mean - 3.0 * sigma).max(0.0);
            x.clamp(lo, hi)
        })
        .collect()
}

fn dir_key(d: &Direction) -> &'static str {
    match d {
        Direction::N => "n",
        Direction::E => "e",
        Direction::S => "s",
        Direction::W => "w",
    }
}

fn aggregate_by_node(edges: &[GraphEdge], weights: &[f64]) -> HashMap<String, HashMap<String, f64>> {
    let mut m: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for (e, &wt) in edges.iter().zip(weights.iter()) {
        let entry = m.entry(e.to.clone()).or_default();
        let k = dir_key(&e.approach).to_string();
        *entry.entry(k).or_insert(0.0) += wt;
    }
    m
}

fn proportional_phases(weights_by_dir: &HashMap<String, f64>) -> Phases {
    let dirs = ["n", "e", "s", "w"];
    let mut w = [0.0f64; 4];
    for (i, d) in dirs.iter().enumerate() {
        w[i] = weights_by_dir.get(*d).copied().unwrap_or(0.0) + 1.0;
    }
    let sum: f64 = w.iter().sum();
    let raw: Vec<u32> = w
        .iter()
        .map(|x| ((CYCLE as f64) * x / sum).round() as u32)
        .collect();
    let mut phases = Phases {
        n: raw[0].max(MIN_PHASE).min(MAX_PHASE),
        e: raw[1].max(MIN_PHASE).min(MAX_PHASE),
        s: raw[2].max(MIN_PHASE).min(MAX_PHASE),
        w: raw[3].max(MIN_PHASE).min(MAX_PHASE),
    };
    let mut total = phases.n + phases.e + phases.s + phases.w;
    while total > CYCLE {
        let arr = [
            ("n", phases.n),
            ("e", phases.e),
            ("s", phases.s),
            ("w", phases.w),
        ];
        let (k, v) = arr.iter().max_by_key(|(_, v)| *v).unwrap();
        if *v > MIN_PHASE {
            match *k {
                "n" => phases.n -= 1,
                "e" => phases.e -= 1,
                "s" => phases.s -= 1,
                "w" => phases.w -= 1,
                _ => break,
            }
            total -= 1;
        } else {
            break;
        }
    }
    while total < CYCLE {
        let arr = [
            ("n", phases.n),
            ("e", phases.e),
            ("s", phases.s),
            ("w", phases.w),
        ];
        let (k, v) = arr.iter().min_by_key(|(_, v)| *v).unwrap();
        if *v < MAX_PHASE {
            match *k {
                "n" => phases.n += 1,
                "e" => phases.e += 1,
                "s" => phases.s += 1,
                "w" => phases.w += 1,
                _ => break,
            }
            total += 1;
        } else {
            break;
        }
    }
    phases
}

/// Weighted shortest path (directed edges). Cost per edge = `routing_cost`.
fn dijkstra_path_weighted(
    edges: &[GraphEdge],
    start: &str,
    goal: &str,
    id_to_idx: &HashMap<String, usize>,
    idx_to_id: &[String],
) -> Option<Vec<String>> {
    let n = idx_to_id.len();
    let start_i = *id_to_idx.get(start)?;
    let goal_i = *id_to_idx.get(goal)?;
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
    for e in edges {
        let a = id_to_idx.get(&e.from)?;
        let b = id_to_idx.get(&e.to)?;
        adj[*a].push((*b, routing_cost(e)));
    }
    let mut dist = vec![f64::INFINITY; n];
    let mut prev: Vec<Option<usize>> = vec![None; n];
    dist[start_i] = 0.0;
    let mut done = vec![false; n];
    for _ in 0..n {
        let mut best = f64::INFINITY;
        let mut u: Option<usize> = None;
        for i in 0..n {
            if !done[i] && dist[i] < best {
                best = dist[i];
                u = Some(i);
            }
        }
        let u = u?;
        if u == goal_i {
            break;
        }
        if best.is_infinite() {
            break;
        }
        done[u] = true;
        for &(v, w) in &adj[u] {
            let nd = dist[u] + w;
            if nd < dist[v] {
                dist[v] = nd;
                prev[v] = Some(u);
            }
        }
    }
    if dist[goal_i].is_infinite() {
        return None;
    }
    let mut path = vec![goal_i];
    let mut cur = goal_i;
    while let Some(p) = prev[cur] {
        path.push(p);
        cur = p;
    }
    path.reverse();
    Some(path.into_iter().map(|i| idx_to_id[i].clone()).collect())
}

fn pressure_path_nodes(
    edges: &[GraphEdge],
    weights: &[f64],
    id_to_idx: &HashMap<String, usize>,
    idx_to_id: &[String],
) -> Vec<String> {
    if edges.is_empty() {
        return vec![];
    }
    let mut best_edge: Option<(f64, usize)> = None;
    for (i, &w) in weights.iter().enumerate() {
        best_edge = Some(match best_edge {
            None => (w, i),
            Some((bw, bi)) if w > bw => (w, i),
            Some(x) => x,
        });
    }
    let start = edges[best_edge.unwrap().1].from.clone();
    let mut agg: HashMap<String, f64> = HashMap::new();
    for (e, &w) in edges.iter().zip(weights.iter()) {
        *agg.entry(e.to.clone()).or_insert(0.0) += w;
    }
    let mut sink = start.clone();
    let mut best = -1.0f64;
    for (node, &sum) in &agg {
        if sum > best {
            best = sum;
            sink = node.clone();
        }
    }
    dijkstra_path_weighted(edges, &start, &sink, id_to_idx, idx_to_id).unwrap_or_else(|| vec![start])
}

fn approach_for_edge(from: &str, to: &str, edges: &[GraphEdge]) -> Option<Direction> {
    edges
        .iter()
        .find(|e| e.from == from && e.to == to)
        .map(|e| e.approach.clone())
}

fn apply_emergency_preemption(
    plan: &mut Vec<IntersectionPhasePlan>,
    path: &[String],
    edges: &[GraphEdge],
) {
    if path.len() < 2 {
        return;
    }
    for window in path.windows(2).take(3) {
        let from = &window[0];
        let to = &window[1];
        let Some(dir) = approach_for_edge(from, to, edges) else {
            continue;
        };
        let dk = dir_key(&dir);
        for inter in plan.iter_mut() {
            if inter.id == *to {
                let p = &mut inter.phases;
                p.n = MIN_PHASE;
                p.e = MIN_PHASE;
                p.s = MIN_PHASE;
                p.w = MIN_PHASE;
                match dk {
                    "n" => p.n = MAX_PHASE,
                    "e" => p.e = MAX_PHASE,
                    "s" => p.s = MAX_PHASE,
                    "w" => p.w = MAX_PHASE,
                    _ => {}
                }
                let mut tot = p.n + p.e + p.s + p.w;
                while tot < CYCLE {
                    match dk {
                        "n" => p.n += 1,
                        "e" => p.e += 1,
                        "s" => p.s += 1,
                        "w" => p.w += 1,
                        _ => {}
                    }
                    tot += 1;
                }
                while tot > CYCLE {
                    let ok = match dk {
                        "n" => p.n > MIN_PHASE,
                        "e" => p.e > MIN_PHASE,
                        "s" => p.s > MIN_PHASE,
                        "w" => p.w > MIN_PHASE,
                        _ => false,
                    };
                    if !ok {
                        break;
                    }
                    match dk {
                        "n" => p.n -= 1,
                        "e" => p.e -= 1,
                        "s" => p.s -= 1,
                        "w" => p.w -= 1,
                        _ => {}
                    }
                    tot -= 1;
                }
            }
        }
    }
}

pub fn run_opt(input: OptimizeInput) -> OptimizeOutput {
    let start = std::time::Instant::now();
    let snapshot = input.snapshot;
    let mut id_to_idx: HashMap<String, usize> = HashMap::new();
    let mut idx_to_id: Vec<String> = Vec::new();
    for n in &snapshot.nodes {
        let i = idx_to_id.len();
        id_to_idx.insert(n.id.clone(), i);
        idx_to_id.push(n.id.clone());
    }
    let raw_weights: Vec<f64> = snapshot.edges.iter().map(|e| phase_weight(e)).collect();
    let weights = clamp_outliers(&raw_weights);
    let by_node = aggregate_by_node(&snapshot.edges, &weights);
    let mut intersections: Vec<IntersectionPhasePlan> = snapshot
        .nodes
        .iter()
        .map(|node| {
            let wmap = by_node.get(&node.id).cloned().unwrap_or_default();
            let phases = proportional_phases(&wmap);
            IntersectionPhasePlan {
                id: node.id.clone(),
                phases,
                cycle_seconds: CYCLE,
            }
        })
        .collect();
    let pressure_path = pressure_path_nodes(&snapshot.edges, &weights, &id_to_idx, &idx_to_id);
    let mut emergency_nodes = vec![];
    let mut emergency_route_path: Option<Vec<String>> = None;
    if let Some(ref em) = input.emergency {
        if let Some(path) = dijkstra_path_weighted(
            &snapshot.edges,
            &em.current_node_id,
            &em.destination_node_id,
            &id_to_idx,
            &idx_to_id,
        ) {
            emergency_route_path = Some(path.clone());
            for node in path.iter().skip(1).take(3) {
                emergency_nodes.push(node.clone());
            }
            apply_emergency_preemption(&mut intersections, &path, &snapshot.edges);
        }
    }
    let compute_us = start.elapsed().as_micros() as u64;
    OptimizeOutput {
        ok: true,
        plan: Some(SignalPlan {
            intersections,
            pressure_path,
            emergency_preemption_nodes: emergency_nodes,
            emergency_route_path,
            compute_us,
        }),
        error: None,
    }
}
