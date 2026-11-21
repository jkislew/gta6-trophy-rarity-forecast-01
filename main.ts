// Leonida Earners — GTA VI trophy rarity forecaster.
//
// Idea in one paragraph: an earn rate printed by Exophase is a count in
// disguise. rate * players / 100 is (very nearly) an integer number of
// earners, and the page only changes at refresh moments, so the history
// is a staircase, not a smooth series. This program collapses the
// staircase into refresh epochs, rebuilds the two underlying counts —
// tracked players and per-trophy earners — and extrapolates both in
// log-time. The headline median, though, is led by the direct logit
// trend of the rate itself: over a multi-day horizon the players
// extrapolation proved to be the noisiest link, so the counts ratio
// (earners over players) is kept as a bounded sanity check on the
// trend, not as an equal partner. Players still dilute and earners
// still accumulate; the model just refuses to let its weakest
// estimate steer the answer.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- helpers

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function logitOfPercent(ratePct: number): number {
  const p = clampNum(ratePct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function percentFromLogit(z: number): number {
  const p = 1 / (1 + Math.exp(-clampNum(z, -30, 30)));
  return p * 100;
}

// Acklam's rational approximation to the inverse normal CDF. Pure
// arithmetic, so the forecast stays a deterministic function of the case.
function invNormalCdf(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285984469534e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ------------------------------------------------------- case data shapes

interface TrophyInfo {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Epoch {
  atMs: number;
  players: number;
  rates: Array<number | null>;
}

interface CaseData {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date?: string };
  trophies: TrophyInfo[];
  history: Array<{
    at?: string;
    slot?: string;
    players_tracked: number;
    rates: Array<number | null>;
  }>;
}

// ------------------------------------------------------------ time coding

// Log-time measured from the game's release midnight. Trophy earning is
// a cumulative process in log-time: the first hour matters as much as a
// later day, and straight lines in this coordinate are power laws in
// clock time, which is the right family for both counts.
function logTimeOf(ms: number, originMs: number): number {
  const hours = (ms - originMs) / 3600000;
  return Math.log(Math.max(0.05, 1 + hours));
}

function originFor(data: CaseData, fallbackMs: number): number {
  const rd = data.game && data.game.release_date ? Date.parse(data.game.release_date + "T00:00:00Z") : NaN;
  return Number.isFinite(rd) ? rd : fallbackMs;
}

// -------------------------------------------------------- epoch staircase

// Consecutive reads that print the same players count and the same rates
// are one refresh epoch wearing several timestamps. Keep one row per
// epoch, stamped with the LAST read that still showed it: that is the
// moment the state is known to have survived until.
function collapseEpochs(data: CaseData): Epoch[] {
  const epochs: Epoch[] = [];
  for (const read of data.history) {
    const atMs = Date.parse(read.at ?? read.slot ?? data.at);
    const keyPlayers = read.players_tracked;
    const prev = epochs.length > 0 ? epochs[epochs.length - 1] : null;
    let same = false;
    if (prev && prev.players === keyPlayers && prev.rates.length === read.rates.length) {
      same = true;
      for (let i = 0; i < read.rates.length; i++) {
        if (prev.rates[i] !== read.rates[i]) { same = false; break; }
      }
    }
    if (same && prev) {
      prev.atMs = atMs;
    } else {
      epochs.push({ atMs, players: keyPlayers, rates: read.rates.slice() });
    }
  }
  return epochs;
}

// ------------------------------------------------------ weighted fitting

interface LineFit {
  slope: number;
  intercept: number;
  residSd: number;
  n: number;
}

// Weighted least squares of y on x. Recency weights grow geometrically so
// the mature part of the staircase steers the line more than launch
// night does, without discarding the early reads outright.
function fitLine(xs: number[], ys: number[], recency: number[]): LineFit {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0, residSd: 0, n: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0], residSd: 0, n: 1 };
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sw += recency[i]; sx += recency[i] * xs[i]; sy += recency[i] * ys[i]; }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += recency[i] * dx * dx;
    sxy += recency[i] * dx * (ys[i] - my);
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (intercept + slope * xs[i]);
    sr += recency[i] * e * e;
  }
  return { slope, intercept, residSd: Math.sqrt(sr / sw), n };
}

function recencyWeights(n: number): number[] {
  const w: number[] = [];
  for (let i = 0; i < n; i++) w.push(Math.pow(0.86, n - 1 - i) + 0.25);
  return w;
}

// ------------------------------------------------------------ trophy kind

type TrophyKind = "completion" | "story" | "grind" | "money" | "misc";

function kindOf(t: TrophyInfo): TrophyKind {
  const desc = (t.description || "").toLowerCase();
  const name = (t.name || "").toLowerCase();
  if (t.tier === "platinum") return "completion";
  if (desc.includes("100%") || name.includes("long road")) return "completion";
  if (desc.startsWith("complete") || desc.includes("chapter")) return "story";
  if (desc.includes("$") || desc.includes("spend") || desc.includes("launder") || desc.includes("garage") || desc.includes("vehicle")) return "money";
  if (t.tier === "silver" || t.tier === "gold") return "grind";
  return "misc";
}

// ------------------------------------------------------------- forecasting

const RW_SIGMA = 0.45; // random-walk spread per sqrt(day) on the logit scale

interface TrophyForecast {
  id: number;
  q: number[];
}

function forecastCase(data: CaseData): TrophyForecast[] {
  const trophies = data.trophies;
  const epochs = collapseEpochs(data);
  if (epochs.length === 0 || trophies.length === 0) return [];
  const firstMs = epochs[0].atMs;
  const originMs = originFor(data, firstMs);
  const targetMs = Date.parse(data.target);
  const atMs = Date.parse(data.at);
  const horizonMin = Number.isFinite(data.horizon_minutes) && data.horizon_minutes > 0
    ? data.horizon_minutes
    : Math.max(1, (targetMs - atMs) / 60000);
  const horizonDays = horizonMin / 1440;

  const xs = epochs.map((e) => logTimeOf(e.atMs, originMs));
  const xLast = xs[xs.length - 1];
  const xTarget = logTimeOf(targetMs, originMs);
  const dx = Math.max(0.05, xTarget - xLast);
  const weights = recencyWeights(epochs.length);
  const lastEpoch = epochs[epochs.length - 1];

  // --- tracked players at the target -----------------------------------
  // Fit log(players) on log-time, then blend with a sublinear power-law
  // prior. The prior matters when the recorded staircase has not moved
  // yet (no refresh inside the history): a frozen page does not mean a
  // frozen player base, and assuming so is exactly how persistence
  // entries walk into a refresh.
  const logPlayers = epochs.map((e) => Math.log(Math.max(1, e.players)));
  const playerFit = fitLine(xs, logPlayers, weights);
  const logPLast = logPlayers[logPlayers.length - 1];
  const logPFitted = logPLast + clampNum(playerFit.slope, -0.2, 3.0) * dx;
  const hoursLast = Math.max(0.05, (lastEpoch.atMs - originMs) / 3600000);
  const hoursTarget = Math.max(hoursLast + 0.02, (targetMs - originMs) / 3600000);
  const logPPrior = logPLast + 0.55 * Math.log((1 + hoursTarget) / (1 + hoursLast));
  const priorSlope = (logPPrior - logPLast) / dx;
  const fittedSlope = (logPFitted - logPLast) / dx;
  const logPTarget = fittedSlope >= priorSlope ? logPFitted : 0.55 * logPFitted + 0.45 * logPPrior;
  const playersTarget = clampNum(Math.exp(logPTarget), lastEpoch.players * 0.98, lastEpoch.players * 25);

  // --- per-trophy raw fits ----------------------------------------------
  interface RawFit {
    idx: number;
    kind: TrophyKind;
    lastRate: number;
    lastEarners: number;
    logitFit: LineFit;
    earnerFit: LineFit;
  }
  const raw: RawFit[] = [];
  for (let idx = 0; idx < trophies.length; idx++) {
    const logitYs: number[] = [];
    const earnerYs: number[] = [];
    const useX: number[] = [];
    const useW: number[] = [];
    let lastRate = 0;
    let lastEarners = 0;
    for (let e = 0; e < epochs.length; e++) {
      const rate = epochs[e].rates[idx];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      const earners = Math.round((rate / 100) * epochs[e].players);
      logitYs.push(logitOfPercent(rate));
      earnerYs.push(Math.log(earners + 0.5));
      useX.push(xs[e]);
      useW.push(weights[e]);
      lastRate = rate;
      lastEarners = earners;
    }
    raw.push({
      idx,
      kind: kindOf(trophies[idx]),
      lastRate,
      lastEarners,
      logitFit: fitLine(useX, logitYs, useW),
      earnerFit: fitLine(useX, earnerYs, useW),
    });
  }

  // --- pool slopes and residuals within each kind ------------------------
  const kinds: TrophyKind[] = ["completion", "story", "grind", "money", "misc"];
  const poolLogitSlope = new Map<TrophyKind, number>();
  const poolEarnerSlope = new Map<TrophyKind, number>();
  const poolResid = new Map<TrophyKind, number>();
  for (const k of kinds) {
    const members = raw.filter((r) => r.kind === k && r.logitFit.n >= 2);
    if (members.length === 0) {
      poolLogitSlope.set(k, 0);
      poolEarnerSlope.set(k, 0);
      poolResid.set(k, 0.35);
      continue;
    }
    poolLogitSlope.set(k, members.reduce((s, r) => s + r.logitFit.slope, 0) / members.length);
    poolEarnerSlope.set(k, members.reduce((s, r) => s + r.earnerFit.slope, 0) / members.length);
    poolResid.set(k, Math.sqrt(members.reduce((s, r) => s + r.logitFit.residSd * r.logitFit.residSd, 0) / members.length));
  }
  const allResid = Math.sqrt(raw.reduce((s, r) => s + r.logitFit.residSd * r.logitFit.residSd, 0) / Math.max(1, raw.length));

  // --- combine into medians and spreads ----------------------------------
  const levels = data.levels && data.levels.length === 5 ? data.levels : [0.05, 0.25, 0.5, 0.75, 0.95];
  const zs = levels.map((lv) => invNormalCdf(clampNum(lv, 0.001, 0.999)));
  const out: TrophyForecast[] = [];

  for (const r of raw) {
    const t = trophies[r.idx];
    const logitSlope = clampNum(0.55 * r.logitFit.slope + 0.45 * (poolLogitSlope.get(r.kind) ?? 0), -1.6, 2.6);
    const earnerSlope = clampNum(0.55 * r.earnerFit.slope + 0.45 * (poolEarnerSlope.get(r.kind) ?? 0), -1.2, 3.2);
    const logitLast = logitOfPercent(r.lastRate);

    // Two views of the median. v2 evidence (multi-scenario lab, two
    // independent ground-truth families) demoted the counts view: its
    // players extrapolation is the weakest link in the chain, and a
    // 45% blend weight dragged the median toward that error on every
    // long-horizon scenario tested. The direct logit trend now leads;
    // the counts view survives only as a bounded sanity nudge, capped
    // at a fifth of a logit, so a genuine divergence between the two
    // views can still pull the median a little without steering it.
    const logitDirect = logitLast + logitSlope * dx;
    const earnersHat = Math.max(0, Math.exp(Math.log(r.lastEarners + 0.5) + earnerSlope * dx) - 0.5);
    const rateFromCounts = clampNum((earnersHat / playersTarget) * 100, 0.01, 99.99);
    const countsLogit = logitOfPercent(rateFromCounts);
    let medianLogit = logitDirect + clampNum(0.15 * (countsLogit - logitDirect), -0.2, 0.2);

    // Spread: random walk over the horizon plus fit uncertainty.
    const classResid = poolResid.get(r.kind) ?? allResid;
    const sFit = 0.7 * Math.sqrt(0.5 * r.logitFit.residSd * r.logitFit.residSd + 0.5 * classResid * classResid);
    let sigma = Math.min(1.35, Math.sqrt(RW_SIGMA * RW_SIGMA * horizonDays + sFit * sFit + 0.01));
    let sigmaDown = sigma;
    let sigmaUp = sigma;

    if (r.lastEarners <= 10) {
      // A handful of earners is a Poisson story, not a trend: keep the
      // median honest and pay for the uncertainty in the tails.
      sigma *= 1.3; sigmaDown *= 1.3; sigmaUp *= 1.3;
    }

    if (r.kind === "completion") {
      // Platinum and 100% completion take hundreds of hours; inside a
      // week only a handful of players arrive, however the early slope
      // looks. Cap the median's logit climb and widen a little.
      const cap = logitLast + 0.30 + 0.10 * horizonDays;
      if (medianLogit > cap) medianLogit = cap;
      sigma *= 1.15; sigmaDown *= 1.15; sigmaUp *= 1.15;
    }

    if (r.lastRate >= 99.5) {
      // The introductory trophy: nearly every tracked player holds it.
      // New arrivals earn it fast but not instantly, so model the small
      // dilution explicitly and let the lower tail do the worrying.
      const fresh = Math.max(0, playersTarget - lastEpoch.players);
      const earnersIntro = r.lastEarners + 0.985 * fresh;
      const introRate = clampNum((earnersIntro / playersTarget) * 100, 96, 99.97);
      medianLogit = logitOfPercent(introRate);
      sigmaDown = Math.max(0.65, sigma * 1.5);
      sigmaUp = Math.max(0.08, sigma * 0.3);
    }

    const qs: number[] = [];
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      let s = z < 0 ? sigmaDown : sigmaUp;
      // Refresh shocks are fat-tailed: the 5% and 95% bands carry a
      // wider multiplier than the interquartile pair, in the spirit of
      // a t-band rather than a purely Gaussian one.
      if (Math.abs(z) > 1.2) s *= 1.14;
      qs.push(round4(clampNum(percentFromLogit(medianLogit + z * s), 0.01, 99.99)));
    }
    for (let i = 1; i < qs.length; i++) if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
    out.push({ id: t.id, q: qs });
  }
  return out;
}

// -------------------------------------------------------------------- main

function runAll(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outputDir, { recursive: true });
  const names = readdirSync(inputDir).filter((f) => f.endsWith(".in")).sort();
  for (const name of names) {
    const text = readFileSync(join(inputDir, name), "utf8");
    const data = JSON.parse(text) as CaseData;
    const rows = forecastCase(data);
    const payload = JSON.stringify({ trophies: rows }) + "\n";
    // The output name follows the input file's own stem, which is the
    // case id the grader staged — safer than trusting a field inside
    // the JSON to spell it the same way.
    const stem = name.slice(0, name.length - ".in".length);
    writeFileSync(join(outputDir, stem + ".out"), payload);
  }
}

runAll();
