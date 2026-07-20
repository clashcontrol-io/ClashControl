//! Broad-phase sweep-and-prune, mirroring `index.html`'s `_sweepAndPrune`
//! function exactly (same axis-selection heuristic, same stable sort, same
//! sliding-window active-list scan, same AABB overlap test, same pair
//! orientation).
//!
//! Deliberately does NOT replicate the self-clash rule's business logic
//! (index.html's `rules.selfClashModels` / `rules.selfClashGroup` /
//! `rules.excludeSelf` three-shape branching) here — that logic has three
//! different possible input shapes and is easy to get subtly wrong in a
//! port. Instead the caller (JS) resolves it ONCE per unique model, ahead
//! of the call, into a simple `same_model_allowed[model_idx]` lookup flag
//! (see the JS side's `_sweepAndPruneWasm`). This function only knows
//! "same-model pairs in model M are allowed, or not" and "which models are
//! in group A / group B" — pure geometry plus a lookup, no rule shapes.
//!
//! Output is a flat `Vec<u32>`, three values per candidate pair
//! (idxA, idxB, sameModel as 0/1) — indices into the caller's own item
//! list, not JS objects. The JS side decodes this back into the exact same
//! `{eA, mA, eB, mB, sameModel}` shape `_sweepAndPrune` already returns, so
//! nothing downstream of the sweep needs to change.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn sweep_and_prune(
    box_min: &[f64],
    box_max: &[f64],
    model_idx: &[u32],
    in_a: &[u8],
    in_b: &[u8],
    same_model_allowed: &[u8],
    margin: f64,
) -> Vec<u32> {
    let n = model_idx.len();
    if n < 2 || box_min.len() != n * 3 || box_max.len() != n * 3 {
        return Vec::new();
    }

    // ── Axis selection: axis of max centroid variance ──
    // Same f64 arithmetic, same operation order, same >= tie-breaking
    // (toward x, then y) as the JS version — floating-point isn't
    // associative, so operation order matters for bit-identical results.
    let mut sx = 0.0f64;
    let mut sy = 0.0f64;
    let mut sz = 0.0f64;
    let mut sx2 = 0.0f64;
    let mut sy2 = 0.0f64;
    let mut sz2 = 0.0f64;
    for i in 0..n {
        let cx = (box_min[i * 3] + box_max[i * 3]) * 0.5;
        let cy = (box_min[i * 3 + 1] + box_max[i * 3 + 1]) * 0.5;
        let cz = (box_min[i * 3 + 2] + box_max[i * 3 + 2]) * 0.5;
        sx += cx;
        sy += cy;
        sz += cz;
        sx2 += cx * cx;
        sy2 += cy * cy;
        sz2 += cz * cz;
    }
    let nf = n as f64;
    let vx = sx2 / nf - (sx / nf) * (sx / nf);
    let vy = sy2 / nf - (sy / nf) * (sy / nf);
    let vz = sz2 / nf - (sz / nf) * (sz / nf);
    // 0 = x, 1 = y, 2 = z
    let axis: usize = if vx >= vy && vx >= vz {
        0
    } else if vy >= vz {
        1
    } else {
        2
    };
    let axis2: usize = if axis == 0 { 1 } else { 0 };
    let axis3: usize = if axis == 2 { 1 } else { 2 };

    // ── Sort item indices by (box.min[axis] - margin), stable ──
    // Rust's slice::sort_by is a stable sort (like JS's Array.sort since
    // ES2019) — ties preserve the input order, matching JS exactly, given
    // both receive items in the same original order.
    let mut order: Vec<u32> = (0..n as u32).collect();
    order.sort_by(|&a, &b| {
        let ka = box_min[a as usize * 3 + axis] - margin;
        let kb = box_min[b as usize * 3 + axis] - margin;
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });

    // ── Sliding-window active-list scan ──
    let mut pairs: Vec<u32> = Vec::new();
    let mut active: Vec<u32> = Vec::new();

    for &cur in &order {
        let cur_min = box_min[cur as usize * 3 + axis] - margin;

        // Array.filter preserves order; Vec::retain does too.
        active.retain(|&it| box_max[it as usize * 3 + axis] + margin >= cur_min);

        let cur_model = model_idx[cur as usize] as usize;
        let cur_min2 = box_min[cur as usize * 3 + axis2];
        let cur_max2 = box_max[cur as usize * 3 + axis2];
        let cur_min3 = box_min[cur as usize * 3 + axis3];
        let cur_max3 = box_max[cur as usize * 3 + axis3];

        for &oth in &active {
            let oth_model = model_idx[oth as usize] as usize;
            let same_model = cur_model == oth_model;

            if same_model {
                if same_model_allowed.get(cur_model).copied().unwrap_or(0) == 0 {
                    continue;
                }
            } else {
                let a_to_b = in_a.get(cur_model).copied().unwrap_or(0) != 0
                    && in_b.get(oth_model).copied().unwrap_or(0) != 0;
                let b_to_a = in_b.get(cur_model).copied().unwrap_or(0) != 0
                    && in_a.get(oth_model).copied().unwrap_or(0) != 0;
                if !a_to_b && !b_to_a {
                    continue;
                }
            }

            let oth_min2 = box_min[oth as usize * 3 + axis2];
            let oth_max2 = box_max[oth as usize * 3 + axis2];
            if cur_max2 + margin < oth_min2 - margin || cur_min2 - margin > oth_max2 + margin {
                continue;
            }
            let oth_min3 = box_min[oth as usize * 3 + axis3];
            let oth_max3 = box_max[oth as usize * 3 + axis3];
            if cur_max3 + margin < oth_min3 - margin || cur_min3 - margin > oth_max3 + margin {
                continue;
            }

            // eA=cur,eB=oth when sameModel or cur is the A-side of a cross
            // pair; otherwise swap so eA is always the group-A element —
            // matches _sweepAndPrune's `if (sameModel || (inA[cur]&&inB[oth]))`.
            let cur_is_a_side = same_model
                || (in_a.get(cur_model).copied().unwrap_or(0) != 0
                    && in_b.get(oth_model).copied().unwrap_or(0) != 0);
            if cur_is_a_side {
                pairs.push(cur);
                pairs.push(oth);
            } else {
                pairs.push(oth);
                pairs.push(cur);
            }
            pairs.push(if same_model { 1 } else { 0 });
        }

        active.push(cur);
    }

    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two boxes overlapping in all axes, same model, self-clash allowed.
    #[test]
    fn test_simple_overlap_same_model() {
        let box_min = vec![0.0, 0.0, 0.0, 0.5, 0.5, 0.5];
        let box_max = vec![1.0, 1.0, 1.0, 1.5, 1.5, 1.5];
        let model_idx = vec![0u32, 0u32];
        let in_a = vec![1u8];
        let in_b = vec![0u8];
        let same_model_allowed = vec![1u8];
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        // Sorted-order processing visits item 1 (larger min.x) as `cur` and
        // item 0 as `oth` from the active list — same-model pairs emit
        // [cur, oth], matching _sweepAndPrune's `eA:cur.el, eB:oth.el`
        // exactly (verified against the JS source, not assumed).
        assert_eq!(result, vec![1, 0, 1]); // idxA=1, idxB=0, sameModel=1
    }

    #[test]
    fn test_same_model_disallowed() {
        let box_min = vec![0.0, 0.0, 0.0, 0.5, 0.5, 0.5];
        let box_max = vec![1.0, 1.0, 1.0, 1.5, 1.5, 1.5];
        let model_idx = vec![0u32, 0u32];
        let in_a = vec![1u8];
        let in_b = vec![0u8];
        let same_model_allowed = vec![0u8]; // self-clash excluded
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_non_overlapping_boxes() {
        let box_min = vec![0.0, 0.0, 0.0, 10.0, 10.0, 10.0];
        let box_max = vec![1.0, 1.0, 1.0, 11.0, 11.0, 11.0];
        let model_idx = vec![0u32, 0u32];
        let in_a = vec![1u8];
        let in_b = vec![0u8];
        let same_model_allowed = vec![1u8];
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_margin_bridges_gap() {
        // Boxes 2 units apart on x; margin of 3 should bridge the gap.
        let box_min = vec![0.0, 0.0, 0.0, 3.0, 0.0, 0.0];
        let box_max = vec![1.0, 1.0, 1.0, 4.0, 1.0, 1.0];
        let model_idx = vec![0u32, 0u32];
        let in_a = vec![1u8];
        let in_b = vec![0u8];
        let same_model_allowed = vec![1u8];
        let no_margin = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert!(no_margin.is_empty(), "should not overlap with zero margin");
        let with_margin = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 3.0);
        assert_eq!(with_margin, vec![1, 0, 1]); // same [cur, oth] ordering as above
    }

    #[test]
    fn test_cross_model_a_to_b_orientation() {
        // Element 0 in model 0 (group A), element 1 in model 1 (group B).
        let box_min = vec![0.0, 0.0, 0.0, 0.5, 0.5, 0.5];
        let box_max = vec![1.0, 1.0, 1.0, 1.5, 1.5, 1.5];
        let model_idx = vec![0u32, 1u32];
        let in_a = vec![1u8, 0u8];
        let in_b = vec![0u8, 1u8];
        let same_model_allowed = vec![0u8, 0u8]; // irrelevant, no same-model pairs here
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert_eq!(result, vec![0, 1, 0]); // idxA=0 (group A), idxB=1 (group B), sameModel=0
    }

    #[test]
    fn test_cross_model_b_to_a_orientation_swaps() {
        // Element 0 in model 1 (group B), element 1 in model 0 (group A) —
        // sweep visits element 0 first (sorted by position), but the pair
        // must still come out oriented A-then-B, i.e. swapped.
        let box_min = vec![0.0, 0.0, 0.0, 0.5, 0.5, 0.5];
        let box_max = vec![1.0, 1.0, 1.0, 1.5, 1.5, 1.5];
        let model_idx = vec![1u32, 0u32];
        let in_a = vec![1u8, 0u8]; // model 0 = A
        let in_b = vec![0u8, 1u8]; // model 1 = B
        let same_model_allowed = vec![0u8, 0u8];
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert_eq!(result, vec![1, 0, 0]); // idxA=1 (model 0, group A), idxB=0 (model 1, group B)
    }

    #[test]
    fn test_cross_model_neither_direction_excluded() {
        // Two different models, neither is a valid A->B or B->A pair
        // (both only in group A, say) — must be excluded.
        let box_min = vec![0.0, 0.0, 0.0, 0.5, 0.5, 0.5];
        let box_max = vec![1.0, 1.0, 1.0, 1.5, 1.5, 1.5];
        let model_idx = vec![0u32, 1u32];
        let in_a = vec![1u8, 1u8]; // both in A
        let in_b = vec![0u8, 0u8]; // neither in B
        let same_model_allowed = vec![0u8, 0u8];
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_fewer_than_two_items_returns_empty() {
        let result = sweep_and_prune(&[0.0, 0.0, 0.0], &[1.0, 1.0, 1.0], &[0u32], &[1u8], &[0u8], &[1u8], 0.0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_dense_cluster_matches_naive_pair_count() {
        // 20 boxes all mutually overlapping (same-model, self-clash
        // allowed) at the origin — naive O(n^2) expectation: n*(n-1)/2 pairs.
        let n = 20;
        let mut box_min = Vec::new();
        let mut box_max = Vec::new();
        let mut model_idx = Vec::new();
        for i in 0..n {
            let off = (i as f64) * 0.01; // tiny offsets, all still overlapping
            box_min.push(off); box_min.push(off); box_min.push(off);
            box_max.push(off + 1.0); box_max.push(off + 1.0); box_max.push(off + 1.0);
            model_idx.push(0u32);
        }
        let in_a = vec![1u8];
        let in_b = vec![0u8];
        let same_model_allowed = vec![1u8];
        let result = sweep_and_prune(&box_min, &box_max, &model_idx, &in_a, &in_b, &same_model_allowed, 0.0);
        assert_eq!(result.len() / 3, n * (n - 1) / 2);
    }
}
