/** Share of a gap that remains after one step of a process with the given half-life (in steps). */
export function retention(halfLife: number): number {
  return 0.5 ** (1 / halfLife);
}

/** Moves `current` toward `target`, closing half of the remaining gap every `halfLife` steps. */
export function approach(current: number, target: number, halfLife: number): number {
  return target + (current - target) * retention(halfLife);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Root of a non-decreasing function `f` on [lo, hi], where f(lo) <= 0 <= f(hi), by bisection. */
export function bisectIncreasing(f: (x: number) => number, lo: number, hi: number): number {
  for (let i = 0; i < 100 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
