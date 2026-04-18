#!/usr/bin/env python3
from flask import Flask, render_template, request, jsonify
import numpy as np
from scipy.integrate import quad

app = Flask(__name__)


def inner_sum(x, q, k):
    qx = q * x
    s = 0.0
    term = 1.0
    for m in range(k):
        if m > 0:
            term *= qx / m
        s += term
    return s * np.exp(-qx)


def integrand(x, qs, ks):
    prod = 1.0
    for q, k in zip(qs, ks):
        prod *= (1.0 - inner_sum(x, q, k))
    return 1.0 - prod


def compute_T(qs, ks):
    result, err = quad(integrand, 0, np.inf, args=(qs, ks), limit=200)
    return result, err


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/calculate", methods=["POST"])
def calculate():
    data = request.get_json()
    pairs = data.get("pairs", [])

    if not pairs:
        return jsonify({"error": "No items provided."}), 400

    qs, ks = [], []
    for i, pair in enumerate(pairs):
        try:
            d = float(pair["denominator"])
            k = int(pair["k"])
        except (KeyError, ValueError, TypeError):
            return jsonify({"error": f"Row {i + 1}: invalid values."}), 400

        if d <= 0:
            return jsonify({"error": f"Row {i + 1}: drop rate denominator must be > 0."}), 400
        if k <= 0:
            return jsonify({"error": f"Row {i + 1}: quantity needed must be >= 1."}), 400

        qs.append(1.0 / d)
        ks.append(k)

    qs = np.array(qs, dtype=float)
    ks = np.array(ks, dtype=int)

    warning = None
    if qs.sum() > 1.0 + 1e-12:
        warning = f"Sum of drop rates ({qs.sum():.4f}) exceeds 1 — results may be unexpected."

    T, err = compute_T(qs, ks)

    return jsonify({"result": T, "error": err, "warning": warning})


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
