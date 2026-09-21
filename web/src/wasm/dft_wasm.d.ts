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
     * `channel` is what the user asked to see: `"total"` for every electron, or
     * `"bonding"` for the electrons that made the bonds. The engine decides how
     * to answer the second one - the pi system of a planar molecule, otherwise
     * the deformation density - and the answer says which it chose, because the
     * two look different enough that the UI has to explain them differently.
     *
     * The first call for a channel also samples its density, which is why it is
     * slower than the ones that follow.
     */
    isosurface(channel: string, iso_level: number): IsoMesh;
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
    readonly calculation_isosurface: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly calculation_summary: (a: number) => [number, number, number];
    readonly isomesh_channel: (a: number) => [number, number];
    readonly isomesh_densityMax: (a: number) => number;
    readonly isomesh_densityMin: (a: number) => number;
    readonly isomesh_isoLevel: (a: number) => number;
    readonly isomesh_negativeIndices: (a: number) => [number, number];
    readonly isomesh_negativeNormals: (a: number) => [number, number];
    readonly isomesh_negativePositions: (a: number) => [number, number];
    readonly isomesh_positiveIndices: (a: number) => [number, number];
    readonly isomesh_positiveNormals: (a: number) => [number, number];
    readonly isomesh_positivePositions: (a: number) => [number, number];
    readonly optimize: (a: number, b: number, c: number, d: number, e: any, f: number, g: number, h: number) => [number, number, number];
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
