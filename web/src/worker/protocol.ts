/**
 * Message contract between the UI thread and the DFT worker.
 *
 * Every request carries an `id` that the matching responses echo back, so a
 * single worker can serve overlapping requests (a pending isosurface redraw
 * while a new geometry is being submitted, for example).
 *
 * Coordinates crossing this boundary are always in Angstrom and energies always
 * in Hartree; the engine converts to Bohr internally.
 */

export interface ElementInfo {
  z: number;
  symbol: string;
  mass: number;
  covalentRadius: number;
  vdwRadius: number;
  /** Packed 0xRRGGBB, as Three.js Color accepts. */
  color: number;
}

/** The total energy split into its physical terms, in Hartree. */
export interface EnergyComponents {
  /** Kinetic energy plus electron-nucleus attraction. */
  core: number;
  /** Classical electron-electron repulsion. */
  coulomb: number;
  exchangeCorrelation: number;
  nuclearRepulsion: number;
}

/** Result of a single-point calculation. */
export interface ScfOutcome {
  /**
   * False when the iteration limit was reached. This is a normal outcome, not an
   * error: from phase 4 on the UI shows it as a diverging molecule rather than a
   * message (requirement F5).
   */
  converged: boolean;
  iterations: number;
  /** Total energy in Hartree. */
  energy: number;
  components: EnergyComponents;
  /** Occupied-empty orbital gap in Hartree, null when the basis is full. */
  homoLumoGap: number | null;
  basisFunctions: number;
  /**
   * Electrons the integration grid accounts for. The gap to the true electron
   * count is the quadrature error, and is a useful health check on the grid.
   */
  electronsOnGrid: number;
  /** Wall-clock milliseconds spent inside the engine, measured by the worker. */
  elapsedMs: number;
}

export type WorkerRequest =
  | { id: number; type: 'elements' }
  | { id: number; type: 'scf'; z: Uint8Array; xyz: Float64Array };

export type WorkerResponse =
  /** Emitted once, unsolicited, when the WASM module has finished loading. */
  | { id: 0; type: 'ready' }
  | { id: number; type: 'elements'; elements: ElementInfo[] }
  | { id: number; type: 'scf'; result: ScfOutcome }
  | { id: number; type: 'error'; message: string };
