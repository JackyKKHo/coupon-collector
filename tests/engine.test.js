/**
 * Checks the JS engine against closed-form answers, not against the old Python.
 * Every case here has an exact analytic value, so this catches a wrong port and
 * a wrong original equally well.
 *
 * Run: node tests/engine.test.js
 */
"use strict";

const CM = require("../assets/coupon.js");

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "  -> " + detail : ""));
  }
}

function close(name, actual, expected, relTol) {
  const tol = relTol === undefined ? 1e-9 : relTol;
  const denom = Math.abs(expected) > 0 ? Math.abs(expected) : 1;
  const rel = Math.abs(actual - expected) / denom;
  ok(name, rel <= tol, `got ${actual}, want ${expected} (rel ${rel.toExponential(2)})`);
}

function throws(name, fn) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(name, threw, "expected a throw");
}

const g = (q, k, n) => ({ q, k, n: n === undefined ? 1 : n });

// -- special functions -------------------------------------------------------

console.log("\nspecial functions");

close("logGamma(1) = 0", CM.logGamma(1), 0, 1e-12);
close("logGamma(5) = log(24)", CM.logGamma(5), Math.log(24), 1e-12);
close("logGamma(0.5) = log(sqrt(pi))", CM.logGamma(0.5), 0.5 * Math.log(Math.PI), 1e-12);
close("logGamma(101) = log(100!)", CM.logGamma(101), 363.73937555556349, 1e-12);

// P(1, x) = 1 - e^-x, the exponential CDF.
close("gammainc(1, 2)", CM.gammainc(1, 2), 1 - Math.exp(-2), 1e-13);
// P(2, x) = 1 - e^-x (1 + x)
close("gammainc(2, 3)", CM.gammainc(2, 3), 1 - Math.exp(-3) * 4, 1e-13);
// P(3, 1e-4) is ~1.67e-13, so the obvious reference `1 - e^-x(1 + x + x^2/2)`
// is itself junk here — it cancels away all but a couple of digits. The value
// below is scipy.special.gammainc(3, 1e-4), which uses the series and keeps
// full relative precision, same as the log form under test.
close("logGammaP deep left tail", CM.logGammaP(3, 1e-4),
  Math.log(1.6665416716665328e-13), 1e-14);
ok("logGammaP survives underflow",
  CM.logGammaP(5, 1e-70) < -700 && isFinite(CM.logGammaP(5, 1e-70)),
  String(CM.logGammaP(5, 1e-70)));

// psi(1) = -gamma
close("digamma(1)", CM.digamma(1), -0.5772156649015329, 1e-12);
// H(n) for small integers
close("harmonicNumber(1)", CM.harmonicNumber(1), 1, 1e-12);
close("harmonicNumber(4)", CM.harmonicNumber(4), 1 + 1 / 2 + 1 / 3 + 1 / 4, 1e-12);

// -- expected value ----------------------------------------------------------

console.log("\nexpected value");

// One item: T ~ Gamma(k, q), so E[T] = k/q exactly.
close("single item 1/3000, k=1", CM.expectedTrials([g(1 / 3000, 1)]).T, 3000, 1e-9);
close("single item 1/3000, k=5", CM.expectedTrials([g(1 / 3000, 5)]).T, 15000, 1e-9);
close("single item 1/5, k=1", CM.expectedTrials([g(0.2, 1)]).T, 5, 1e-9);
close("single item 1/5e6, k=3", CM.expectedTrials([g(1 / 5e6, 3)]).T, 15e6, 1e-9);

// n equal-rate items at k=1: T = max of n iid exponentials, E[T] = H(n)/q.
function harmonic(n) {
  let s = 0;
  for (let i = 1; i <= n; i++) s += 1 / i;
  return s;
}
close("15 items at 1/360 (grouped)", CM.expectedTrials([g(1 / 360, 1, 15)]).T,
  360 * harmonic(15), 1e-9);
close("classic coupon collector, 50 items at 1/50",
  CM.expectedTrials([g(1 / 50, 1, 50)]).T, 50 * harmonic(50), 1e-9);
close("500 items at 1/500", CM.expectedTrials([g(1 / 500, 1, 500)]).T,
  500 * harmonic(500), 1e-9);

// Grouping must be an optimisation only: n identical items as one group has to
// equal the same items listed separately.
{
  const grouped = CM.expectedTrials([g(1 / 360, 1, 12)]).T;
  const expanded = CM.expectedTrials(Array.from({ length: 12 }, () => g(1 / 360, 1, 1))).T;
  close("grouped == expanded", grouped, expanded, 1e-12);
}

// Mixed rates at k=1: T = max of independent exponentials, exactly
//   E[T] = sum over nonempty subsets S of (-1)^(|S|+1) / sum_{i in S} q_i
function maxExponentialMean(qs) {
  const n = qs.length;
  let total = 0;
  for (let mask = 1; mask < (1 << n); mask++) {
    let s = 0;
    let bits = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { s += qs[i]; bits++; }
    }
    total += (bits % 2 === 1 ? 1 : -1) / s;
  }
  return total;
}
{
  const qs = [1 / 10, 1 / 25, 1 / 100];
  const groups = qs.map(q => g(q, 1));
  close("mixed rates 1/10,1/25,1/100", CM.expectedTrials(groups).T,
    maxExponentialMean(qs), 1e-9);
}
{
  // Deliberately nasty: rates spanning five orders of magnitude, which is what
  // the rescaling in expectedTrials exists to survive.
  const qs = [1 / 2, 1 / 500, 1 / 20000, 1 / 3000000];
  const groups = qs.map(q => g(q, 1));
  close("rates spanning 1/2 .. 1/3e6", CM.expectedTrials(groups).T,
    maxExponentialMean(qs), 1e-8);
}
{
  const qs = [1 / 128, 1 / 128, 1 / 512, 1 / 1024, 1 / 1024, 1 / 5000, 1 / 5000];
  const groups = qs.map(q => g(q, 1));
  close("seven mixed rates", CM.expectedTrials(groups).T,
    maxExponentialMean(qs), 1e-9);
}

// -- CDF ---------------------------------------------------------------------

console.log("\ncdf / survival");

// k=1 everywhere: F(x) = prod_i (1 - e^{-q_i x})
{
  const qs = [1 / 10, 1 / 40, 1 / 200];
  const groups = qs.map(q => g(q, 1));
  for (const x of [1, 10, 100, 500, 2000]) {
    const want = qs.reduce((acc, q) => acc * (1 - Math.exp(-q * x)), 1);
    close(`cdf at x=${x}`, CM.cdf(x, groups), want, 1e-11);
  }
}
// Survival must keep precision where 1 - F(x) is far below double resolution
// of F itself; the naive `1 - product` returns exactly 0 here.
{
  const groups = [g(1 / 10, 1)];
  const x = 800; // 1 - F = e^-80 ~ 1.8e-35
  close("survival far tail", CM.survival(x, groups), Math.exp(-80), 1e-10);
  ok("naive 1-F would have been 0", 1 - CM.cdf(x, groups) === 0);
}

// -- quantiles ---------------------------------------------------------------

console.log("\nquantiles");

// Single exponential item: F(x) = 1 - e^{-qx}, so x_p = -ln(1-p)/q.
{
  const q = 1 / 128;
  const groups = [g(q, 1)];
  for (const p of [0.01, 0.5, 0.9, 0.99]) {
    close(`quantile p=${p}`, CM.quantile(p, groups), -Math.log(1 - p) / q, 1e-9);
  }
}
// Same, checked through the full distribution() path used by the UI.
{
  const q = 1 / 360;
  const dist = CM.distribution([g(q, 1)]);
  for (const p of [1, 25, 50, 75, 99]) {
    const i = dist.percentiles.indexOf(p);
    close(`distribution P${p}`, dist.quantiles[i], -Math.log(1 - p / 100) / q, 1e-7);
  }
  ok("no null quantiles", dist.quantiles.every(v => isFinite(v)));
  ok("quantiles increase", dist.quantiles.every((v, i, a) => i === 0 || v > a[i - 1]));
}
// Median of the classic collector, cross-checked against the CDF itself.
{
  const groups = [g(1 / 50, 1, 50)];
  const med = CM.quantile(0.5, groups);
  close("cdf(median) == 0.5", CM.cdf(med, groups), 0.5, 1e-9);
  const p99 = CM.quantile(0.99, groups);
  close("cdf(P99) == 0.99", CM.cdf(p99, groups), 0.99, 1e-9);
}

// -- rate parsing ------------------------------------------------------------

console.log("\nparsing");

close("parseRate('3000')", CM.parseRate("3000"), 1 / 3000, 1e-15);
close("parseRate('1 in 3000')", CM.parseRate("1 in 3000"), 1 / 3000, 1e-15);
close("parseRate('1/3000')", CM.parseRate("1/3000"), 1 / 3000, 1e-15);
close("parseRate('0.0003')", CM.parseRate("0.0003"), 0.0003, 1e-15);
close("parseRate('0.03%')", CM.parseRate("0.03%"), 0.0003, 1e-15);
close("parseRate('1,000')", CM.parseRate("1,000"), 1 / 1000, 1e-15);
close("parseRate('1')", CM.parseRate("1"), 1, 1e-15);

throws("parseRate('')", () => CM.parseRate(""));
throws("parseRate(null)", () => CM.parseRate(null));
throws("parseRate('nan')", () => CM.parseRate("nan"));
throws("parseRate('inf')", () => CM.parseRate("inf"));
throws("parseRate('Infinity')", () => CM.parseRate("Infinity"));
throws("parseRate('-5')", () => CM.parseRate("-5"));
throws("parseRate('0')", () => CM.parseRate("0"));
throws("parseRate('abc')", () => CM.parseRate("abc"));
throws("parseRate('0x10')", () => CM.parseRate("0x10"));
throws("parseRate('1/2/3')", () => CM.parseRate("1/2/3"));

// -- row validation ----------------------------------------------------------

console.log("\nrow validation");

{
  const parsed = CM.parseRows([
    { rate: "1/360", k: "1", count: "15" },
    { rate: "1/360", k: "1", count: "5" },
    { rate: "1/1000", k: "2", count: "1" }
  ]);
  ok("identical rate+qty rows merge", parsed.groups.length === 2,
    `got ${parsed.groups.length} groups`);
  ok("merged multiplicity is 20", parsed.groups[0].n === 20, `got ${parsed.groups[0].n}`);
  ok("totalItems counts every item", parsed.totalItems === 21, `got ${parsed.totalItems}`);
}
{
  // Same rate, different quantity needed -> must stay separate.
  const parsed = CM.parseRows([
    { rate: "1/360", k: "1", count: "3" },
    { rate: "1/360", k: "2", count: "3" }
  ]);
  ok("same rate, different k stays split", parsed.groups.length === 2);
}

throws("empty row list", () => CM.parseRows([]));
throws("k = 0", () => CM.parseRows([{ rate: "1/100", k: "0" }]));
throws("k negative", () => CM.parseRows([{ rate: "1/100", k: "-2" }]));
throws("k fractional", () => CM.parseRows([{ rate: "1/100", k: "1.5" }]));
throws("count = 0", () => CM.parseRows([{ rate: "1/100", k: "1", count: "0" }]));
throws("too many rows", () =>
  CM.parseRows(Array.from({ length: 201 }, () => ({ rate: "1/100", k: "1" }))));

// -- solve() end to end ------------------------------------------------------

console.log("\nsolve()");

{
  const out = CM.solve([{ rate: "1/360", k: "1", count: "15" }]);
  close("solve expected value", out.expected, 360 * harmonic(15), 1e-9);
  ok("solve returns a distribution", out.distribution !== null);
  ok("solve reports no spurious warnings", out.warnings.length === 0,
    JSON.stringify(out.warnings));
  ok("solve counts items", out.totalItems === 15);
}
{
  const out = CM.solve([{ rate: "0.6", k: "1" }, { rate: "0.7", k: "1" }]);
  ok("rate sum > 1 warns", out.warnings.length === 1, JSON.stringify(out.warnings));
}
{
  // Big multiplicity: only affordable because identical items are grouped.
  const t0 = Date.now();
  const out = CM.solve([{ rate: "1/1000", k: "1", count: "100000" }]);
  const ms = Date.now() - t0;
  close("100k identical items", out.expected, 1000 * harmonic(100000), 1e-8);
  ok("100k identical items is fast (" + ms + " ms)", ms < 2000, ms + " ms");
}

// -- summary -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
