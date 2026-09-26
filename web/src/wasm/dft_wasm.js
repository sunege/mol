/* @ts-self-types="./dft_wasm.d.ts" */

/**
 * A converged calculation, kept alive on the worker side.
 *
 * The SCF is the expensive part and every surface is drawn from its density, so
 * the two are separate calls over the same handle: moving the threshold slider
 * re-runs marching cubes on a density that is already sampled, which is a few
 * milliseconds rather than seconds.
 */
export class Calculation {
    static __wrap(ptr) {
        const obj = Object.create(Calculation.prototype);
        obj.__wbg_ptr = ptr;
        CalculationFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CalculationFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_calculation_free(ptr, 0);
    }
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
     * Two more arguments belong to `"orbital"` alone. `atom` draws one of that
     * atom's orbitals as a free atom instead of one of the molecule's - the left
     * and right ends of a correlation diagram - with `index` counting along its
     * `atomLevels` and `spin` ignored, since a free atom is solved with both
     * spins together. `along` is a direction: inside a degenerate set the
     * members are an arbitrary rotation of one another, and this turns the set
     * so that the member drawn faces it. Only its direction is read, so it has
     * no unit, but it has to be three numbers that are not all zero; an orbital
     * that is not degenerate is drawn the same with or without it.
     *
     * The first call for a channel also samples its density, which is why it is
     * slower than the ones that follow. The same holds for an orbital, except
     * that only the last one asked for is kept.
     * @param {string} channel
     * @param {number} iso_level
     * @param {number | null} [index]
     * @param {string | null} [spin]
     * @param {number | null} [atom]
     * @param {Float64Array | null} [along]
     * @returns {IsoMesh}
     */
    isosurface(channel, iso_level, index, spin, atom, along) {
        const ptr0 = passStringToWasm0(channel, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(spin) ? 0 : passStringToWasm0(spin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(along) ? 0 : passArrayF64ToWasm0(along, wasm.__wbindgen_malloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.calculation_isosurface(this.__wbg_ptr, ptr0, len0, iso_level, isLikeNone(index) ? Number.MAX_SAFE_INTEGER : (index) >>> 0, ptr1, len1, isLikeNone(atom) ? Number.MAX_SAFE_INTEGER : (atom) >>> 0, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return IsoMesh.__wrap(ret[0]);
    }
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
     * @param {number} index
     * @param {string | null} [spin]
     * @returns {OrbitalCharacter}
     */
    orbitalCharacter(index, spin) {
        var ptr0 = isLikeNone(spin) ? 0 : passStringToWasm0(spin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.calculation_orbitalCharacter(this.__wbg_ptr, index, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return OrbitalCharacter.__wrap(ret[0]);
    }
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
     * @returns {any}
     */
    orbitals() {
        const ret = wasm.calculation_orbitals(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The scalar results, as a plain object for the UI.
     * @returns {any}
     */
    summary() {
        const ret = wasm.calculation_summary(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Calculation.prototype[Symbol.dispose] = Calculation.prototype.free;

/**
 * The triangulated level set, laid out for GPU vertex buffers.
 *
 * Two surfaces, not one: a signed density needs the region above `+isoLevel`
 * and the region below `-isoLevel` drawn separately so the UI can colour them
 * apart. For an ordinary density the second one is empty.
 */
export class IsoMesh {
    static __wrap(ptr) {
        const obj = Object.create(IsoMesh.prototype);
        obj.__wbg_ptr = ptr;
        IsoMeshFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IsoMeshFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_isomesh_free(ptr, 0);
    }
    /**
     * Which electrons this was drawn from: `"total"`, `"pi"` or
     * `"deformation"`.
     * @returns {string}
     */
    get channel() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.isomesh_channel(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Largest sample on the lattice, which bounds the levels that can produce a
     * positive surface at all.
     * @returns {number}
     */
    get densityMax() {
        const ret = wasm.isomesh_densityMax(this.__wbg_ptr);
        return ret;
    }
    /**
     * Most negative sample, or zero for a channel that cannot go negative.
     * @returns {number}
     */
    get densityMin() {
        const ret = wasm.isomesh_densityMin(this.__wbg_ptr);
        return ret;
    }
    /**
     * The level cut, in electrons per cubic Bohr.
     * @returns {number}
     */
    get isoLevel() {
        const ret = wasm.isomesh_isoLevel(this.__wbg_ptr);
        return ret;
    }
    /**
     * The same for the negative surface; zero wherever that surface is empty.
     * @returns {number}
     */
    get lobesNegative() {
        const ret = wasm.isomesh_lobesNegative(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Separate blobs the positive surface came out in, at this same level.
     *
     * Counted on the lattice rather than on the mesh, which is what makes an
     * orbital's nodes countable: two lobes of one sign with a node between them
     * are two components here.
     * @returns {number}
     */
    get lobesPositive() {
        const ret = wasm.isomesh_lobesPositive(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint32Array}
     */
    get negativeIndices() {
        const ret = wasm.isomesh_negativeIndices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get negativeNormals() {
        const ret = wasm.isomesh_negativeNormals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get negativePositions() {
        const ret = wasm.isomesh_negativePositions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Three vertex indices per triangle.
     * @returns {Uint32Array}
     */
    get positiveIndices() {
        const ret = wasm.isomesh_positiveIndices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Unit normals pointing away from the enclosed region.
     * @returns {Float32Array}
     */
    get positiveNormals() {
        const ret = wasm.isomesh_positiveNormals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Three coordinates per vertex, in Angstrom.
     * @returns {Float32Array}
     */
    get positivePositions() {
        const ret = wasm.isomesh_positivePositions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) IsoMesh.prototype[Symbol.dispose] = IsoMesh.prototype.free;

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
    static __wrap(ptr) {
        const obj = Object.create(OrbitalCharacter.prototype);
        obj.__wbg_ptr = ptr;
        OrbitalCharacterFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OrbitalCharacterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_orbitalcharacter_free(ptr, 0);
    }
    /**
     * The orbital's amplitude one Bohr off the molecular plane above each
     * nucleus, in the order the atoms were submitted in - or nothing at all for
     * a molecule with no plane to be above. The signs are the drawing's own.
     * @returns {Float64Array | undefined}
     */
    get amplitudes() {
        const ret = wasm.orbitalcharacter_amplitudes(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        }
        return v1;
    }
    /**
     * Mulliken overlap population for every pair of nuclei, row-major over
     * `atoms * atoms`: positive where the orbital piles electrons up between
     * the two, negative where it pulls them out from between them, and around
     * zero where it has nothing to do with that pair.
     * @returns {Float64Array}
     */
    get populations() {
        const ret = wasm.orbitalcharacter_populations(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) OrbitalCharacter.prototype[Symbol.dispose] = OrbitalCharacter.prototype.free;

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
 *
 * `charges` is the charge on each entry of `z`, as for [`scf`]: an ion's levels
 * are its own (a proton's are all empty, and lower than a hydrogen atom's).
 * @param {Uint8Array} z
 * @param {Int8Array | null} [charges]
 * @returns {any}
 */
export function atomLevels(z, charges) {
    const ptr0 = passArray8ToWasm0(z, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(charges) ? 0 : passArray8ToWasm0(charges, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.atomLevels(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Relaxes a geometry given in Angstrom, calling `on_step` with each accepted
 * structure as it is produced (requirement F2).
 *
 * The spin state is chosen once, on the structure as given, and
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
 * So do `charges`, as for [`scf`].
 * @param {Uint8Array} z
 * @param {Float64Array} xyz_angstrom
 * @param {Function} on_step
 * @param {Function | null} [on_progress]
 * @param {string | null} [level]
 * @param {Int8Array | null} [charges]
 * @returns {Calculation}
 */
export function optimize(z, xyz_angstrom, on_step, on_progress, level, charges) {
    const ptr0 = passArray8ToWasm0(z, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(xyz_angstrom, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(level) ? 0 : passStringToWasm0(level, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(charges) ? 0 : passArray8ToWasm0(charges, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    const ret = wasm.optimize(ptr0, len0, ptr1, len1, on_step, isLikeNone(on_progress) ? 0 : addToExternrefTable0(on_progress), ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Calculation.__wrap(ret[0]);
}

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
 *
 * `charges` is the charge on each of the two atoms, as for [`scf`]. The engine
 * turns charges it refuses into a scan with no points; they are refused here
 * instead, with the same message a single point would give, so that a caller
 * is not left drawing an empty figure.
 * @param {Uint8Array} z
 * @param {number} from_angstrom
 * @param {number} to_angstrom
 * @param {number} points
 * @param {Function} on_point
 * @param {Int8Array | null} [charges]
 */
export function scan(z, from_angstrom, to_angstrom, points, on_point, charges) {
    const ptr0 = passArray8ToWasm0(z, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(charges) ? 0 : passArray8ToWasm0(charges, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.scan(ptr0, len0, from_angstrom, to_angstrom, points, on_point, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Runs a Kohn-Sham LDA single point on a geometry given in Angstrom, at the
 * charge placed on its atoms and choosing the spin state itself (requirement
 * F4).
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
 *
 * `charges` is the charge placed on each atom, in the order of `z`; absent
 * means every atom is neutral (see [`atom_charges`]).
 * @param {Uint8Array} z
 * @param {Float64Array} xyz_angstrom
 * @param {Function | null} [on_progress]
 * @param {string | null} [level]
 * @param {Int8Array | null} [charges]
 * @returns {Calculation}
 */
export function scf(z, xyz_angstrom, on_progress, level, charges) {
    const ptr0 = passArray8ToWasm0(z, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(xyz_angstrom, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(level) ? 0 : passStringToWasm0(level, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(charges) ? 0 : passArray8ToWasm0(charges, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    const ret = wasm.scf(ptr0, len0, ptr1, len1, isLikeNone(on_progress) ? 0 : addToExternrefTable0(on_progress), ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Calculation.__wrap(ret[0]);
}

/**
 * Installs a panic hook that reports Rust panics to the browser console.
 * Called once when the worker boots.
 */
export function start() {
    wasm.start();
}

/**
 * Returns every supported element (H-Ar) as an array of objects.
 * @returns {any}
 */
export function supportedElements() {
    const ret = wasm.supportedElements();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_67e7344beaa85059: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_6bcf8d3e20937e46: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_7bbd9cceba9949ad: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_bebc3f4757acf305: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ffa92086ea89f79c: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_now_d1fb6650485d7f3e: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_set_13d25b81ab403f5e: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./dft_wasm_bg.js": import0,
    };
}

const CalculationFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_calculation_free(ptr, 1));
const IsoMeshFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_isomesh_free(ptr, 1));
const OrbitalCharacterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_orbitalcharacter_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('dft_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
