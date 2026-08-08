/**
 * Coupon-collector math engine — a dependency-free port of what app.py used to
 * do with SciPy (poisson.cdf / quad / digamma), so the whole calculator can run
 * in the browser with no backend.
 *
 * The model, unchanged from the Python: given items i with per-trial drop
 * probability q_i, needing k_i copies each, the number of trials N_i to see k_i
 * copies is negative-binomial, and
 *
 *     F(x) = P(done by trial x) = prod_i P(N_i < k_i has NOT happened)
 *          = prod_i P(k_i, q_i x)            <- regularized lower incomplete gamma
 *     E[T] = integral_0^inf (1 - F(x)) dx
 *
 * Two things are computed differently here than in the SciPy version, both
 * deliberately:
 *
 *   1. Everything runs through log F(x) instead of F(x). The Python built the
 *      product directly and then took `1 - product`, which cancels catastrophically
 *      in the right tail (every factor is ~1) and underflows to a flat 0 in the
 *      left tail. Summing log P(k_i, q_i x) and recovering the survival function
 *      as -expm1(sum) keeps full relative precision at both ends, which is what
 *      makes the extreme percentiles (P1, P99) trustworthy.
 *
 *   2. Identical (rate, quantity) pairs are collapsed into one group carrying a
 *      multiplicity. In log space a group of n identical items is just
 *      n * log P(k, qx), so a 500-item table costs the same as a 1-item one.
 *      The Python expanded `count` into 500 separate factors and paid for each.
 *
 * Exposed as a global (`CouponMath`) rather than an ES module on purpose: it
 * keeps index.html working when opened straight off the filesystem, which ES
 * modules block. The CommonJS tail is there so tests/engine.test.js can require it.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CouponMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var EPS = 2.220446049250313e-16;
  var FPMIN = 1e-300;
  var EULER_GAMMA = 0.5772156649015329;
  // Above this shape parameter the series/continued-fraction iterations stop
  // being affordable (they need O(a) terms near x ~ a), so switch to the
  // fixed-order quadrature form. Same threshold Numerical Recipes 3e uses.
  var ASWITCH = 100;

  // ---------------------------------------------------------------- limits --
  // These used to be abuse guards on a public endpoint. With no server left,
  // they only exist to keep the UI thread responsive, so the one that actually
  // costs anything is MAX_ROWS (= distinct groups to evaluate). MAX_COUNT_PER_ROW
  // is nearly free now that identical items are grouped, hence the much higher
  // ceiling than the Python's 5,000 / 2,000-total pair.
  var LIMITS = {
    MAX_ROWS: 200,
    MAX_COUNT_PER_ROW: 1000000,
    MAX_K: 1000000000
  };

  // ------------------------------------------------------ special functions --

  var LANCZOS = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028,
    771.3234287776531, -176.6150291621406, 12.507343278686905,
    -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7
  ];

  function logGamma(z) {
    if (z < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    z -= 1;
    var x = LANCZOS[0];
    for (var i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
    var t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  /**
   * log P(a, x) via the ascending series, valid for x < a + 1.
   *
   * Returns the logarithm rather than the value: the series result is
   * `sum * exp(-x + a log x - lgamma(a))`, and for small x that exponential
   * underflows to 0 long before the answer stops being meaningful. Keeping it
   * symbolic means the deep left tail (P ~ 1e-300 and below) survives intact,
   * which is exactly the region the low percentiles live in.
   */
  function logGserP(a, x) {
    var gln = logGamma(a);
    var ap = a;
    var sum = 1 / a;
    var del = sum;
    for (var n = 0; n < 100000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return Math.log(sum) - x + a * Math.log(x) - gln;
  }

  /** Q(a, x) via the continued fraction (Lentz), valid for x >= a + 1. */
  function gcfQ(a, x) {
    var gln = logGamma(a);
    var b = x + 1 - a;
    var c = 1 / FPMIN;
    var d = 1 / b;
    var h = d;
    for (var i = 1; i <= 100000; i++) {
      var an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      var del = d * c;
      h *= del;
      if (Math.abs(del - 1) <= EPS) break;
    }
    return Math.exp(-x + a * Math.log(x) - gln) * h;
  }

  // 18-point Gauss-Legendre nodes/weights on the half-interval, for the
  // large-a quadrature form of the incomplete gamma (NR 3e, gammpapprox).
  var GL_Y = [
    0.0021695375159141994, 0.011413521097787704, 0.027972308950302116,
    0.05172701560049222, 0.08250222548434094, 0.12007019910960293,
    0.1641528330075247, 0.21442376986779355, 0.2705108284064434,
    0.33199876341447887, 0.39843234186401943, 0.4693197140737563,
    0.5441360555665873, 0.6223274528803156, 0.7033150046559718,
    0.7864991076831377, 0.8712638961606142, 0.9569818015296144
  ];
  var GL_W = [
    0.005565719664245045, 0.012915947284065419, 0.02018151529773547,
    0.027298621498568734, 0.034213810770299774, 0.04087575092364489,
    0.04723508349026597, 0.05324471397775992, 0.058860144245324816,
    0.06403979735501548, 0.06874532383573644, 0.07294188500565307,
    0.07659841064587067, 0.07968782891207159, 0.08218726670433971,
    0.08407821897966197, 0.08534668573933863, 0.08598327567039476
  ];

  /**
   * P(a,x) (wantP) or Q(a,x) for large a, by direct quadrature of the density.
   *
   * Which tail got integrated is decided by `x > a1` and tracked explicitly.
   * Numerical Recipes instead infers it from the sign of the result, relying on
   * the integration direction to make `ans` negative on the lower branch — but
   * that misreads the case where the upper tail underflows to exactly +0 (any
   * x far above a, e.g. a=200 at x=1e6). The sign test then falls through to
   * the lower branch and reports P=0 for an x where P is 1. Downstream that
   * turns the survival function into a constant 1, and the expected-value
   * integral diverges instead of converging.
   */
  function gammpapprox(a, x, wantP) {
    var a1 = a - 1;
    var lna1 = Math.log(a1);
    var sqrta1 = Math.sqrt(a1);
    var gln = logGamma(a);
    var upperTail = x > a1;
    var xu;
    if (upperTail) xu = Math.max(a1 + 11.5 * sqrta1, x + 6 * sqrta1);
    else xu = Math.max(0, Math.min(a1 - 7.5 * sqrta1, x - 5 * sqrta1));
    var sum = 0;
    for (var j = 0; j < 18; j++) {
      var t = x + (xu - x) * GL_Y[j];
      sum += GL_W[j] * Math.exp(-(t - a1) + a1 * (Math.log(t) - lna1));
    }
    var ans = Math.abs(sum * (xu - x) * Math.exp(a1 * (lna1 - 1) - gln));
    var p = upperTail ? 1 - ans : ans;
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    return wantP ? p : 1 - p;
  }

  /**
   * log of the regularized lower incomplete gamma P(a, x).
   *
   * Branches so that whichever of P/Q is the small one is the one computed
   * directly — taking `log(1 - Q)` when Q is near 1 would throw away every
   * significant digit.
   */
  function logGammaP(a, x) {
    if (!(x > 0)) return -Infinity;
    if (a >= ASWITCH) {
      var p = gammpapprox(a, x, true);
      return p > 0 ? Math.log(p) : -Infinity;
    }
    if (x < a + 1) return logGserP(a, x);
    var q = gcfQ(a, x);
    if (q >= 1) return -Infinity;
    return Math.log1p(-q);
  }

  /** Regularized lower incomplete gamma P(a, x), for callers wanting the value. */
  function gammainc(a, x) {
    var lp = logGammaP(a, x);
    return lp === -Infinity ? 0 : Math.exp(lp);
  }

  function digamma(x) {
    var result = 0;
    // Recur upward until the asymptotic series below is good to full double
    // precision. Its first dropped term is 691/(32760 x^12), which is still
    // ~1e-11 at x=6 — enough to show up in H(n) — but ~1e-16 by x=14.
    while (x < 14) {
      result -= 1 / x;
      x += 1;
    }
    var inv = 1 / x;
    var inv2 = inv * inv;
    result += Math.log(x) - 0.5 * inv;
    result -= inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 -
      inv2 * (1 / 240 - inv2 * (1 / 132)))));
    return result;
  }

  /** H(n) = psi(n+1) + gamma. */
  function harmonicNumber(n) {
    return digamma(n + 1) + EULER_GAMMA;
  }

  // ------------------------------------------------------- the distribution --

  /**
   * log F(x): log-probability that every item has reached its required count by
   * trial x. Groups are {q, k, n} with n the number of identical items.
   */
  function logCdf(x, groups) {
    if (!(x > 0)) return -Infinity;
    var s = 0;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var lp = logGammaP(g.k, g.q * x);
      if (lp === -Infinity) return -Infinity;
      s += g.n * lp;
      if (s === -Infinity) return -Infinity;
    }
    return s;
  }

  function cdf(x, groups) {
    var s = logCdf(x, groups);
    return s === -Infinity ? 0 : Math.exp(s);
  }

  /** 1 - F(x), evaluated so the right tail keeps its significant digits. */
  function survival(x, groups) {
    var s = logCdf(x, groups);
    if (s === -Infinity) return 1;
    return -Math.expm1(s);
  }

  // ------------------------------------------------------------ quadrature --

  // Gauss-Kronrod 15-point pair (QUADPACK dqk15), 0-based: xgk[7] is the centre,
  // and the 7-point Gauss weights wg apply at the odd indices 1, 3, 5, 7.
  var XGK = [
    0.9914553711208126, 0.9491079123427585, 0.8648644233597691,
    0.7415311855993945, 0.5860872354676911, 0.4058451513773972,
    0.20778495500789848, 0.0
  ];
  var WGK = [
    0.022935322010529224, 0.06309209262997855, 0.10479001032225019,
    0.14065325971552592, 0.16900472663926791, 0.19035057806478542,
    0.20443294007529889, 0.20948214108472782
  ];
  var WG = [
    0.12948496616886969, 0.27970539148927664,
    0.3818300505051189, 0.4179591836734694
  ];

  /** One 15-point Kronrod / 7-point Gauss panel, with QUADPACK's error estimate. */
  function gk15(f, a, b) {
    var centr = 0.5 * (a + b);
    var hlgth = 0.5 * (b - a);
    var absHlgth = Math.abs(hlgth);

    var fc = f(centr);
    var resg = fc * WG[3];
    var resk = fc * WGK[7];
    var resabs = Math.abs(resk);
    var fv1 = new Array(7);
    var fv2 = new Array(7);

    var j, jj, absc, f1, f2, fsum;
    // Even Kronrod indices that coincide with Gauss nodes.
    for (j = 0; j < 3; j++) {
      jj = 2 * j + 1;
      absc = hlgth * XGK[jj];
      f1 = f(centr - absc);
      f2 = f(centr + absc);
      fv1[jj] = f1;
      fv2[jj] = f2;
      fsum = f1 + f2;
      resg += WG[j] * fsum;
      resk += WGK[jj] * fsum;
      resabs += WGK[jj] * (Math.abs(f1) + Math.abs(f2));
    }
    // Kronrod-only nodes.
    for (j = 0; j < 4; j++) {
      jj = 2 * j;
      absc = hlgth * XGK[jj];
      f1 = f(centr - absc);
      f2 = f(centr + absc);
      fv1[jj] = f1;
      fv2[jj] = f2;
      fsum = f1 + f2;
      resk += WGK[jj] * fsum;
      resabs += WGK[jj] * (Math.abs(f1) + Math.abs(f2));
    }

    var reskh = resk * 0.5;
    var resasc = WGK[7] * Math.abs(fc - reskh);
    for (j = 0; j < 7; j++) {
      resasc += WGK[j] * (Math.abs(fv1[j] - reskh) + Math.abs(fv2[j] - reskh));
    }

    var result = resk * hlgth;
    resabs *= absHlgth;
    resasc *= absHlgth;
    var abserr = Math.abs((resk - resg) * hlgth);
    if (resasc !== 0 && abserr !== 0) {
      abserr = resasc * Math.min(1, Math.pow(200 * abserr / resasc, 1.5));
    }
    if (resabs > FPMIN / (50 * EPS)) {
      abserr = Math.max(EPS * 50 * resabs, abserr);
    }
    return { a: a, b: b, result: result, abserr: abserr };
  }

  /**
   * Globally adaptive Gauss-Kronrod integration: repeatedly bisect whichever
   * panel carries the largest error estimate. This is the same strategy SciPy's
   * quad (QUADPACK QAG) uses, so `flagged` means roughly what the old
   * IntegrationWarning meant — the requested tolerance was not reached.
   */
  function adaptiveQuad(f, a, b, epsrel, limit) {
    var segs = [gk15(f, a, b)];
    var flagged = false;
    var total, totalErr, worst, i;

    for (var iter = 0; iter < limit; iter++) {
      total = 0;
      totalErr = 0;
      worst = 0;
      for (i = 0; i < segs.length; i++) {
        total += segs[i].result;
        totalErr += segs[i].abserr;
        if (segs[i].abserr > segs[worst].abserr) worst = i;
      }
      if (totalErr <= epsrel * Math.abs(total)) {
        return { result: total, abserr: totalErr, flagged: false };
      }
      if (segs.length >= limit) {
        flagged = true;
        break;
      }
      var s = segs[worst];
      var mid = s.a + 0.5 * (s.b - s.a);
      // Bisection has hit the floating-point floor; further splitting is a
      // no-op loop, so stop and report the result as unconverged.
      if (!(mid > s.a) || !(mid < s.b)) {
        flagged = true;
        break;
      }
      segs[worst] = gk15(f, s.a, mid);
      segs.push(gk15(f, mid, s.b));
    }

    total = 0;
    totalErr = 0;
    for (i = 0; i < segs.length; i++) {
      total += segs[i].result;
      totalErr += segs[i].abserr;
    }
    if (totalErr > epsrel * Math.abs(total)) flagged = true;
    return { result: total, abserr: totalErr, flagged: flagged };
  }

  // ----------------------------------------------------------- the solvers --

  /**
   * E[T] = integral_0^inf (1 - F(x)) dx.
   *
   * Rescaled before integrating, same idea as the Python, so the integrand's
   * transition sits near x ~ 1 whether the rates are 1-in-5 or 1-in-5-million.
   * The infinite range is then mapped to [0, 1] by x = t/(1-t); the survival
   * function decays exponentially, which beats the 1/(1-t)^2 Jacobian, so the
   * transformed integrand goes to zero at the right endpoint instead of
   * blowing up.
   *
   * The scale itself is chosen differently from the Python's max_i H(k_i)/q_i,
   * which mixes up the two things that make a collection slow. The number of
   * copies needed scales the mean linearly (E[N_i] = k_i/q_i), while the number
   * of distinct items scales it harmonically (H(N) for N equal-rate items).
   * H(k_i)/q_i applies the harmonic factor to the copies instead, so one item
   * needing 200 copies got a scale of 75*H(200) = 441 for a true mean of 15,000
   * — a 34x under-scale that pushed all the integrand's mass into the last 3%
   * of the transformed interval. Taking max_i(k_i/q_i) * H(N) instead is exact
   * whenever the table is homogeneous (one item, or N items sharing a rate) and
   * within a small factor otherwise, which is all the conditioning needs.
   */
  function expectedTrials(groups) {
    var maxMean = 0;
    var totalItems = 0;
    var i;
    for (i = 0; i < groups.length; i++) {
      maxMean = Math.max(maxMean, groups[i].k / groups[i].q);
      totalItems += groups[i].n;
    }
    var M = maxMean * harmonicNumber(totalItems);
    if (!isFinite(M) || M <= 0) return { T: NaN, err: NaN, flagged: true };

    var scaled = new Array(groups.length);
    for (i = 0; i < groups.length; i++) {
      scaled[i] = { q: groups[i].q * M, k: groups[i].k, n: groups[i].n };
    }

    var f = function (t) {
      var om = 1 - t;
      if (om <= 0) return 0;
      var s = survival(t / om, scaled);
      if (s <= 0) return 0;
      return s / (om * om);
    };

    var out = adaptiveQuad(f, 0, 1, 1e-10, 200);
    return { T: out.result * M, err: out.abserr * M, flagged: out.flagged };
  }

  /** Smallest x with F(x) >= 1 - tail; used to size the plotted range. */
  function findUpperBound(groups, tail) {
    var logTarget = Math.log1p(-(tail === undefined ? 1e-9 : tail));
    var x = 1;
    for (var i = 0; i < groups.length; i++) {
      x = Math.max(x, groups[i].k / groups[i].q);
    }
    x *= 4;
    for (var n = 0; n < 200; n++) {
      if (logCdf(x, groups) >= logTarget) return x;
      x *= 2;
    }
    return x;
  }

  /**
   * Trials needed to be finished with probability p, by bisection on the exact
   * CDF. The Python read this off a 600-point grid, which capped precision at
   * the grid spacing and returned null whenever the target fell past the last
   * sample; bisecting in log space instead means P1 and P99 are as exact as
   * P50, and nothing is out of range.
   */
  function quantile(p, groups, bracket) {
    if (!(p > 0)) return 0;
    if (p >= 1) return Infinity;
    var target = Math.log(p);

    var lo = 0;
    var hi;
    if (bracket && isFinite(bracket.hi) && bracket.hi > 0) {
      lo = bracket.lo > 0 ? bracket.lo : 0;
      hi = bracket.hi;
    } else {
      hi = 1;
      for (var i = 0; i < groups.length; i++) {
        hi = Math.max(hi, groups[i].k / groups[i].q);
      }
    }
    var guard = 0;
    while (logCdf(hi, groups) < target) {
      lo = hi;
      hi *= 2;
      if (++guard > 400) return NaN;
    }
    for (var it = 0; it < 200; it++) {
      if (hi - lo <= 1e-12 * hi) break;
      var mid = lo + 0.5 * (hi - lo);
      if (!(mid > lo) || !(mid < hi)) break;
      if (logCdf(mid, groups) < target) lo = mid;
      else hi = mid;
    }
    return lo + 0.5 * (hi - lo);
  }

  /**
   * Everything the Distribution tab needs: a log-spaced CDF curve for plotting,
   * and the 1..99 percentiles. Grid points double as brackets for the quantile
   * bisections, so each percentile only costs a handful of extra CDF evaluations.
   */
  function distribution(groups, nPoints) {
    var n = nPoints || 600;
    var xMax = findUpperBound(groups, 1e-9);
    if (!isFinite(xMax) || xMax <= 0) return null;

    var lo = Math.max(xMax / 1e9, 1e-9);
    var logLo = Math.log(lo);
    var logHi = Math.log(xMax);
    var step = (logHi - logLo) / (n - 1);

    var xs = new Array(n + 1);
    var fs = new Array(n + 1);
    xs[0] = 0;
    fs[0] = 0;
    var i;
    for (i = 0; i < n; i++) {
      var x = Math.exp(logLo + step * i);
      xs[i + 1] = x;
      fs[i + 1] = cdf(x, groups);
    }
    // The CDF is monotone by construction; only rounding can dent it.
    for (i = 1; i < fs.length; i++) {
      if (fs[i] < fs[i - 1]) fs[i] = fs[i - 1];
    }

    var percentiles = [];
    var quantiles = [];
    for (var p = 1; p <= 99; p++) {
      percentiles.push(p);
      var target = p / 100;
      // Locate the grid cell containing the target, then refine inside it.
      var idx = 0;
      while (idx < fs.length && fs[idx] < target) idx++;
      var br = null;
      if (idx > 0 && idx < xs.length) br = { lo: xs[idx - 1], hi: xs[idx] };
      quantiles.push(quantile(target, groups, br));
    }

    return {
      xs: xs,
      fs: fs,
      xMax: xMax,
      percentiles: percentiles,
      quantiles: quantiles
    };
  }

  // -------------------------------------------------------------- parsing --

  /**
   * Parse a drop-rate string into a probability in (0, 1]. Accepts
   * "3000", "1 in 3000", "1/3000", "0.0003" and "0.03%"; anything >= 1 is read
   * as a denominator. Unchanged in behaviour from the Python parse_rate,
   * including rejecting NaN/Infinity, which slip past naive range checks
   * because every comparison against NaN is false.
   */
  function parseRate(s) {
    if (s === null || s === undefined) throw new Error("empty rate");
    var text = String(s).trim().toLowerCase().replace(/,/g, "");
    if (!text) throw new Error("empty rate");

    var result;
    if (text.charAt(text.length - 1) === "%") {
      result = strictFloat(text.slice(0, -1).trim()) / 100;
    } else {
      var m = /^\s*([0-9.eE+-]+)\s+in\s+([0-9.eE+-]+)\s*$/.exec(text);
      if (m) {
        result = strictFloat(m[1]) / strictFloat(m[2]);
      } else if (text.indexOf("/") !== -1) {
        var parts = text.split("/");
        if (parts.length !== 2) throw new Error("bad fraction");
        result = strictFloat(parts[0].trim()) / strictFloat(parts[1].trim());
      } else {
        var v = strictFloat(text);
        result = v < 1 ? v : 1 / v;
      }
    }

    if (!isFinite(result) || result <= 0 || result > 1) {
      throw new Error("rate must resolve to a finite value in (0, 1]");
    }
    return result;
  }

  /**
   * Number() is far too permissive for this: "" is 0, "0x10" is 16, and
   * "Infinity" parses cleanly. Require a plain decimal literal.
   */
  function strictFloat(text) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
      throw new Error('"' + text + '" is not a number');
    }
    var v = Number(text);
    if (!isFinite(v)) throw new Error('"' + text + '" is not finite');
    return v;
  }

  function strictInt(value, fallback) {
    if (value === null || value === undefined || value === "") {
      if (fallback !== undefined) return fallback;
      throw new Error("missing value");
    }
    var text = String(value).trim().replace(/,/g, "");
    if (!text) {
      if (fallback !== undefined) return fallback;
      throw new Error("missing value");
    }
    if (!/^[+-]?\d+$/.test(text)) throw new Error('"' + text + '" is not a whole number');
    var v = Number(text);
    if (!isFinite(v)) throw new Error('"' + text + '" is not finite');
    return v;
  }

  /**
   * Validate rows and collapse identical (rate, quantity) pairs into groups.
   * Returns [{q, k, n}] plus the total item count for display.
   */
  function parseRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("No items provided.");
    }
    if (rows.length > LIMITS.MAX_ROWS) {
      throw new Error("Too many rows (" + rows.length + "); the limit is " + LIMITS.MAX_ROWS + ".");
    }

    var byKey = Object.create(null);
    var groups = [];
    var totalItems = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var q, k, count;
      try {
        q = parseRate(row.rate !== undefined ? row.rate : row.denominator);
        k = strictInt(row.k);
        count = strictInt(row.count, 1);
      } catch (e) {
        throw new Error("Row " + (i + 1) + ": invalid values (" + e.message + ").");
      }
      if (k <= 0) throw new Error("Row " + (i + 1) + ": quantity needed must be >= 1.");
      if (k > LIMITS.MAX_K) {
        throw new Error("Row " + (i + 1) + ": quantity needed is unreasonably large (max " +
          LIMITS.MAX_K.toLocaleString("en-US") + ").");
      }
      if (count <= 0) throw new Error("Row " + (i + 1) + ": count must be >= 1.");
      if (count > LIMITS.MAX_COUNT_PER_ROW) {
        throw new Error("Row " + (i + 1) + ": count (" + count + ") exceeds the limit of " +
          LIMITS.MAX_COUNT_PER_ROW.toLocaleString("en-US") + ".");
      }

      totalItems += count;
      // Key on the exact double bit pattern of q so only genuinely identical
      // rates merge — near-equal rates stay separate groups.
      var key = q + "|" + k;
      if (byKey[key] === undefined) {
        byKey[key] = groups.length;
        groups.push({ q: q, k: k, n: count });
      } else {
        groups[byKey[key]].n += count;
      }
    }

    return { groups: groups, totalItems: totalItems };
  }

  /**
   * Full calculation for a set of input rows: expected value, distribution and
   * any warnings. Mirrors what /calculate and /distribution returned together.
   */
  function solve(rows, options) {
    var opts = options || {};
    var parsed = parseRows(rows);
    var groups = parsed.groups;

    var warnings = [];
    var rateSum = 0;
    for (var i = 0; i < groups.length; i++) rateSum += groups[i].q * groups[i].n;
    if (rateSum > 1 + 1e-12) {
      warnings.push("Sum of drop rates (" + rateSum.toFixed(4) +
        ") exceeds 1 — results may be unexpected.");
    }

    var ev = expectedTrials(groups);
    if (!isFinite(ev.T)) {
      throw new Error("These inputs produced a non-finite result — check for extreme rates or quantities.");
    }
    if (ev.flagged) {
      warnings.push("Numerical integration did not reach full tolerance (rates/quantities " +
        "may span too wide a range) — treat the expected value as approximate.");
    }

    var dist = distribution(groups, opts.gridPoints);

    return {
      groups: groups,
      totalItems: parsed.totalItems,
      expected: ev.T,
      error: ev.err,
      distribution: dist,
      warnings: warnings
    };
  }

  return {
    LIMITS: LIMITS,
    logGamma: logGamma,
    gammainc: gammainc,
    logGammaP: logGammaP,
    digamma: digamma,
    harmonicNumber: harmonicNumber,
    logCdf: logCdf,
    cdf: cdf,
    survival: survival,
    adaptiveQuad: adaptiveQuad,
    expectedTrials: expectedTrials,
    findUpperBound: findUpperBound,
    quantile: quantile,
    distribution: distribution,
    parseRate: parseRate,
    parseRows: parseRows,
    solve: solve
  };
});
