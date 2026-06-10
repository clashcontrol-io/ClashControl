/* tslint:disable */
/* eslint-disable */

/**
 * Batch intersection test: test one mesh against many.
 * `tris_a` is the reference mesh. `all_tris` is a flat array of ALL triangle data
 * for multiple meshes. `offsets` is [start0, end0, start1, end1, ...] indexing into all_tris
 * (in floats, not triangles). Each pair (start, end) defines one mesh.
 *
 * Returns a flat array of results: [meshIdx, cx, cy, cz, depth, meshIdx, cx, cy, cz, depth, ...]
 * Only includes meshes that intersect.
 */
export function batch_intersect(tris_a: Float32Array, all_tris: Float32Array, offsets: Uint32Array, epsilon: number): Float32Array;

/**
 * Test if two triangle meshes intersect (hard clash detection).
 *
 * `tris_a` and `tris_b` are flat Float32Arrays: [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...].
 * Length must be divisible by 9 (3 vertices × 3 coords per triangle).
 *
 * Returns a Float32Array of [cx, cy, cz, depth] if intersecting, or empty if not.
 * cx/cy/cz = centroid of intersection points, depth = max penetration.
 */
export function mesh_intersect(tris_a: Float32Array, tris_b: Float32Array, epsilon: number): Float32Array;

/**
 * Compute minimum vertex-to-vertex distance between two meshes.
 *
 * `verts_a` and `verts_b` are flat Float32Arrays: [x0,y0,z0, x1,y1,z1, ...].
 * Length must be divisible by 3.
 * `max_dist` is the threshold — returns f32::INFINITY if meshes are farther apart.
 *
 * Returns a Float32Array of [distance, ax, ay, az, bx, by, bz] with the closest pair,
 * or [Infinity] if beyond threshold.
 */
export function mesh_min_distance(verts_a: Float32Array, verts_b: Float32Array, max_dist: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly batch_intersect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly mesh_intersect: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly mesh_min_distance: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
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
