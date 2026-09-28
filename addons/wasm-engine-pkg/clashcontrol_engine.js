/* @ts-self-types="./clashcontrol_engine.d.ts" */

/**
 * Batch intersection test: test one mesh against many.
 * Legacy/back-compat entry point (pre-averaged centroids, no AABB filter).
 * Prefer `batch_intersect_raw` for parity with the JS reference.
 *
 * `tris_a` is the reference mesh. `all_tris` is a flat array of ALL triangle
 * data for multiple meshes. `offsets` is [start0, end0, start1, end1, ...]
 * indexing into all_tris (in floats, not triangles). Each pair (start, end)
 * defines one mesh.
 *
 * Returns a flat array of results: [meshIdx, cx, cy, cz, depth, ...]
 * Only includes meshes that intersect.
 * @param {Float32Array} tris_a
 * @param {Float32Array} all_tris
 * @param {Uint32Array} offsets
 * @param {number} _epsilon
 * @returns {Float32Array}
 */
export function batch_intersect(tris_a, all_tris, offsets, _epsilon) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(tris_a, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(all_tris, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(offsets, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        wasm.batch_intersect(retptr, ptr0, len0, ptr1, len1, ptr2, len2, _epsilon);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v4 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Batch intersection, raw-point variant for parity with `_runBatch`'s JS
 * path: same BVH traversal/cap as `mesh_intersect_raw`, but for every mesh
 * in `offsets` (even ones with zero hits, so the caller can populate a
 * pair-result cache with confirmed misses, not just hits).
 *
 * Returns a flat f64 array of records, one per valid mesh (invalid offset
 * ranges are skipped, matching `mesh_intersect_raw`'s empty-input miss):
 *   [meshIdx, maxDepth, nPtsFloats, x0,y0,z0, x1,y1,z1, ...]
 * repeated per mesh. `nPtsFloats` is 0 for a confirmed BVH-level miss.
 * @param {Float32Array} tris_a
 * @param {Float32Array} all_tris
 * @param {Uint32Array} offsets
 * @returns {Float64Array}
 */
export function batch_intersect_raw(tris_a, all_tris, offsets) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(tris_a, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(all_tris, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(offsets, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        wasm.batch_intersect_raw(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v4 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 8, 8);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Test if two triangle meshes intersect (hard clash detection).
 * Legacy/back-compat entry point — pre-averaged centroid, no AABB filter.
 * Prefer `mesh_intersect_raw` for parity with the JS reference.
 * @param {Float32Array} tris_a
 * @param {Float32Array} tris_b
 * @param {number} _epsilon
 * @returns {Float32Array}
 */
export function mesh_intersect(tris_a, tris_b, _epsilon) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(tris_a, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(tris_b, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.mesh_intersect(retptr, ptr0, len0, ptr1, len1, _epsilon);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Test if two triangle meshes intersect, mirroring the JS reference's
 * `_bvhTraverseAll` collection pass EXACTLY (max 8 points, i.e. `pts.length
 * < 24` floats). Returns the RAW point list with `max_depth` appended as
 * the last element, or an empty Vec if there is no BVH-level hit at all.
 * index.html must run the same `_pointInBothBoxes` filter + averaging over
 * this that it runs over the JS-collected points (see
 * `_postProcessIntersectPoints` in index.html).
 * @param {Float32Array} tris_a
 * @param {Float32Array} tris_b
 * @returns {Float64Array}
 */
export function mesh_intersect_raw(tris_a, tris_b) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(tris_a, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(tris_b, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.mesh_intersect_raw(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 8, 8);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Compute minimum vertex-to-vertex distance between two meshes.
 * Bit-identical port of `_meshMinDist`'s JS-fallback spatial-hash walk
 * (same cell size fallback, same ceil-based step, same f64 arithmetic,
 * same tie-breaking via "first strictly smaller wins").
 *
 * `verts_a` and `verts_b` are flat Float32Arrays: [x0,y0,z0, x1,y1,z1, ...].
 * `max_dist` is the threshold (a JS number, so f64) — used ONLY to size the
 * grid cell (falls back to 0.05 when `max_dist` is 0, exactly like JS's
 * `thresholdM || 0.05`), exactly like the JS reference AS ACTUALLY CALLED:
 * index.html's one call site (`_processCandidate`) always passes an
 * `outPair` buffer, and `_meshMinDist`'s own threshold-cutoff early-return
 * (`if (minSq <= tSq && !outPair) return ...`) is therefore DEAD CODE in
 * production — with `outPair` truthy, `_meshMinDist` always returns the
 * real `Math.sqrt(minSq)`, however large, and leaves the threshold
 * comparison to the caller (`geoDist<=pairGapM`). Enforcing our own
 * threshold cutoff here would silently diverge from that real behavior.
 *
 * Returns [distance, ax, ay, az, bx, by, bz] always — `distance` is
 * `Infinity` (and the pair all zeros, matching JS's zero-initialized
 * outPair) only when NO vertex was found near ANY sampled query point
 * (sparse/disjoint meshes relative to the grid cell size), or when either
 * input is empty (a single-element `[Infinity]`, matching JS's early
 * `if (!vA.length || !vB.length) return Infinity` with no outPair touch).
 * @param {Float32Array} verts_a
 * @param {Float32Array} verts_b
 * @param {number} max_dist
 * @returns {Float64Array}
 */
export function mesh_min_distance(verts_a, verts_b, max_dist) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(verts_a, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(verts_b, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.mesh_min_distance(retptr, ptr0, len0, ptr1, len1, max_dist);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 8, 8);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {Float64Array} box_min
 * @param {Float64Array} box_max
 * @param {Uint32Array} model_idx
 * @param {Uint8Array} in_a
 * @param {Uint8Array} in_b
 * @param {Uint8Array} same_model_allowed
 * @param {number} margin
 * @returns {Uint32Array}
 */
export function sweep_and_prune(box_min, box_max, model_idx, in_a, in_b, same_model_allowed, margin) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(box_min, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(box_max, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(model_idx, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(in_a, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(in_b, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(same_model_allowed, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        wasm.sweep_and_prune(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, margin);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v7 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v7;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
    };
    return {
        __proto__: null,
        "./clashcontrol_engine_bg.js": import0,
    };
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

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
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
        module_or_path = new URL('clashcontrol_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
