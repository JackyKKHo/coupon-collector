#!/usr/bin/env python3
import re
from flask import Flask, render_template, request, jsonify
import numpy as np
from scipy.integrate import quad
from scipy.special import gammaincc

app = Flask(__name__)


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
        return v / 100.0

    m = re.match(r"^\s*([0-9.eE+-]+)\s+in\s+([0-9.eE+-]+)\s*$", text)
    if m:
        num = float(m.group(1))
        den = float(m.group(2))
        return num / den

    if "/" in text:
        parts = text.split("/")
        if len(parts) != 2:
            raise ValueError("bad fraction")
        return float(parts[0].strip()) / float(parts[1].strip())

    v = float(text)
    if v <= 0:
        raise ValueError("non-positive")
    if v < 1:
        return v
    return 1.0 / v


def survival(x, q, k):
    """P(N_q(x) < k) where N_q(x) ~ Poisson(q*x). Stable via regularized incomplete gamma."""
    if x <= 0:
        return 1.0
    return float(gammaincc(k, q * x))


def cdf(x, qs, ks):
    """F(x) = P(all items collected by trial x) = prod_i (1 - survival_i)."""
    prod = 1.0
    for q, k in zip(qs, ks):
        prod *= (1.0 - survival(x, q, k))
    return prod


def integrand(x, qs, ks):
    return 1.0 - cdf(x, qs, ks)


def compute_T(qs, ks):
    result, err = quad(integrand, 0, np.inf, args=(qs, ks), limit=200)
    return result, err


def parse_pairs(pairs):
    if not pairs:
        raise ValueError("No items provided.")
    qs, ks = [], []
    for i, pair in enumerate(pairs):
        try:
            q = parse_rate(pair.get("rate", pair.get("denominator")))
            k = int(pair["k"])
        except (KeyError, ValueError, TypeError) as e:
            raise ValueError(f"Row {i + 1}: invalid values ({e}).")
        if q <= 0 or q > 1:
            raise ValueError(f"Row {i + 1}: drop rate must be in (0, 1].")
        if k <= 0:
            raise ValueError(f"Row {i + 1}: quantity needed must be >= 1.")
        qs.append(q)
        ks.append(k)
    return np.array(qs, dtype=float), np.array(ks, dtype=int)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/calculate", methods=["POST"])
def calculate():
    data = request.get_json()
    try:
        qs, ks = parse_pairs(data.get("pairs", []))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    warning = None
    if qs.sum() > 1.0 + 1e-12:
        warning = f"Sum of drop rates ({qs.sum():.4f}) exceeds 1 — results may be unexpected."

    T, err = compute_T(qs, ks)
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
def distribution():
    data = request.get_json()
    try:
        qs, ks = parse_pairs(data.get("pairs", []))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    x_max = find_upper_bound(qs, ks)
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
