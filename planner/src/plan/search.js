// Minimum-anchor search (guide 9.4 and 15). Order of work:
//   1. Lower bound LB (capacity bound; valid for this candidate set).
//   2. Greedy construction + redundancy pruning gives a guaranteed layout of size U.
//   3. For k = LB, LB+1, ... U-1: seeded local search for a k-anchor layout that meets the criterion.
//      The first k that succeeds wins. If none does, U stands.
// BUDGET is counted in EVALUATIONS (one candidate placement scored, or one swap tried), not seconds,
// so a result depends only on the inputs and seed, never on the machine.
// Labels: k == LB gives "minimum for this candidate set (proven)"; anything else is "best found within search budget".
import { rng } from "../core/rng.js";
import { lowerBound, evaluateLayout, naiveGridLayout, naiveMinAnchors } from "./coverage.js";

export const LABELS = Object.freeze({
  proven: "Minimum for this candidate set, grid and range (proven)",
  best_found: "Best found within search budget (not proven minimal)",
  not_met: "Coverage criterion not met",
});

export async function searchMinimumAnchors(p, { seed = 1, budget = 20000, max_anchors = 40, yieldEvery = 500, yieldFn = null, shouldStop = null } = {}) {
  if (!Number.isInteger(budget) || budget <= 0) throw new RangeError("Search budget must be a positive whole number.");
  if (!Number.isInteger(max_anchors) || max_anchors < 1) throw new RangeError("Maximum anchors must be a positive whole number.");
  const rand = rng(seed), { N, vis, seeing, required: req } = p, M = p.candidates.length;
  const LB = lowerBound(p);
  let evals = 0, since = 0, stopped = false;
  const levels = [];

  const canSpend = () => evals < budget && !stopped;
  async function tick() {
    evals++;
    if (++since >= yieldEvery) { since = 0; if (yieldFn) await yieldFn(); if (shouldStop?.()) stopped = true; }
  }
  const add = (state, j) => { for (const c of vis[j]) { if (state.count[c] < req[c]) state.deficit--; state.count[c]++; } };
  const remove = (state, j) => { for (const c of vis[j]) { state.count[c]--; if (state.count[c] < req[c]) state.deficit++; } };
  const fresh = () => ({ count: new Int16Array(N), deficit: p.sumRequired });

  async function greedy(limit) {
    const s = fresh(), chosen = [], inSet = new Uint8Array(M);
    let exhausted = false;
    while (s.deficit > 0 && chosen.length < limit) {
      let bestGain = 0, best = -1;
      for (let j = 0; j < M; j++) {
        if (inSet[j]) continue;
        if (!canSpend()) { exhausted = true; break; }
        await tick();
        let g = 0; for (const c of vis[j]) if (s.count[c] < req[c]) g++;
        if (g > bestGain) { bestGain = g; best = j; }
      }
      if (best < 0) break;
      add(s, best); chosen.push(best); inSet[best] = 1;
      if (exhausted) break;
    }
    return { chosen, state: s, exhausted };
  }

  async function prune(layout, state) {
    const kept = [...layout];
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!canSpend()) break;
      await tick();
      if (vis[kept[i]].every((c) => state.count[c] > req[c])) { remove(state, kept[i]); kept.splice(i, 1); }
    }
    return kept;
  }

  async function searchLevel(k, allot, order) {
    const limit = Math.min(budget, evals + allot);
    let best = null;
    for (let restart = 0; evals < limit && !stopped; restart++) {
      const layout = restart === 0 ? order.slice(0, k) : best ? [...best.layout] : Array.from({ length: k }, () => Math.floor(rand() * M));
      if (restart > 0 && best) for (let t = 0; t < Math.ceil(k / 3); t++) layout[Math.floor(rand() * k)] = Math.floor(rand() * M);
      const inSet = new Set(layout);
      if (inSet.size < layout.length) { restart--; if (!canSpend()) break; await tick(); continue; } // random start had duplicates
      const s = fresh();
      for (const j of layout) { if (!canSpend()) return best && best.deficit === 0 ? best : null; await tick(); add(s, j); }
      for (let trial = 0, maxTrials = 40 * k + 400; s.deficit > 0 && trial < maxTrials && evals < limit && !stopped; trial++) {
        await tick();
        let cell = -1;
        for (let t = 0; t < 30; t++) { const c = Math.floor(rand() * N); if (s.count[c] < req[c]) { cell = c; break; } }
        if (cell < 0) cell = Math.floor(rand() * N);
        const cand = seeing[cell];
        if (!cand.length) continue;
        const j = cand[Math.floor(rand() * cand.length)];
        if (inSet.has(j)) continue;
        const i = Math.floor(rand() * k), old = layout[i], before = s.deficit;
        remove(s, old); add(s, j);
        if (s.deficit > before) { remove(s, j); add(s, old); }
        else { inSet.delete(old); inSet.add(j); layout[i] = j; }
      }
      if (!best || s.deficit < best.deficit) best = { layout: [...layout], deficit: s.deficit };
      if (s.deficit === 0) return best;
    }
    return best && best.deficit === 0 ? best : null;
  }

  // ---- 2. baseline
  const g = await greedy(max_anchors);
  let finalLayout = g.chosen, status, reason = null, proven = false, U = null;
  if (g.state.deficit > 0) {
    status = "not_met";
    reason = p.infeasible > 0 ? "infeasible_cells" : stopped ? "stopped" : g.exhausted ? "budget" : "max_anchors";
  } else {
    finalLayout = await prune(g.chosen, g.state);
    U = finalLayout.length; status = "met";
    // ---- 3. ascending search below U
    for (let k = Math.min(LB, U); k < U && !stopped; k++) {
      const before = evals, allot = Math.floor((budget - evals) / (U - k));
      if (allot <= 0) break;
      const r = await searchLevel(k, allot, g.chosen);
      levels.push({ k, evaluations: evals - before, success: !!r });
      if (r) { finalLayout = r.layout; break; }
    }
    proven = finalLayout.length === LB;
  }

  const sorted = [...finalLayout].sort((a, b) => p.candidates[a].x - p.candidates[b].x || p.candidates[a].y - p.candidates[b].y);
  const metrics = evaluateLayout(p, sorted);
  const { counts, ...coverage } = metrics;
  const k = sorted.length;
  const naiveSame = evaluateLayout(p, naiveGridLayout(p, k));
  const { counts: _c, ...naiveCoverage } = naiveSame;
  const naiveMin = naiveMinAnchors(p, Math.max(max_anchors, k));
  return {
    status, reason, proven,
    label: status === "not_met" ? LABELS.not_met : proven ? LABELS.proven : LABELS.best_found,
    k, lower_bound: LB, greedy_pruned_size: U,
    anchors: sorted.map((j, i) => ({ anchor_id: i, x_m: p.candidates[j].x, y_m: p.candidates[j].y, candidate_index: j })),
    coverage,
    infeasible: { cells: p.infeasible, fraction: p.infeasible / p.N },
    search: { seed, budget, evaluations_used: evals, max_anchors, levels, stopped, candidates: p.candidates.length,
      candidate_spacing_m: p.options.candidate_spacing_m, mounting: p.options.mounting, min_wall_clearance_m: p.options.min_wall_clearance_m },
    naive_grid: { same_k: naiveCoverage, min_k_to_meet: naiveMin, note: "Evenly spaced grid snapped to the same candidate positions. Not counted in the search budget." },
    exceeds_model_slots: k > 8,
    _layout: sorted,
  };
}
