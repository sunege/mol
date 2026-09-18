/**
 * Message contract between the UI thread and the DFT worker.
 *
 * Every request carries an `id` that the matching responses echo back, so a
 * single worker can serve overlapping requests (a pending isosurface redraw
 * while a new geometry is being submitted, for example).
 *
 * Coordinates crossing this boundary are always in Angstrom and energies always
 * in Hartree; the engine converts to Bohr internally. Densities are the one
 * thing left in engine units - electrons per cubic Bohr - because they are only
 * ever a threshold the user slides, never a length on screen.
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

/**
 * Which electrons a surface is asked for.
 *
 * `bonding` is a request, not an answer: the engine picks how to show where the
 * bonds are, because only it knows whether the molecule has a pi system. What it
 * chose comes back in {@link IsoMesh.channel}.
 */
export type DensityRequest = 'total' | 'bonding';

/**
 * What a surface actually shows.
 *
 * - `total` — every electron. Never negative.
 * - `pi` — the orbitals that stick out of a planar molecule's plane, which is
 *   its pi system. A density, so also never negative.
 * - `deformation` — the molecule's density minus the free atoms it is built
 *   from, which is where forming the bonds moved the electrons to and from.
 *   Signed, and the only channel with a negative surface.
 */
export type DensityChannel = 'total' | 'pi' | 'deformation';

/** One closed surface, in the layout a GPU vertex buffer wants. */
export interface SurfaceGeometry {
  /** Three coordinates per vertex, in Angstrom. */
  positions: Float32Array;
  /** Unit normals pointing out of the enclosed region, three per vertex. */
  normals: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

/**
 * The triangulated level set of one density channel.
 *
 * The density grid stays in the worker: a threshold change re-runs marching
 * cubes over a density that is already sampled and sends back only the meshes,
 * which is a few milliseconds instead of a few seconds.
 */
export interface IsoMesh {
  /** What the engine drew, which for a `bonding` request it chose itself. */
  channel: DensityChannel;
  /** The level cut, in electrons per cubic Bohr. */
  isoLevel: number;
  /** Where the density is above `+isoLevel`. */
  positive: SurfaceGeometry;
  /** Where it is below `-isoLevel`. Empty unless the channel is signed. */
  negative: SurfaceGeometry;
  /**
   * Largest sample on the lattice. Levels above it produce nothing, which is a
   * normal answer and not an error.
   */
  densityMax: number;
  /** Most negative sample, or zero for a channel that cannot go negative. */
  densityMin: number;
  /** Wall-clock milliseconds the worker spent producing these meshes. */
  elapsedMs: number;
}

export type WorkerRequest =
  | { id: number; type: 'elements' }
  | { id: number; type: 'scf'; z: Uint8Array; xyz: Float64Array }
  /** Cuts the density of the last `scf` request at a new level. */
  | { id: number; type: 'isosurface'; channel: DensityRequest; isoLevel: number };

export type WorkerResponse =
  /** Emitted once, unsolicited, when the WASM module has finished loading. */
  | { id: 0; type: 'ready' }
  | { id: number; type: 'elements'; elements: ElementInfo[] }
  | { id: number; type: 'scf'; result: ScfOutcome }
  | { id: number; type: 'mesh'; mesh: IsoMesh }
  | { id: number; type: 'error'; message: string };
