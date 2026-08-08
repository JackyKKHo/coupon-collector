# Coupon Collector Calculator

Work out how long a grind takes when you need *k* copies of every item on a drop
table. Give it the drop rates and quantities, and it returns the expected number
of trials plus the full distribution — the trials needed for any confidence
level, or your odds of being finished at a kill count you've already reached.

It's a static page. Open `index.html` and it works — no server, no install, no
network. Nothing you type leaves the browser.

## The model

Each item *i* has a per-trial drop probability *qᵢ* and you need *kᵢ* copies.
Treating drops as independent Poisson processes, the time to collect *kᵢ* copies
of item *i* is Gamma-distributed, so

```
F(x) = P(everything collected by trial x) = ∏ᵢ P(kᵢ, qᵢx)
E[T] = ∫₀^∞ (1 − F(x)) dx
```

where `P(a, x)` is the regularized lower incomplete gamma function.

Two useful sanity checks fall out of this and are covered in the tests: one item
needing *k* copies gives exactly *k/q*, and *n* equally-likely items needing one
copy each gives the classic *n·H(n)*.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The page |
| `assets/coupon.js` | The math — special functions, integration, quantiles, parsing |
| `assets/app.js` | UI wiring |
| `assets/styles.css` | Styles |
| `tests/engine.test.js` | Test suite for the math |

`assets/coupon.js` has no dependencies and no DOM references. It works in the
browser as a global (`CouponMath`) and in Node via `require`, which is how the
tests drive it.

## Tests

```
node tests/engine.test.js
```

76 assertions, all checked against closed-form answers rather than against
recorded output, so they catch a wrong implementation rather than just a changed
one. Covers the special functions, expected values (exact for single items, for
equal-rate tables, and via inclusion–exclusion for mixed rates), CDF and tail
precision, quantiles, rate parsing, and input validation.

## Numerical notes

Worth knowing if you touch `assets/coupon.js`:

- **Everything is computed in log space.** The survival function comes from
  `−expm1(Σ log P(kᵢ, qᵢx))` rather than `1 − ∏ᵢ P(kᵢ, qᵢx)`. The direct product
  cancels catastrophically in the right tail, where every factor is ≈1 — it
  returns a flat zero well before the true value stops mattering — and underflows
  in the left tail. The log form holds full relative precision at both ends,
  which is what makes P1 and P99 trustworthy.
- **Identical items are grouped.** A row's `count` becomes a multiplicity, and
  *n* identical items contribute `n · log P(k, qx)`. A 100,000-item table costs
  the same as a 1-item one; cost scales with *distinct* (rate, quantity) pairs,
  which is why the row limit is 200 but the per-row count limit is a million.
- **The integral is rescaled before evaluation.** Dividing out
  `maxᵢ(kᵢ/qᵢ) · H(N)` puts the integrand's transition near *x* ≈ 1 whatever the
  rates are, so the adaptive Gauss–Kronrod pass on the mapped interval stays well
  conditioned across rates from 1-in-2 to 1-in-several-million.
- **Quantiles are found by bisecting the exact CDF**, not by interpolating the
  plotted grid, so every percentile is exact to ~1e-13 and none are ever "out of
  range".

## History

This started as a Flask app that did the same maths with SciPy (`poisson.cdf`,
`quad`, `digamma`) behind two JSON endpoints. It's now a static page, which drops
the deployment, the cold starts and the rate limits that a public endpoint needed.

The port was cross-validated against the original: expected values agree to
~1e-15 relative across a range of tables. Two things did change deliberately, both
improvements — the log-space evaluation above, and quantiles by bisection instead
of grid interpolation, which the original computed to about 1e-4 and this computes
to about 1e-13.
