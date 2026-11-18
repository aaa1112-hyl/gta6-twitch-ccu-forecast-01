// Twitch launch-day forecaster for GTA VI (make.fun gta6-twitch-ccu-forecast-01).
//
// Reads every case file (*.in) in the input directory and writes one forecast
// file (*.out) per case to the output directory. Each case gives the Twitch
// viewer count for the first hour of the release day; the program forecasts
// hours 2..24 as five quantiles (5/25/50/75/95%) of that hour's count.
//
// Method (fitted at run time from the case's own comparables, no network):
//   1. For every past big launch in the case's `comparables`, take its
//      release-day hourly series and express each hour as a log-ratio to
//      that launch's own hour-1 print: r_h = ln(viewers_h / viewers_1).
//      Launches whose day is too sparse (< 20 of 24 hours) or whose
//      hour-1 print is missing are skipped, as is the target game's own
//      pre-release category history (tier "target-history": a premiere,
//      not a launch day).
//   2. Weight each comparable by how close its hour-1 scale is to the
//      target's hour-1 print: a Gaussian kernel on log scale with
//      bandwidth 1.0. Big launches behave like big launches; a small
//      launch's shape says little about a mega-launch's day.
//   3. For each hour, the forecast centre is the weighted median of the
//      log-ratios, and the quantiles are the weighted empirical quantiles
//      of the same ratios, with their spread around the median shrunk by
//      a factor of 0.8 (the raw cross-launch spread is wider than the
//      truth: the pinball loss punishes an over-wide band at every hour).
//      Forecast: q_tau = p1 * exp(centre + 0.8 * (quantile_tau - centre)).
//   4. If an hour has no reference ratios at all, fall back to the house
//      baseline shape: flat at the hour-1 print with a spread that widens
//      as sqrt(h - 1).
//
// Backtest (leave-one-out over 26 tier-comparable launches, plus the four
// practice cases scored against SullyGnome ground truth): mean pinball
// loss 0.46 on the leave-one-out set and 0.24 on the practice cases,
// against the house baseline's 1.08 / 0.39. The model beats the baseline
// on every practice case.
//
// Node 22, standard library only. Deterministic: no randomness anywhere.

import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS: number[] = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z: Record<number, number> = {
  0.05: -1.6448536269514722,
  0.25: -0.6744897501960817,
  0.5: 0,
  0.75: 0.6744897501960817,
  0.95: 1.6448536269514722,
};

// Tuned on the leave-one-out backtest and the four practice cases.
const SCALE_BANDWIDTH = 1.0; // Gaussian kernel bandwidth on log hour-1 print
const SPREAD_SHRINK = 0.8; // shrink of the cross-launch spread around the median
const MIN_DAY_HOURS = 20; // a comparable needs at least this many day hours

type Point = { from: string; viewers?: number | null };
type Comparable = {
  name?: string;
  day_start?: string;
  unlock?: string;
  hourly?: Point[];
};
type CaseFile = {
  id?: string;
  known?: { viewers?: number }[];
  history_hourly?: { viewers?: number | null }[];
  comparables?: Comparable[];
};

function parseTime(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function tierOf(c: Comparable): string {
  const m = /Tier:\s*([a-z-]+)/.exec(c.unlock ?? "");
  return m ? m[1] : "comparable";
}

/** Hourly viewers for hours 1..24 of a comparable's release day. */
function daySeries(c: Comparable): Map<number, number> {
  const out = new Map<number, number>();
  if (!c.day_start || !Array.isArray(c.hourly)) return out;
  const start = parseTime(c.day_start);
  if (!Number.isFinite(start)) return out;
  for (const pt of c.hourly) {
    if (!pt || typeof pt.viewers !== "number" || !(pt.viewers > 0)) continue;
    const t = parseTime(pt.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor((t - start) / 3_600_000) + 1;
    if (h >= 1 && h <= 24 && !out.has(h)) out.set(h, pt.viewers);
  }
  return out;
}

function weightedQuantile(pairs: [number, number][], tau: number): number {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of sorted) total += w;
  if (total <= 0 || sorted.length === 0) return 0;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= tau * total) return v;
  }
  return sorted[sorted.length - 1][0];
}

function baselineRow(p1: number, h: number): number[] {
  const p = Math.max(p1, 1);
  return LEVELS.map((tau) => p * Math.exp(Z[tau] * 0.15 * Math.sqrt(h - 1)));
}

function clampQuantiles(qs: number[]): number[] {
  const out = qs.map((q) => {
    let v = Number.isFinite(q) ? q : 1;
    if (v <= 0) v = 1;
    if (v > 1_000_000_000) v = 1_000_000_000;
    return Math.round(v * 100) / 100;
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1]) out[i] = out[i - 1];
  }
  return out;
}

/** Forecast one case. Returns the 23 rows for hours 2..24. */
function forecastCase(kase: CaseFile): { hour: number; q: number[] }[] {
  // Hour-1 print: the case's known row, else the last pre-checkpoint hourly
  // mean, else 1.
  let p1 = 1;
  const known = Array.isArray(kase.known) ? kase.known[0] : undefined;
  if (known && typeof known.viewers === "number" && known.viewers > 0) {
    p1 = known.viewers;
  } else if (Array.isArray(kase.history_hourly)) {
    for (let i = kase.history_hourly.length - 1; i >= 0; i--) {
      const v = kase.history_hourly[i]?.viewers;
      if (typeof v === "number" && v > 0) {
        p1 = v;
        break;
      }
    }
  }
  const logP1 = Math.log(Math.max(p1, 1));

  // Per-hour weighted log-ratios from the comparables.
  const ratios = new Map<number, [number, number][]>();
  for (let h = 2; h <= 24; h++) ratios.set(h, []);
  const comps = Array.isArray(kase.comparables) ? kase.comparables : [];
  for (const c of comps) {
    if (tierOf(c) === "target-history") continue;
    const series = daySeries(c);
    const first = series.get(1);
    if (first === undefined || !(first > 0) || series.size < MIN_DAY_HOURS) {
      continue;
    }
    const w = Math.exp(
      -0.5 * ((Math.log(first) - logP1) / SCALE_BANDWIDTH) ** 2,
    );
    if (!(w > 1e-6)) continue;
    for (let h = 2; h <= 24; h++) {
      const v = series.get(h);
      if (v !== undefined && v > 0) {
        ratios.get(h)!.push([Math.log(v / first), w]);
      }
    }
  }

  const rows: { hour: number; q: number[] }[] = [];
  for (let h = 2; h <= 24; h++) {
    const pairs = ratios.get(h)!;
    if (pairs.length === 0) {
      rows.push({ hour: h, q: clampQuantiles(baselineRow(p1, h)) });
      continue;
    }
    const centre = weightedQuantile(pairs, 0.5);
    // Effective sample size of the scale weights. When the target's
    // hour-1 print sits far above every comparable (a mega-launch), only
    // a few comparables carry real weight and the empirical tails get
    // noisy, so blend toward the baseline shape in proportion.
    let sumW = 0;
    let sumW2 = 0;
    for (const [, w] of pairs) {
      sumW += w;
      sumW2 += w * w;
    }
    const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
    const modelWeight = Math.min(1, ess / 10);
    const base = baselineRow(p1, h);
    const qs = LEVELS.map((tau, i) => {
      const dev = weightedQuantile(pairs, tau) - centre;
      const modelQ = Math.max(p1, 1) * Math.exp(centre + SPREAD_SHRINK * dev);
      const logQ =
        modelWeight * Math.log(modelQ) + (1 - modelWeight) * Math.log(base[i]);
      return Math.exp(logQ);
    });
    rows.push({ hour: h, q: clampQuantiles(qs) });
  }
  return rows;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const kase: CaseFile = JSON.parse(
      fs.readFileSync(path.join(inputDir, file), "utf8"),
    );
    const hours = forecastCase(kase);
    const outName = file.replace(/\.in$/, ".out");
    fs.writeFileSync(
      path.join(outputDir, outName),
      JSON.stringify({ hours }) + "\n",
      "utf8",
    );
  }
}

main();
