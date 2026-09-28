/* tslint:disable */
/* eslint-disable */

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
 */
export function batch_intersect(tris_a: Float32Array, all_tris: Float32Array, offsets: Uint32Array, _epsilon: number): Float32Array;

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
 */
export function batch_intersect_raw(tris_a: Float32Array, all_tris: Float32Array, offsets: Uint32Array): Float64Array;

/**
 * Test if two triangle meshes intersect (hard clash detection).
 * Legacy/back-compat entry point — pre-averaged centroid, no AABB filter.
 * Prefer `mesh_intersect_raw` for parity with the JS reference.
 */
export function mesh_intersect(tris_a: Float32Array, tris_b: Float32Array, _epsilon: number): Float32Array;

/**
 * Test if two triangle meshes intersect, mirroring the JS reference's
 * `_bvhTraverseAll` collection pass EXACTLY (max 8 points, i.e. `pts.length
 * < 24` floats). Returns the RAW point list with `max_depth` appended as
 * the last element, or an empty Vec if there is no BVH-level hit at all.
 * index.html must run the same `_pointInBothBoxes` filter + averaging over
 * this that it runs over the JS-collected points (see
 * `_postProcessIntersectPoints` in index.html).
 */
export function mesh_intersect_raw(tris_a: Float32Array, tris_b: Float32Array): Float64Array;

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
 */
export function mesh_min_distance(verts_a: Float32Array, verts_b: Float32Array, max_dist: number): Float64Array;

export function sweep_and_prune(box_min: Float64Array, box_max: Float64Array, model_idx: Uint32Array, in_a: Uint8Array, in_b: Uint8Array, same_model_allowed: Uint8Array, margin: number): Uint32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly batch_intersect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly batch_intersect_raw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly mesh_intersect: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly mesh_intersect_raw: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly mesh_min_distance: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly sweep_and_prune: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
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
