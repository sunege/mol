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
   * Whether this molecule has electrons standing above and below a plane.
   *
   * Unlike the three fields above, this is not a DFT parameter and is not kept
   * off the screen: being flat is geometry, and the user is looking at it. It
   * crosses the boundary because only the engine can say whether the
   * reflection really is a symmetry of these orbitals, and it is what decides
   * whether the pi surface is offered at all - a molecule without one has
   * nothing to draw for it (`DensityRequest`).
   */
  hasPi: boolean;
  /**
   * Present only when this came from an `optimize` request, in which case the
   * calculation describes the *relaxed* geometry rather than the submitted one.
   */
  optimization?: OptimizationOutcome;
  /** Wall-clock milliseconds spent inside the engine, measured by the worker. */
  elapsedMs: number;
}

/**
 * Which spin a set of orbitals belongs to.
 *
 * `both` is the only one most molecules have: their electrons are paired, so
 * one set of orbitals holds two each and there is nothing to keep apart. A
 * molecule with unpaired electrons is solved as two sets, and those are
 * genuinely different orbitals rather than two labels for the same ones - in O2
 * the same pi* sits about 0.08 Hartree lower in one set than in the other - so
 * they are never folded together. {@link OrbitalLevel.partner} is how the two
 * are lined up, and it is not the index: O2's orbitals come out in a different
 * order in each set.
 */
export type SpinChannel = 'both' | 'up' | 'down';

/**
 * One rung of the orbital ladder: an orbital, or the several that share a level.
 *
 * Degenerate orbitals arrive as one rung rather than several, because a single
 * one of them is not something the molecule has: what the diagonalisation
 * returns inside a degenerate set is an arbitrary rotation of it, so the set is
 * the smallest thing that can honestly be shown. `count` is how many there are
 * and `first` is the lowest of them, which together name every orbital of the
 * rung - `first` to `first + count - 1`, as the `orbital` of an
 * {@link WorkerRequest} isosurface.
 *
 * The rungs arrive lowest first, and for an open-shell molecule all of one
 * spin's and then all of the other's; `spin` says which, and is `'both'` for
 * every rung of a closed-shell molecule.
 */
export interface OrbitalLevel {
  spin: SpinChannel;
  /** Index of the lowest orbital on this rung, within its own spin channel. */
  first: number;
  /** Orbitals on it: one, or more where they are degenerate. */
  count: number;
  /**
   * Electrons in one of them - not in the rung. Two or zero where `spin` is
   * `'both'`, one or zero otherwise.
   */
  occupation: number;
  /**
   * Orbital energy in Hartree, which sets how high the rung is drawn and
   * nothing else.
   *
   * Not a number to put on the screen, for the same reason as
   * {@link ScfOutcome.multiplicity} is not: LDA's orbital energies are out by a
   * factor of several - water's highest occupied orbital comes out at -1.6 eV
   * against an ionisation energy of 12.6 eV - so the value would be wrong while
   * the picture built from the differences is right. Only spacings and order
   * mean anything.
   */
  energy: number;
  /**
   * `1` for a rung symmetric about the molecular plane, `-1` for a pi rung, and
   * `null` where the question does not arise.
   *
   * `null` covers a molecule with no plane to reflect in - which includes every
   * molecule of three atoms or fewer, since any three atoms lie in some plane
   * and picking one of them would sort a diatomic's orbitals by a symmetry it
   * does not have - as well as a geometry the reflection turns out not to be a
   * symmetry of.
   */
  parity: 1 | -1 | null;
  /**
   * Inversion through the midpoint: `1` for a gerade rung, `-1` for an
   * ungerade one, and `null` for anything but a homonuclear diatomic (V4-10).
   *
   * For two like atoms this is what the textbook's star means - sigma_g and
   * pi_u are bonding, sigma_u and pi_g antibonding - and it is a symmetry, where
   * the overlap population is a reading: nitrogen's highest occupied orbital
   * comes out slightly negative there and is still the bonding 3sigma_g.
   */
  inversion: 1 | -1 | null;
  /**
   * The rung of the other spin that is the same orbital, as an index into the
   * array these came in.
   *
   * `null` for a closed-shell molecule, where there is no other spin, and for
   * an orbital whose counterpart cannot be named - the two spins' orbitals are
   * matched by how much they overlap rather than by their position in the
   * ladder, and where that matching is not one-to-one there is no answer to
   * give.
   */
  partner: number | null;
}

/**
 * What one orbital does to the bonds, and where its sign changes along them.
 *
 * Numbers, not a verdict. Which pairs of atoms are bonded is the interface's own
 * guess from the geometry (`scene/bonds.ts`) and the engine has never seen it,
 * so the whole matrix crosses and the interface reads the pairs it draws out of
 * it. What reaches the screen from either array is the sign and the size in
 * words - "strengthens this bond", "weakens it", "does nothing to it" - and
 * never a number, for the same reason an orbital energy is never one
 * ({@link OrbitalLevel.energy}): the Mulliken population is a convention for
 * dividing electrons between atoms rather than a measurement, and it moves by a
 * factor of two with the basis (`docs/dev-notes.md`, "v4-0 の実測").
 */
export interface OrbitalCharacter {
  /**
   * Mulliken overlap population for every pair of nuclei, row-major over
   * `atoms x atoms`: positive where the orbital piles electrons up between the
   * two, negative where it pulls them out from between them, around zero where
   * it has nothing to do with that pair.
   *
   * An empty orbital is weighted as if it held one electron - otherwise every
   * entry would be zero and an empty orbital could say nothing at all - and so
   * is an orbital of a single spin, which holds one anyway.
   */
  populations: Float64Array;
  /**
   * The orbital's amplitude one Bohr off the molecular plane above each nucleus,
   * in the order the atoms were submitted in, or null for a molecule with no
   * plane to be above.
   *
   * What makes a pi system's nodes countable: the plane itself is a node of
   * every pi orbital, so a probe standing on it would read zero everywhere. The
   * signs are the ones the drawing of the same orbital is coloured by.
   */
  amplitudes: Float64Array | null;
}

/**
 * How many separations one distance scan may be asked for.
 *
 * A scan is the one figure that costs a calculation per point, so the cap is
 * about time rather than about the picture - and not about memory, which a scan
 * does not add to (it holds no lattice and no calculation). Measured in Node
 * (`docs/dev-notes.md`, "V4-9 の実測"), the time is linear in the points:
 * sixty take 1.4 seconds for He2 and 4.9 for O2, the slowest pair the picker
 * offers, against 2.4 for the 27 the section asks for. Sixty is about twice
 * what a curve needs to look smooth and still a wait rather than a hang.
 */
export const MAX_SCAN_POINTS = 60;

/**
 * One rung of the ladder at one separation of a {@link ScanPoint}.
 *
 * The same rung an {@link OrbitalLevel} describes, minus what a curve has no
 * use for. There is no `parity` because a diatomic has none to give - it lies
 * in every plane through its axis, and measuring against one of them splits a
 * genuinely degenerate pair - so `count` is what names the symmetry species
 * here: two for a pi level, one for a sigma level, and nothing else in a
 * minimal basis over H-Ar. With `inversion`, which two like atoms have, that
 * is the whole species, and it is what the lines of the figure are followed
 * along, since levels of the same species never cross and levels of different
 * ones do.
 */
export interface ScanLevel {
  /**
   * Orbital energy in Hartree, which sets how high the rung is drawn and
   * nothing else - never a number for the screen, for the reason in
   * {@link OrbitalLevel.energy}.
   */
  energy: number;
  /** Electrons in one of the orbitals on the rung, not in the rung. */
  occupation: number;
  /** Orbitals on the rung: two where they are degenerate, otherwise one. */
  count: number;
  /**
   * Which set of orbitals the rung belongs to: `0` for a closed-shell molecule,
   * which has only one, and `0` then `1` - up then down - for a molecule with
   * unpaired electrons, whose figure therefore has twice as many lines.
   */
  spin: number;
  /**
   * Overlap population between the two nuclei, averaged over the rung, on
   * `orbitalCharacter`'s scale: positive bonding, negative antibonding. Never a
   * number for the screen; it names a rung of two unlike atoms, which have no
   * inversion to name it by.
   */
  overlap: number;
  /** As {@link OrbitalLevel.inversion}: `null` unless the two atoms are alike. */
  inversion: 1 | -1 | null;
}

/** One separation of a distance scan, streamed as it is solved. */
export interface ScanPoint {
  /**
   * Distance between the two nuclei, in Angstrom. The one number of this figure
   * that may reach the screen: it is the length the user is already looking at
   * in the viewer, not a parameter of the method.
   */
  distance: number;
  /** Total energy in Hartree. */
  energy: number;
  /**
   * Whether the electrons were solved at this separation. A point that was not
   * is still sent: it is a gap in a curve rather than a failure of the scan.
   */
  converged: boolean;
  /** The rungs, lowest first, and for an open-shell molecule both spins' in turn. */
  levels: ScanLevel[];
}

/**
 * Which electrons a surface is asked for.
 *
 * Two of the three name what comes back. `bonding` is the odd one: a request
 * rather than an answer, which the engine settles by picking the sharper of the
 * two pictures of where the bonds are - the pi system when the molecule has one,
 * the deformation density otherwise. What it chose comes back in
 * {@link IsoMesh.channel}.
 *
 * Which is why `deformation` is here beside it. A planar molecule's bonding
 * request is always answered with its pi system, so without a way to ask for the
 * deformation density by name there would be no way to see it for a benzene at
 * all - and it is the picture that shows the lone pairs and the depleted
 * regions, which the pi surface does not. Any molecule has one
 * ({@link ScfOutcome.hasPi} says which have the other).
 *
 * `orbital` is the odd one out of all three: not a set of electrons at all but
 * one orbital, named by the `orbital` and `spin` of the request. It is what the
 * orbital section draws, and it is a request like the others only so that the
 * threshold slider, the mesh transfer and the surface the viewer holds are the
 * same machinery for it as for a density.
 */
export type DensityRequest = 'total' | 'bonding' | 'deformation' | 'orbital';

/**
 * What a surface actually shows.
 *
 * - `total` — every electron. Never negative.
 * - `pi` — the orbitals that stick out of a planar molecule's plane, which is
 *   its pi system. A density, so also never negative.
 * - `deformation` — the molecule's density minus the free atoms it is built
 *   from, which is where forming the bonds moved the electrons to and from.
 *   Signed, and the negative surface is where electrons left.
 * - `orbital` — one orbital's own amplitude, not a density: signed for a
 *   different reason, since its two colours are the two signs of a wave
 *   function rather than electrons gained and lost. The only channel whose
 *   surface says nothing about how many electrons are anywhere.
 */
export type DensityChannel = 'total' | 'pi' | 'deformation' | 'orbital';

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
  /**
   * Separate blobs each surface came out in, counted on the same lattice at the
   * same threshold - so these describe exactly the meshes beside them and
   * change as the slider moves.
   *
   * What makes an orbital's nodes countable: two lobes of one sign with a node
   * between them are two components here. `negative` is zero wherever the
   * negative surface is empty.
   */
  lobes: { positive: number; negative: number };
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
  /**
   * The orbital ladder of the last `scf` or `optimize` request.
   *
   * Cheap - a few matrix products on a calculation that is already solved, and
   * no lattice - so it is asked for whenever the section that shows it is
   * opened rather than kept alongside the numbers.
   */
  | { id: number; type: 'orbitals' }
  /**
   * What one orbital of the last `scf` or `optimize` request is like: which
   * bonds it strengthens and weakens, and its sign above each nucleus.
   *
   * As cheap as `orbitals` and asked for the same way - when the orbital on
   * screen changes, and never when its threshold moves, which is a picture of
   * the same orbital. `index` counts along the ladder of `spin`, as an
   * isosurface's `orbital` does, and omitting `spin` means `'both'`, which an
   * open-shell calculation answers with an `error`.
   */
  | { id: number; type: 'orbitalCharacter'; index: number; spin?: SpinChannel }
  /**
   * Cuts the density of the last `scf` or `optimize` request at a new level.
   *
   * The worker keeps one sampled lattice per channel it has been asked for, so
   * only the first request for each is slow; the rest are marching cubes alone.
   *
   * `orbital` and `spin` are for `channel: 'orbital'` and are ignored by the
   * others: which orbital to draw, as the `first` of an {@link OrbitalLevel}
   * plus an offset into its `count`, and which spin's ladder that index counts
   * along. Only the orbital asked for last is kept - one lattice, not one per
   * orbital, because WebAssembly's linear memory never shrinks - so changing
   * the threshold of the orbital on screen is as cheap as for a density while
   * going back to an earlier one is not. Omitting `spin` means `'both'`, which
   * an open-shell calculation answers with an `error` rather than a guess at
   * which spin was meant.
   */
  /**
   * Solves the same two atoms at `points` separations evenly spaced from `from`
   * to `to`, both in Angstrom, answering with a `scanPoint` for each as it is
   * solved and then one `scanDone`.
   *
   * The one request that is a calculation per answer rather than one
   * calculation: what happens to the levels as two atoms approach cannot be read
   * off a result that already exists. `points` is capped at
   * {@link MAX_SCAN_POINTS}.
   *
   * The spin state is chosen once, at the shortest separation, and held for the
   * whole scan, as it is for every step of an `optimize`. Letting it be chosen
   * afresh at each point would make the curve jump where a stretched molecule
   * stops being the closed shell it dissociates from.
   *
   * `budgetMs` stops it early exactly as it does an `optimize`: the worker ends
   * the scan between points and answers `scanDone` with a curve that is shorter
   * than `points`. The user's way of stopping is the other one - the worker is
   * terminated and replaced - and that throws away the calculation it was
   * holding along with it, so any surface on screen has to be solved again from
   * the SCF afterwards (`hasDensityRef`).
   *
   * Nothing here replaces the calculation the surfaces are drawn from: a scan
   * solves its own geometries and keeps none of them.
   */
  | {
      id: number;
      type: 'scan';
      z: Uint8Array;
      from: number;
      to: number;
      points: number;
      budgetMs?: number | null;
    }
  /**
   * The orbital levels of each element of `z` as a free atom, which are the two
   * ends of a diatomic's correlation diagram.
   *
   * One list per element in the order they were asked for, and one list per
   * element however the molecule beside them is solved: a free atom is solved
   * with its partly filled shell spread evenly over the degenerate orbitals, so
   * its levels do not split by spin. It needs no calculation to be loaded - it
   * is about the elements, not about anything on screen.
   */
  | { id: number; type: 'atomLevels'; z: Uint8Array }
  | {
      id: number;
      type: 'isosurface';
      channel: DensityRequest;
      isoLevel: number;
      orbital?: number;
      spin?: SpinChannel;
    };

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
  /**
   * The rungs of the ladder, lowest first; for an open-shell molecule all of
   * one spin's and then all of the other's, told apart by
   * {@link OrbitalLevel.spin} rather than by position.
   */
  | { id: number; type: 'orbitals'; levels: OrbitalLevel[] }
  /** The two arrays of {@link OrbitalCharacter}, for the orbital asked about. */
  | {
      id: number;
      type: 'orbitalCharacter';
      populations: Float64Array;
      amplitudes: Float64Array | null;
    }
  /**
   * One separation of a `scan`, sent as it is solved. Intermediate: more
   * follow, and `scanDone` ends the request.
   */
  | { id: number; type: 'scanPoint'; point: ScanPoint }
  /**
   * The end of a `scan`, whether every point arrived or a budget cut it short.
   * There is nothing to carry: everything a scan produces has already been
   * sent, and a caller that wants to know whether the curve is complete counts
   * the points it received against the ones it asked for.
   */
  | { id: number; type: 'scanDone' }
  /** One array of orbital energies per element of an `atomLevels` request. */
  | { id: number; type: 'atomLevels'; levels: number[][] }
  | { id: number; type: 'mesh'; mesh: IsoMesh }
  | { id: number; type: 'error'; message: string };

/**
 * Whether a response ends the request it answers.
 *
 * The worker client keeps a request pending until one of these arrives, which is
 * what lets an optimisation stream its steps, and a distance scan its points,
 * through the same correlation table as every other request.
 */
export function isTerminal(response: WorkerResponse): boolean {
  return (
    response.type !== 'step' &&
    response.type !== 'progress' &&
    response.type !== 'scanPoint'
  );
}
