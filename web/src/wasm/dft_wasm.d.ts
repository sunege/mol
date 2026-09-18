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
 * Runs a restricted Kohn-Sham LDA single point on a geometry given in Angstrom.
 *
 * Non-convergence comes back through `summary().converged`, never as a thrown
 * error: the UI turns it into an animation rather than a message
 * (requirement F5).
 */
export function scf(z: Uint8Array, xyz_angstrom: Float64Array): Calculation;

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
    readonly scf: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly start: () => void;
    readonly supportedElements: () => [number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
