#!/usr/bin/env python3
import math
import re
import warnings
from flask import Flask, render_template, request, jsonify
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import numpy as np
from scipy.integrate import IntegrationWarning, quad
from scipy.special import digamma
from scipy.stats import poisson

app = Flask(__name__)

# Render (like most PaaS) puts a proxy in front of the app, so the raw TCP
# peer address is always the proxy's, not the visitor's. Without this,
# flask-limiter's per-IP rate limit would see one shared "client" for
# everyone. x_for=1 trusts exactly one hop of X-Forwarded-For, matching a
# single reverse proxy in front — don't raise it unless another proxy is added.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)

limiter = Limiter(app=app, key_func=get_remote_address, default_limits=[])


@app.errorhandler(500)
def handle_internal_error(e):
    # Belt-and-suspenders: any exception this app's own guards fail to
    # anticipate should still come back as JSON, not Flask's default HTML
    # error page — callers here are always fetch()/curl, never a browser nav.
    return jsonify({"error": "Internal server error."}), 500


@app.errorhandler(413)
def handle_payload_too_large(e):
    return jsonify({"error": "Request body too large."}), 413


@app.errorhandler(429)
def handle_rate_limited(e):
    return jsonify({"error": "Too many requests — please slow down and try again shortly."}), 429


# Reject oversized request bodies at the WSGI layer, before any JSON parsing
# happens — otherwise MAX_ROWS/MAX_TOTAL_ITEMS below can't help, since the
# whole body must be parsed into memory first to even count the rows.
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024  # 256 KB is generous for this form

# Guard rails — bound both per-row and total request cost so a single
# request can't peg CPU for everyone else on the instance (this endpoint
# is public and unauthenticated).
MAX_ROWS = 200               # distinct pairs submitted in one request
MAX_COUNT_PER_ROW = 5_000    # "identical items" multiplier on one row
MAX_TOTAL_ITEMS = 2_000      # rows expanded by count, summed
MAX_K = 10 ** 9              # quantity needed per item
RELATIVE_ERROR_WARN = 0.01   # flag results where quad's own error estimate
                              # exceeds 1% of the result — the number is
                              # still returned, just flagged as uncertain


def extract_pairs(data):
    """Validate the top-level request shape before anything indexes into it.

    A bare AttributeError/TypeError from malformed JSON (null body, pairs as
    a string, null/number entries inside pairs, etc.) would otherwise escape
    the ValueError-only except clauses below and crash the request with an
    unhandled 500 — trivially triggerable by anyone, no auth required.
    """
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object with a 'pairs' array.")
    pairs = data.get("pairs", [])
    if not isinstance(pairs, list):
        raise ValueError("'pairs' must be a list.")
    return pairs


def parse_rate(s):
    """Parse a drop-rate string into a probability in (0, 1].

    Accepted forms:
      "3000"        -> 1/3000          (integer >= 1 treated as "1 in X")
      "1 in 3000"   -> 1/3000
      "1/3000"      -> 1/3000
      "0.0003"      -> 0.0003          (decimal < 1 treated as probability)
      "0.03%"       -> 0.0003
    Anything > 1 is treated as a denominator ("1 in X").
    """
    if s is None:
        raise ValueError("empty rate")
    text = str(s).strip().lower().replace(",", "")
    if not text:
        raise ValueError("empty rate")

    if text.endswith("%"):
        v = float(text[:-1].strip())
        result = v / 100.0
    else:
        m = re.match(r"^\s*([0-9.eE+-]+)\s+in\s+([0-9.eE+-]+)\s*$", text)
        if m:
            result = float(m.group(1)) / float(m.group(2))
        elif "/" in text:
            parts = text.split("/")
            if len(parts) != 2:
                raise ValueError("bad fraction")
            result = float(parts[0].strip()) / float(parts[1].strip())
        else:
            v = float(text)
            result = v if v < 1 else 1.0 / v

    # float() happily parses "nan"/"inf"/"-inf" without raising, and those
    # would otherwise slide past every <=0 / >1 comparison below (NaN fails
    # every comparison) straight into the solver as silent garbage.
    if not math.isfinite(result) or result <= 0 or result > 1:
        raise ValueError("rate must resolve to a finite value in (0, 1]")
    return result


def harmonic_number(n):
    """H(n) via the digamma function: H(n) = psi(n+1) + gamma."""
    return digamma(n + 1) + np.euler_gamma


def inner_sum(x, q, k):
    """P(N < k) where N ~ Poisson(q * x)."""
    if x <= 0:
        return 1.0
    return float(poisson.cdf(k - 1, q * x))


def cdf(x, qs, ks):
    """F(x) = P(all items collected by trial x) = prod_i (1 - P(N_i < k_i))."""
    prod = 1.0
    for q, k in zip(qs, ks):
        prod *= (1.0 - inner_sum(x, q, k))
    return prod


def integrand(x, qs, ks):
    return 1.0 - cdf(x, qs, ks)


def _integrate(qs, ks):
    return quad(integrand, 0, np.inf, args=(qs, ks), limit=200)


def compute_T(qs, ks):
    """Expected number of trials to collect k_i of every item i.

    Rescales before integrating: M = max(denominator_i * H(k_i)), solve at
    scaled_qs = qs * M (compresses the effective integration range to O(1)),
    then unscale the result by M. Without this, quad's fixed-effort adaptive
    integration loses accuracy when rates span many orders of magnitude (e.g.
    a clue-casket unique table with dozens of same-odds items) — this keeps
    the numerical error tight regardless of scale. Validated against known
    OSRS clue-casket expected values.
    """
    denominators = 1.0 / qs
    M = np.max(denominators * harmonic_number(ks))
    scaled_qs = qs * M
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", IntegrationWarning)
        scaled_result, err = _integrate(scaled_qs, ks)
    flagged = any(issubclass(w.category, IntegrationWarning) for w in caught)
    return scaled_result * M, err * M, flagged


def parse_pairs(pairs):
    if not pairs:
        raise ValueError("No items provided.")
    if len(pairs) > MAX_ROWS:
        raise ValueError(f"Too many rows ({len(pairs)}); the limit is {MAX_ROWS}.")

    qs, ks = [], []
    total_items = 0
    for i, pair in enumerate(pairs):
        if not isinstance(pair, dict):
            raise ValueError(f"Row {i + 1}: each item must be an object with rate/k fields.")
        try:
            q = parse_rate(pair.get("rate", pair.get("denominator")))
            k = int(pair["k"])
            count = int(pair.get("count", 1) or 1)
        except (KeyError, ValueError, TypeError) as e:
            raise ValueError(f"Row {i + 1}: invalid values ({e}).")
        if k <= 0:
            raise ValueError(f"Row {i + 1}: quantity needed must be >= 1.")
        if k > MAX_K:
            raise ValueError(f"Row {i + 1}: quantity needed is unreasonably large (max {MAX_K:,}).")
        if count <= 0:
            raise ValueError(f"Row {i + 1}: count must be >= 1.")
        if count > MAX_COUNT_PER_ROW:
            raise ValueError(f"Row {i + 1}: count ({count}) exceeds the limit of {MAX_COUNT_PER_ROW:,}.")

        total_items += count
        if total_items > MAX_TOTAL_ITEMS:
            raise ValueError(
                f"Too many total items once rows are expanded by their count "
                f"(limit {MAX_TOTAL_ITEMS:,}). Reduce row count or the 'count' values."
            )

        qs.extend([q] * count)
        ks.extend([k] * count)
    return np.array(qs, dtype=float), np.array(ks, dtype=int)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/calculate", methods=["POST"])
@limiter.limit("50 per minute")
def calculate():
    data = request.get_json(silent=True)
    try:
        qs, ks = parse_pairs(extract_pairs(data))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    warnings_out = []
    if qs.sum() > 1.0 + 1e-12:
        warnings_out.append(f"Sum of drop rates ({qs.sum():.4f}) exceeds 1 — results may be unexpected.")

    try:
        T, err, flagged = compute_T(qs, ks)
    except Exception:
        return jsonify({"error": "Could not compute a reliable result for these inputs."}), 400

    if not math.isfinite(T):
        return jsonify({"error": "These inputs produced a non-finite result — check for extreme rates or quantities."}), 400

    if flagged or (T != 0 and abs(err) > RELATIVE_ERROR_WARN * abs(T)):
        warnings_out.append(
            "Numerical integration flagged this result as low-confidence "
            "(rates/quantities may span too wide a range) — treat it as approximate."
        )

    warning = " ".join(warnings_out) if warnings_out else None
    return jsonify({"result": T, "error": err, "warning": warning})


def find_upper_bound(qs, ks, tail=1e-5):
    x = max((k / q for q, k in zip(qs, ks)), default=1.0) * 4.0
    if x <= 0:
        x = 1.0
    for _ in range(80):
        if cdf(x, qs, ks) >= 1.0 - tail:
            return x
        x *= 2.0
    return x


@app.route("/distribution", methods=["POST"])
@limiter.limit("50 per minute")
def distribution():
    data = request.get_json(silent=True)
    try:
        qs, ks = parse_pairs(extract_pairs(data))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        x_max = find_upper_bound(qs, ks)
    except Exception:
        return jsonify({"error": "Could not compute a distribution for these inputs."}), 400

    if not math.isfinite(x_max) or x_max <= 0:
        return jsonify({"error": "Could not compute a distribution for these inputs."}), 400
    # Log-spaced grid plus 0 anchor
    n_points = 600
    lo = max(x_max / 1e7, 1e-3)
    xs = np.logspace(np.log10(lo), np.log10(x_max), n_points)
    xs = np.concatenate(([0.0], xs))
    fs = np.array([cdf(float(x), qs, ks) for x in xs])
    # Enforce monotonicity (numerical noise can dent it)
    fs = np.maximum.accumulate(fs)

    percents = list(range(1, 100))
    quantiles = []
    for p in percents:
        target = p / 100.0
        if fs[-1] < target:
            quantiles.append(None)
            continue
        idx = int(np.searchsorted(fs, target))
        if idx == 0:
            quantiles.append(float(xs[0]))
            continue
        f0, f1 = fs[idx - 1], fs[idx]
        x0, x1 = xs[idx - 1], xs[idx]
        if f1 <= f0:
            quantiles.append(float(x0))
        else:
            t = (target - f0) / (f1 - f0)
            quantiles.append(float(x0 + t * (x1 - x0)))

    return jsonify({
        "percentiles": percents,
        "quantiles": quantiles,
        "xs": xs.tolist(),
        "fs": fs.tolist(),
        "x_max": float(x_max),
    })


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
