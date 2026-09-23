/* tslint:disable */
/* eslint-disable */

/**
 * A converged calculation, kept alive on the worker side.
 *
 * The SCF is the expensive part and every surface is drawn from its density, so
 * the two are separate calls over the same handle: moving the threshold slider
 * re-runs marching cubes on a density that is already sampled, which is a few
 * milliseconds rather than seconds.
 */
export class Calculation {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Triangulates a surface of the electron density at `iso_level`, in
     * electrons per cubic Bohr.
     *
     * `channel` is what the user asked to see: `"total"` for every electron,
     * `"deformation"` for the electrons that moved when the free atoms became
     * this molecule, or `"bonding"` for the electrons that made the bonds. Only
     * the last is a question rather than an instruction - the engine answers it
     * with the pi system of a planar molecule and otherwise with the
     * deformation density - and the answer always says which of the three it
     * drew, because they look different enough that the UI has to explain them
     * differently.
     *
     * `"orbital"` is not one of those: it draws a single orbital, `index`
     * counting along the ladder of `spin` (`"both"`, `"up"` or `"down"`; omitted
     * means `"both"`). Its two colours are the two signs of a wave function
     * rather than electrons gained and lost, and the overall sign is fixed by
     * convention so that the same orbital is coloured the same way every time it
     * is solved (`orbital::signed_column`). Which model level an orbital may be
     * shown for is not decided here: that is a rule about the interface, and the
     * interface keeps it.
     *
     * The first call for a channel also samples its density, which is why it is
     * slower than the ones that follow. The same holds for an orbital, except
     * that only the last one asked for is kept.
     */
    isosurface(channel: string, iso_level: number, index?: number | null, spin?: string | null): IsoMesh;
    /**
     * What orbital `index` of the ladder of `spin` does to each pair of nuclei,
     * and where its sign changes along them (`OrbitalCharacter` in
     * `web/src/worker/protocol.ts`).
     *
     * Cheap in the same way [`Calculation::orbitals`] is: sums over the basis
     * functions of pairs of atoms, and one evaluation of the orbital per
     * nucleus, with no lattice anywhere. It answers a change of orbital, not a
     * change of threshold.
     *
     * The population is weighted by the orbital's own occupation, except that
     * anything below one electron is read as one: an empty orbital has no
     * population at all, and what is wanted of it is the one it would have if
     * an electron were put in it. A single spin's orbitals hold one electron
     * each, so an open-shell molecule's two spins are measured on the same
     * scale either way.
     */
    orbitalCharacter(index: number, spin?: string | null): OrbitalCharacter;
    /**
     * The ladder of orbital levels, lowest first, as a plain array for the UI
     * (`OrbitalLevel` in `web/src/worker/protocol.ts`).
     *
     * Degenerate orbitals arrive as one rung rather than several: inside a
     * degenerate set the split into individual orbitals is an arbitrary
     * rotation, so the set is the smallest thing that is a fact about the
     * molecule. A molecule with unpaired electrons gives two ladders, all of
     * alpha's rungs and then all of beta's, told apart by `spin` - never folded
     * together, because the two are genuinely different orbitals, and lined up
     * by `partner` rather than by index because they do not even come in the
     * same order.
     *
     * Cheap: a few matrix products on a calculation that is already solved, and
     * no lattice at all.
     */
    orbitals(): any;
    /**
     * The scalar results, as a plain object for the UI.
     */
    summary(): any;
}

/**
 * The triangulated level set, laid out for GPU vertex buffers.
 *
 * Two surfaces, not one: a signed density needs the region above `+isoLevel`
 * and the region below `-isoLevel` drawn separately so the UI can colour them
 * apart. For an ordinary density the second one is empty.
 */
export class IsoMesh {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Which electrons this was drawn from: `"total"`, `"pi"` or
     * `"deformation"`.
     */
    readonly channel: string;
    /**
     * Largest sample on the lattice, which bounds the levels that can produce a
     * positive surface at all.
     */
    readonly densityMax: number;
    /**
     * Most negative sample, or zero for a channel that cannot go negative.
     */
    readonly densityMin: number;
    /**
     * The level cut, in electrons per cubic Bohr.
     */
    readonly isoLevel: number;
    /**
     * The same for the negative surface; zero wherever that surface is empty.
     */
    readonly lobesNegative: number;
    /**
     * Separate blobs the positive surface came out in, at this same level.
     *
     * Counted on the lattice rather than on the mesh, which is what makes an
     * orbital's nodes countable: two lobes of one sign with a node between them
     * are two components here.
     */
    readonly lobesPositive: number;
    readonly negativeIndices: Uint32Array;
    readonly negativeNormals: Float32Array;
    readonly negativePositions: Float32Array;
    /**
     * Three vertex indices per triangle.
     */
    readonly positiveIndices: Uint32Array;
    /**
     * Unit normals pointing away from the enclosed region.
     */
    readonly positiveNormals: Float32Array;
    /**
     * Three coordinates per vertex, in Angstrom.
     */
    readonly positivePositions: Float32Array;
}

/**
 * What one orbital does to the bonds, and where its sign changes.
 *
 * Numbers rather than a verdict, because the verdict needs something the
 * engine does not have: which pairs of atoms count as bonded is the interface's
 * own guess from the geometry (`web/src/scene/bonds.ts`), so the whole matrix
 * crosses and the UI reads the pairs it draws out of it. None of it reaches the
 * screen as a number - only the sign and the size, in words (requirement F4).
 */
export class OrbitalCharacter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The orbital's amplitude one Bohr off the molecular plane above each
     * nucleus, in the order the atoms were submitted in - or nothing at all for
     * a molecule with no plane to be above. The signs are the drawing's own.
     */
    readonly amplitudes: Float64Array | undefined;
    /**
     * Mulliken overlap population for every pair of nuclei, row-major over
     * `atoms * atoms`: positive where the orbital piles electrons up between
     * the two, negative where it pulls them out from between them, and around
     * zero where it has nothing to do with that pair.
     */
    readonly populations: Float64Array;
}

/**
 * The orbital levels of each element of `z` as a free atom, in Hartree, as an
 * array of arrays.
 *
 * The two ends of a correlation diagram. One column per element and not two,
 * however the molecule in the middle is solved: a free atom is solved with its
 * partly filled shell spread evenly over the degenerate orbitals, so its levels
 * are the same for both spins.
 *
 * A few milliseconds per element - it is the same atomic calculation every
 * molecular SCF already starts from - and at the level the scan beside it runs
 * at.
 */
export function atomLevels(z: Uint8Array): any;

/**
 * Relaxes a geometry given in Angstrom, calling `on_step` with each accepted
 * structure as it is produced (requirement F2).
 *
 * The charge and spin state are chosen once, on the structure as given, and
 * held for the whole optimisation: running the search at every geometry would
 * multiply the cost by the number of states tried, and the state is not what is
 * being optimised.
 *
 * `on_step` receives `{ step, xyz, energy, maxForce }` with coordinates in
 * Angstrom. Its return value is not read; a caller that wants to stop early
 * *throws* from it, and the relaxation ends where it is with `"interrupted"`
 * and the structure it had reached - which is how the candidate pool gives
 * itself a budget shorter than [`OPTIMIZE_BUDGET_SECONDS`] without a worker
 * being terminated (`web/src/search/`).
 *
 * Nothing here throws at the caller: a structure the engine cannot solve comes
 * back as a calculation whose `optimization.converged` is false, which the
 * interface turns into an animation rather than a message (requirement F5).
 *
 * `on_progress(stage, step)`, when given, is called as each part of the
 * calculation starts (see [`stage`]). Most of the wait before the first step is
 * in parts that move no atoms, and this is how the caller can say so.
 *
 * `level` is what the calculation is for, as for [`scf`], and holds for every
 * step: the optimiser builds each new geometry in the basis of the one before.
 */
export function optimize(z: Uint8Array, xyz_angstrom: Float64Array, on_step: Function, on_progress?: Function | null, level?: string | null): Calculation;

/**
 * Solves two atoms at `points` separations evenly spaced from `from_angstrom`
 * to `to_angstrom`, handing each to `on_point` as it is produced.
 *
 * The one figure that cannot be made out of a calculation already done: every
 * distance is its own SCF. It is affordable because a diatomic in the smallest
 * basis is small - hydrogen at 27 points is under half a second natively - and
 * because the scan is always solved at the level a shape is found at, which is
 * also the level whose two-orbital picture is the textbook one.
 *
 * The spin state is chosen once, at the shortest distance, and held for the
 * whole scan, exactly as [`optimize`] holds it for a whole relaxation; the
 * reason is in `dft_core::scan`.
 *
 * `on_point` receives `{ distance, energy, converged, levels }` with the
 * distance in Angstrom. Its return value is not read: a caller that wants to
 * stop early *throws* from it, as it does from [`optimize`]'s `on_step`, and
 * the scan ends with the points it has already handed over standing.
 *
 * Nothing here holds on to a calculation, so a scan neither replaces nor
 * disturbs the one the surfaces are being drawn from.
 */
export function scan(z: Uint8Array, from_angstrom: number, to_angstrom: number, points: number, on_point: Function): void;

/**
 * Runs a Kohn-Sham LDA single point on a geometry given in Angstrom, choosing
 * the charge and spin state itself (requirement F4).
 *
 * Non-convergence comes back through `summary().converged`, never as a thrown
 * error: the UI turns it into an animation rather than a message
 * (requirement F5).
 *
 * `on_progress(stage, step)`, when given, is called as each part of the
 * calculation starts (see [`stage`]).
 *
 * `level` is what the calculation is for: `"shape"` (the default) or
 * `"measure"`. Any other name throws rather than being solved at the default.
 */
export function scf(z: Uint8Array, xyz_angstrom: Float64Array, on_progress?: Function | null, level?: string | null): Calculation;

/**
 * Installs a panic hook that reports Rust panics to the browser console.
 * Called once when the worker boots.
 */
export function start(): void;

/**
 * Returns every supported element (H-Ar) as an array of objects.
 */
export function supportedElements(): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_calculation_free: (a: number, b: number) => void;
    readonly __wbg_isomesh_free: (a: number, b: number) => void;
    readonly __wbg_orbitalcharacter_free: (a: number, b: number) => void;
    readonly atomLevels: (a: number, b: number) => [number, number, number];
    readonly calculation_isosurface: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly calculation_orbitalCharacter: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly calculation_orbitals: (a: number) => [number, number, number];
    readonly calculation_summary: (a: number) => [number, number, number];
    readonly isomesh_channel: (a: number) => [number, number];
    readonly isomesh_densityMax: (a: number) => number;
    readonly isomesh_densityMin: (a: number) => number;
    readonly isomesh_isoLevel: (a: number) => number;
    readonly isomesh_lobesNegative: (a: number) => number;
    readonly isomesh_lobesPositive: (a: number) => number;
    readonly isomesh_negativeIndices: (a: number) => [number, number];
    readonly isomesh_negativeNormals: (a: number) => [number, number];
    readonly isomesh_negativePositions: (a: number) => [number, number];
    readonly isomesh_positiveIndices: (a: number) => [number, number];
    readonly isomesh_positiveNormals: (a: number) => [number, number];
    readonly isomesh_positivePositions: (a: number) => [number, number];
    readonly optimize: (a: number, b: number, c: number, d: number, e: any, f: number, g: number, h: number) => [number, number, number];
    readonly orbitalcharacter_amplitudes: (a: number) => [number, number];
    readonly orbitalcharacter_populations: (a: number) => [number, number];
    readonly scan: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number];
    readonly scf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly start: () => void;
    readonly supportedElements: () => [number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
