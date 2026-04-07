import type { GraphSnapshot } from "@signal-sync/contracts";

/** Pluggable input: simulation today, real sensors tomorrow. */
export interface TrafficDataSource {
  getGraphState(): GraphSnapshot;
}

export class SimulationDataSource implements TrafficDataSource {
  constructor(private readonly getter: () => GraphSnapshot) {}

  getGraphState(): GraphSnapshot {
    return this.getter();
  }
}

/** Stub for future ANPR / loop detector feeds. */
export class RealSensorDataSource implements TrafficDataSource {
  getGraphState(): GraphSnapshot {
    throw new Error(
      "RealSensorDataSource is not wired — implement getGraphState() with live sensor ingestion."
    );
  }
}
