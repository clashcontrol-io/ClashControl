/* tslint:disable */
/* eslint-disable */

/**
 * Registry of meshes whose triangle data and BVH are built ONCE and reused
 * across many pair queries. Every query goes through exactly the same
 * internals as the stateless `mesh_intersect_raw` / `mesh_min_distance`
 * (`intersect_raw_prebuilt` / `min_distance_prebuilt`), and `BvhNode::build`
 * is a pure function of the triangle data, so results are bit-identical to
 * the free functions (and therefore to the JS reference).
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Drop every registered mesh.
     */
    clear(): void;
    has(id: number): boolean;
    /**
     * Same return value as `mesh_intersect_raw(tris(id_a), tris(id_b))`:
     * the raw point list with `max_depth` appended, or an empty Vec on a
     * miss / empty mesh. `None` (JS `undefined`) when either id is not
     * registered, so a caller bug can never masquerade as "no clash".
     */
    intersect(id_a: number, id_b: number): Float64Array | undefined;
    is_empty(): boolean;
    /**
     * Number of registered meshes.
     */
    len(): number;
    /**
     * Same return value as `mesh_min_distance(tris(id_a), tris(id_b))`
     * (`[distance, ax,ay,az, bx,by,bz]`, or `[Infinity]` for an empty
     * mesh). `None` when either id is not registered.
     */
    min_distance(id_a: number, id_b: number): Float64Array | undefined;
    constructor();
    /**
     * Register (or replace) mesh `id`: copies `tris` (9 floats/triangle) and
     * builds its BVH with the same code the free functions use.
     */
    register(id: number, tris: Float32Array): void;
    /**
     * Total registered triangle floats (for the JS side's memory budget).
     */
    total_floats(): number;
    /**
     * Drop mesh `id`. Returns whether it was registered.
     */
    unregister(id: number): boolean;
}

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
 * Compute the true minimum mesh-to-mesh distance between two triangle
 * meshes: point-to-triangle (both directions) + edge-edge, BVH-
 * accelerated. Bit-identical port of `_meshMinDist`'s JS fallback (see
 * `mesh_dist.rs` and index.html's `_bvhMinDistTraverse`/`_triTriDistSq`
 * doc comments) — same BVH shape as `mesh_intersect_raw` (bvh::BvhNode),
 * same sub-test order, same "first strictly smaller wins" tie-break.
 *
 * Replaces the old vertex-to-vertex spatial-hash walk (`spatial_hash.rs`,
 * removed), which measured only how close two meshes' VERTICES were — a
 * point resting mid-face on the other mesh (no nearby vertex) reported
 * Infinity/far instead of its real (small) distance. See CLAUDE.md task
 * notes for the verified repro (a small device 0.1m above a 10x10m slab
 * center).
 *
 * `tris_a` and `tris_b` are flat Float32Arrays, 9 floats per triangle
 * (matching `mesh_intersect_raw`'s wire shape) — NOT raw vertices.
 *
 * Returns [distance, ax, ay, az, bx, by, bz] always — `distance` is
 * `Infinity` (single-element `[Infinity]`, no pair) only when either input
 * is empty; with two non-empty meshes a finite distance and closest-point
 * pair is always found (unlike the old grid walk, there is no "search
 * neighborhood" that can come up empty).
 */
export function mesh_min_distance(tris_a: Float32Array, tris_b: Float32Array): Float64Array;

export function sweep_and_prune(box_min: Float64Array, box_max: Float64Array, model_idx: Uint32Array, in_a: Uint8Array, in_b: Uint8Array, same_model_allowed: Uint8Array, margin: number): Uint32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly batch_intersect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly batch_intersect_raw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engine_clear: (a: number) => void;
    readonly engine_has: (a: number, b: number) => number;
    readonly engine_intersect: (a: number, b: number, c: number, d: number) => void;
    readonly engine_is_empty: (a: number) => number;
    readonly engine_len: (a: number) => number;
    readonly engine_min_distance: (a: number, b: number, c: number, d: number) => void;
    readonly engine_new: () => number;
    readonly engine_register: (a: number, b: number, c: number, d: number) => void;
    readonly engine_total_floats: (a: number) => number;
    readonly engine_unregister: (a: number, b: number) => number;
    readonly mesh_intersect: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly mesh_intersect_raw: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly mesh_min_distance: (a: number, b: number, c: number, d: number, e: number) => void;
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
