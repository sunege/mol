/**
 * Message contract between the UI thread and the DFT worker.
 *
 * Every request carries an `id` that the matching responses echo back, so a
 * single worker can serve overlapping requests (a pending isosurface redraw
 * while a new geometry is being submitted, for example).
 *
 * Most requests answer once. A geometry optimisation answers many times: a
 * `step` for every structure the engine accepts, and then one `scf` carrying the
 * final calculation. The `step` messages are what the relaxation animation is
 * made of, and they are sent as the engine produces them rather than collected
 * up, so a molecule that takes a second per step is still moving on screen while
 * it is being solved.
 *
 * Both calculations also say what they are doing while nothing moves: a
 * `progress` as each part of the work starts. Before the first step of a large
 * molecule there are several seconds of it - the integrals, the search for how
 * the electrons arrange themselves, the first forces - and without these the
 * screen would simply stand still.
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

/**
 * What a calculation is for, which decides how carefully it is solved.
 *
 * - `shape` — see what a molecule settles into. Benzene relaxes in about fifteen
 *   seconds. The default, and what every calculation was before there were
 *   levels.
 * - `measure` — read its bond lengths and angles as numbers. Several times
 *   slower; benzene takes minutes.
 *
 * The level is the only thing about the method that crosses this boundary:
 * the engine decides what each one means, like every other DFT parameter
 * (requirement F4), and a name it does not know comes back as an `error`
 * rather than being solved at the default.
 *
 * Results at different levels cannot be compared. Water solved at both has
 * total energies 1.1 Hartree apart - thousands of kJ/mol, against the few that
 * separate two structures - so an energy difference, or a ranking of
 * structures, only means something between results at one level.
 */
export type ModelLevel = 'shape' | 'measure';

/** The total energy split into its physical terms, in Hartree. */
export interface EnergyComponents {
  /** Kinetic energy plus electron-nucleus attraction. */
  core: number;
  /** Classical electron-electron repulsion. */
  coulomb: number;
  exchangeCorrelation: number;
  nuclearRepulsion: number;
}

/** How a geometry optimisation ended. */
export type OptimizationReason =
  /** Reached a stationary point: the forces and the energy change are all small. */
  | 'converged'
  /** Ran out of steps with the structure still moving. */
  | 'maxSteps'
  /** Ran out of the worker's wall-clock budget. */
  | 'interrupted'
  /** An SCF along the way found no self-consistent density for the nuclei. */
  | 'scf';

/**
 * The geometry half of an optimisation's result.
 *
 * Not reaching a minimum is an ordinary outcome rather than an error
 * (requirement F5), so this always arrives. `converged` says whether the
 * structure settled; `reason` says what stopped it, and the three ways of not
 * settling are not the same thing - see {@link hasUsableStructure}.
 */
export interface OptimizationOutcome {
  converged: boolean;
  reason: OptimizationReason;
  /** Accepted moves, not counting the structure as it was submitted. */
  steps: number;
  /**
   * The geometry the optimiser ended on, in Angstrom, flattened.
   *
   * Real whenever {@link hasUsableStructure} holds - which includes running out
   * of time, where it is simply how far the structure got.
   */
  xyz: number[];
  /** Largest remaining force, in Hartree per Angstrom. */
  maxForce: number;
}

/**
 * Whether the structure this optimisation ended on is one to keep.
 *
 * The distinction the interface turns on. Running out of time or out of steps
 * says nothing about the molecule: the electrons were solved at every geometry
 * along the way, and the structure reached is a real, partly relaxed one. Only
 * `'scf'` means the engine found no bound arrangement of electrons for these
 * nuclei, and only that is worth showing as the molecule coming apart.
 */
export function hasUsableStructure(outcome: OptimizationOutcome): boolean {
  return outcome.reason !== 'scf';
}

/** One geometry the optimiser accepted, streamed as it is produced. */
export interface OptimizationStep {
  /** Zero for the structure as submitted, then one per accepted move. */
  step: number;
  /** Coordinates in Angstrom, three per atom, ready for the frame player. */
  xyz: Float32Array;
  /** Total energy at this geometry, in Hartree. */
  energy: number;
  /** Largest force component, in Hartree per Angstrom. */
  maxForce: number;
}

/**
 * The part of a calculation the engine has just started on.
 *
 * Named for what the time is spent on, never for how: which spin states the
 * search tries and how many of them there are stay inside the engine, like
 * every other DFT parameter (requirement F4). The interface can say "working
 * out how the electrons arrange themselves" and nothing more specific, because
 * nothing more specific crosses this boundary.
 *
 * - `preparing` — the integrals and the integration grid of the structure as
 *   placed. Moves nothing and decides nothing, but costs about a second for
 *   benzene.
 * - `searching` — finding the arrangement of electrons the molecule settles
 *   into, which for a relaxation includes solving it once more on the finer
 *   grid the optimiser uses. The longest wait before anything moves.
 * - `forces` — the forces on the nuclei of geometry `step`. Step zero is the
 *   structure as placed; each later one is a move the optimiser has accepted.
 * - `solving` — the electrons at the geometry that would become `step`. A move
 *   that raised the energy is tried again shorter under the same `step`.
 *
 * A single point reports only the first two.
 */
export type CalculationProgress =
  | { stage: 'preparing' }
  | { stage: 'searching' }
  | { stage: 'forces'; step: number }
  | { stage: 'solving'; step: number };

export type CalculationStage = CalculationProgress['stage'];

/**
 * Reads the engine's `on_progress(stage, step)` into a protocol message.
 *
 * The names are the engine's (`crates/dft-wasm`, `mod stage`) and this is the
 * one place they are spelled on this side. A name it does not know is dropped
 * rather than guessed at: a missing progress line costs nothing, and a wrong
 * one would describe a calculation that is not happening.
 */
export function progressFromEngine(stage: string, step: number): CalculationProgress | null {
  switch (stage) {
    case 'preparing':
    case 'searching':
      return { stage };
    case 'forces':
    case 'solving':
      return Number.isInteger(step) && step >= 0 ? { stage, step } : null;
    default:
      return null;
  }
}

/** Result of a single-point calculation. */
export interface ScfOutcome {
  /**
   * False when no spin state the engine tried reached a self-consistent
   * density. This is a normal outcome, not an error: the UI shows it as a
   * diverging molecule rather than a message (requirement F5).
   */
  converged: boolean;
  iterations: number;
  /**
   * The spin multiplicity and charge the engine chose for itself.
   *
   * Diagnostics, not interface. Requirement F4 keeps every DFT parameter off
   * the screen, and these two must stay off it; they cross the boundary so that
   * a developer can confirm from the console that O2 was treated as a triplet,
   * and so phase 5 can hold the state fixed while the geometry moves.
   */
  multiplicity: number;
  charge: number;
  /** How many spin states were solved before one was chosen. */
  attempts: number;
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
  /**
   * Present only when this came from an `optimize` request, in which case the
   * calculation describes the *relaxed* geometry rather than the submitted one.
   */
  optimization?: OptimizationOutcome;
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
  /**
   * A single point, answering with `progress` as it goes and then one `scf`.
   *
   * `level` is the {@link ModelLevel} to solve at; omitted means `'shape'`.
   */
  | { id: number; type: 'scf'; z: Uint8Array; xyz: Float64Array; level?: ModelLevel }
  /**
   * Relaxes the structure, answering with a `step` per accepted geometry and
   * `progress` as each part of the work starts, and then one `scf` for the final
   * calculation.
   *
   * `budgetMs` stops it early: after that much wall-clock time the worker ends
   * the relaxation between steps and answers with the structure it had reached
   * and `reason: 'interrupted'`, exactly as the engine's own budget does. It is
   * how the candidate pool keeps one stuck candidate from holding a slot for the
   * length of a lecture (`web/src/search/`); the front worker sends no budget
   * and is stopped by the user instead. Omitted or null means the engine's own
   * budget is the only one.
   *
   * `level` is the {@link ModelLevel} every step is solved at; omitted means
   * `'shape'`.
   *
   * `stop` is how the user's 中止 reaches a worker that is busy: memory shared
   * with the page ({@link raiseStop}), read after every step the way the budget
   * is, and ending the relaxation the same way - `reason: 'interrupted'`, the
   * structure reached, and the calculation kept for its surface. Only a page
   * that can share memory sends one (`canStopInPlace`); without it the worker
   * is terminated instead, and only the streamed steps survive.
   */
  | {
      id: number;
      type: 'optimize';
      z: Uint8Array;
      xyz: Float64Array;
      budgetMs?: number | null;
      level?: ModelLevel;
      stop?: Int32Array | null;
    }
  /** Cuts the density of the last `scf` or `optimize` request at a new level. */
  | { id: number; type: 'isosurface'; channel: DensityRequest; isoLevel: number };

/**
 * A stop flag for an `optimize` request: one shared 32-bit word, zero until
 * the page raises it. Call only where `canStopInPlace` holds - elsewhere there
 * is no `SharedArrayBuffer` to make it from.
 */
export function stopFlag(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

/** Asks the relaxation that carries `flag` to stop after its current step. */
export function raiseStop(flag: Int32Array): void {
  Atomics.store(flag, 0, 1);
}

/**
 * Whether the page has asked the relaxation to stop. The worker reads it after
 * posting each step, so the step that ends the relaxation reaches the page
 * like every other.
 */
export function stopRequested(flag: Int32Array | null | undefined): boolean {
  return flag != null && Atomics.load(flag, 0) !== 0;
}

export type WorkerResponse =
  /** Emitted once, unsolicited, when the WASM module has finished loading. */
  | { id: 0; type: 'ready' }
  /**
   * Emitted once instead of `ready` when the WASM module could not be loaded.
   * Nothing sent to this worker afterwards can be answered.
   */
  | { id: 0; type: 'unavailable'; message: string }
  | { id: number; type: 'elements'; elements: ElementInfo[] }
  /**
   * Intermediate answers: more will follow for the same `id`. Every other
   * response type ends the request it belongs to.
   */
  | { id: number; type: 'step'; step: OptimizationStep }
  | { id: number; type: 'progress'; progress: CalculationProgress }
  | { id: number; type: 'scf'; result: ScfOutcome }
  | { id: number; type: 'mesh'; mesh: IsoMesh }
  | { id: number; type: 'error'; message: string };

/**
 * Whether a response ends the request it answers.
 *
 * The worker client keeps a request pending until one of these arrives, which is
 * what lets an optimisation stream its steps through the same correlation table
 * as every other request.
 */
export function isTerminal(response: WorkerResponse): boolean {
  return response.type !== 'step' && response.type !== 'progress';
}
