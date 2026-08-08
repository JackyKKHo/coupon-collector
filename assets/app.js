/**
 * UI for the coupon-collector calculator.
 *
 * Everything the two Flask endpoints used to do now happens here through
 * CouponMath, so there are no fetch calls and no server. Two consequences worth
 * knowing about while reading this file:
 *
 *   - Results are cached as the parsed `state` object rather than re-read from
 *     the DOM. The old code recovered the expected value by parsing it back out
 *     of resultValue.textContent, which had already been through toLocaleString.
 *   - The Distribution tab's "by trials" mode evaluates the CDF directly at the
 *     entered trial count instead of interpolating the transport grid, because
 *     the CDF is now a local function call rather than a round trip.
 */
(function () {
  "use strict";

  var CM = window.CouponMath;

  var tbody = document.getElementById("itemsBody");
  var btnAdd = document.getElementById("btnAdd");
  var btnCalc = document.getElementById("btnCalc");
  var btnShare = document.getElementById("btnShare");
  var kphInput = document.getElementById("kphInput");
  var resultBox = document.getElementById("resultBox");
  var resultValue = document.getElementById("resultValue");
  var resultTime = document.getElementById("resultTime");
  var resultSub = document.getElementById("resultSub");
  var warningBox = document.getElementById("warningBox");
  var errorBox = document.getElementById("errorBox");
  var toast = document.getElementById("toast");

  var distEmpty = document.getElementById("distEmpty");
  var distContent = document.getElementById("distContent");
  var pctSlider = document.getElementById("pctSlider");
  var pctValue = document.getElementById("pctValue");
  var pctInline = document.getElementById("sliderPctInline");
  var quantileValue = document.getElementById("quantileValue");
  var quantileTime = document.getElementById("quantileTime");
  var chartSvg = document.getElementById("distChart");
  var quickStats = document.getElementById("quickStats");
  var modeBtnPct = document.getElementById("modeBtnPct");
  var modeBtnKc = document.getElementById("modeBtnKc");
  var pctModePanel = document.getElementById("pctModePanel");
  var kcModePanel = document.getElementById("kcModePanel");
  var kcInput = document.getElementById("kcInput");
  var distCalloutLabel = document.getElementById("distCalloutLabel");
  var distCalloutSub = document.getElementById("distCalloutSub");

  var STORAGE_KEY = "coupon-collector:last-input";
  var state = null;      // last successful CouponMath.solve() result
  var distMode = "pct";  // "pct" | "kc"

  // ------------------------------------------------------------ formatting --

  function getKPH() {
    var v = parseFloat((kphInput.value || "").replace(/,/g, ""));
    return isFinite(v) && v > 0 ? v : null;
  }

  function formatTime(trials, kph) {
    if (!kph || !isFinite(trials)) return "";
    var hours = trials / kph;
    if (hours < 1) return "≈ " + Math.round(hours * 60) + " min";
    if (hours < 24) {
      return "≈ " + hours.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " hours";
    }
    var days = Math.floor(hours / 24);
    var rem = Math.round(hours - days * 24);
    // Rounding the remainder can push it to a full 24, which would otherwise
    // print as "1d 24h" instead of "2d 0h" (47.8 hours did exactly that).
    if (rem === 24) {
      days += 1;
      rem = 0;
    }
    return "≈ " + days + "d " + rem + "h (" +
      hours.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " h)";
  }

  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    return n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add("visible");
  }

  function clearMessages() {
    errorBox.classList.remove("visible");
    warningBox.classList.remove("visible");
  }

  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("visible"); }, 1800);
  }

  // ------------------------------------------------------------------ rows --

  /**
   * Build a row out of DOM nodes and assign values as properties.
   *
   * The previous version interpolated the label straight into an innerHTML
   * string, so a label containing a quote broke out of the value attribute.
   * That was survivable when labels could only come from the person typing
   * them; now that a link can carry a whole table, a shared URL could have run
   * script in the recipient's page.
   */
  function addRow(rate, k, label, count) {
    var tr = document.createElement("tr");
    tr.className = "item-row";

    function cell(input) {
      var td = document.createElement("td");
      td.appendChild(input);
      tr.appendChild(td);
      return td;
    }

    var labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.placeholder = "e.g. Bandos Chestplate";
    labelInput.value = label || "";
    cell(labelInput);

    var rateInput = document.createElement("input");
    rateInput.type = "text";
    rateInput.placeholder = "3000, 1/3000, 0.03%";
    rateInput.value = rate || "";
    cell(rateInput);

    var kInput = document.createElement("input");
    kInput.type = "number";
    kInput.min = "1";
    kInput.step = "1";
    kInput.placeholder = "1";
    kInput.value = k || "1";
    cell(kInput);

    var countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "1";
    countInput.step = "1";
    countInput.placeholder = "1";
    countInput.title = "How many separate items share this rate";
    countInput.value = count || "1";
    cell(countInput);

    var removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.title = "Remove row";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", function () {
      tr.remove();
      updateRemoveButtons();
    });
    cell(removeBtn);

    tbody.appendChild(tr);
    updateRemoveButtons();
    return tr;
  }

  function updateRemoveButtons() {
    var btns = tbody.querySelectorAll(".btn-remove");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = btns.length === 1;
  }

  function getRows() {
    var rows = [];
    var trs = tbody.querySelectorAll(".item-row");
    for (var i = 0; i < trs.length; i++) {
      var inputs = trs[i].querySelectorAll("input");
      rows.push({
        label: inputs[0].value.trim(),
        rate: inputs[1].value.trim(),
        k: inputs[2].value.trim(),
        count: inputs[3].value.trim() || "1"
      });
    }
    return rows;
  }

  function clearInvalidMarks() {
    var inputs = tbody.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) inputs[i].classList.remove("invalid");
  }

  function markInvalid(rowIndex, col) {
    var trs = tbody.querySelectorAll(".item-row");
    if (!trs[rowIndex]) return;
    var input = trs[rowIndex].querySelectorAll("input")[col];
    if (input) {
      input.classList.add("invalid");
      input.focus();
    }
  }

  // ------------------------------------------------------- share / restore --

  function encodeState() {
    var rows = getRows();
    var parts = rows.map(function (r) {
      return [r.label, r.rate, r.k, r.count].map(encodeURIComponent).join(",");
    });
    // encodeURIComponent escapes both "," and ";", so they stay safe separators.
    var hash = "v=1&rows=" + parts.join(";");
    var kph = kphInput.value.trim();
    if (kph) hash += "&kph=" + encodeURIComponent(kph);
    return hash;
  }

  function decodeState(hash) {
    if (!hash) return null;
    if (hash.charAt(0) === "#") hash = hash.slice(1);
    if (!hash) return null;

    var out = { rows: [], kph: "" };
    var fields = hash.split("&");
    var rowsField = null;
    for (var i = 0; i < fields.length; i++) {
      var eq = fields[i].indexOf("=");
      if (eq < 0) continue;
      var key = fields[i].slice(0, eq);
      var val = fields[i].slice(eq + 1);
      if (key === "rows") rowsField = val;
      else if (key === "kph") out.kph = safeDecode(val);
    }
    if (!rowsField) return null;

    var chunks = rowsField.split(";");
    for (var j = 0; j < chunks.length; j++) {
      if (!chunks[j]) continue;
      var f = chunks[j].split(",");
      out.rows.push({
        label: safeDecode(f[0] || ""),
        rate: safeDecode(f[1] || ""),
        k: safeDecode(f[2] || "1"),
        count: safeDecode(f[3] || "1")
      });
    }
    return out.rows.length ? out : null;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return ""; }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // clipboard API needs a secure context, which file:// is not.
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        rows: getRows(),
        kph: kphInput.value.trim()
      }));
    } catch (e) { /* private mode / quota — not worth surfacing */ }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && Array.isArray(parsed.rows) && parsed.rows.length ? parsed : null;
    } catch (e) { return null; }
  }

  // -------------------------------------------------------------- calculate --

  function calculate() {
    clearMessages();
    clearInvalidMarks();

    var rows = getRows();

    // Cheap per-field checks first, so the message can point at a specific box.
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.rate) {
        showError("Row " + (i + 1) + ": drop rate is required.");
        markInvalid(i, 1);
        return;
      }
      try {
        CM.parseRate(r.rate);
      } catch (e) {
        showError("Row " + (i + 1) + ": " + e.message + ".");
        markInvalid(i, 1);
        return;
      }
      if (!/^\d+$/.test(r.k) || Number(r.k) < 1) {
        showError("Row " + (i + 1) + ": quantity must be a positive whole number.");
        markInvalid(i, 2);
        return;
      }
      if (!/^\d+$/.test(r.count) || Number(r.count) < 1) {
        showError("Row " + (i + 1) + ": count must be a positive whole number.");
        markInvalid(i, 3);
        return;
      }
    }

    // Run the solve synchronously. An earlier version deferred it behind
    // requestAnimationFrame (and then setTimeout) so a "Calculating…" label
    // could paint first, but both are suspended while a tab is hidden, which
    // left the button stuck in its disabled state for anyone who clicked and
    // switched away. Measured cost: ~2-4 ms for an ordinary table (any number
    // of identical items, since those are grouped), ~120 ms for a full 200
    // distinct-rate table, and ~580 ms for 200 distinct rates each needing
    // 100+ copies. Only that last case is perceptible, and it is well past
    // what anyone types by hand.
    try {
      state = CM.solve(rows);
      renderResult();
      saveLocal();
      try {
        history.replaceState(null, "", "#" + encodeState());
      } catch (e) { /* file:// can reject replaceState */ }
    } catch (err) {
      state = null;
      showError(err && err.message ? err.message : String(err));
      resultBox.classList.remove("visible");
      distContent.classList.remove("visible");
      distEmpty.style.display = "block";
      distEmpty.textContent = "Run Calculate to see the distribution.";
    }
  }

  function renderResult() {
    var T = state.expected;
    resultValue.textContent = T.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    resultTime.textContent = formatTime(T, getKPH());
    resultSub.textContent = "Estimated numerical error ≈ " + state.error.toExponential(2) +
      "  ·  " + state.totalItems.toLocaleString("en-US") +
      (state.totalItems === 1 ? " item" : " items") +
      " in " + state.groups.length +
      (state.groups.length === 1 ? " group" : " groups");
    resultBox.classList.add("visible");

    if (state.warnings.length) {
      warningBox.textContent = "⚠ " + state.warnings.join(" ");
      warningBox.classList.add("visible");
    } else {
      warningBox.classList.remove("visible");
    }

    if (state.distribution) {
      renderDistribution();
    } else {
      distContent.classList.remove("visible");
      distEmpty.style.display = "block";
      distEmpty.textContent = "Could not compute a distribution for these inputs.";
    }
  }

  // ------------------------------------------------------------ distribution --

  function quantileFor(p) {
    if (!state || !state.distribution) return null;
    var i = state.distribution.percentiles.indexOf(p);
    return i >= 0 ? state.distribution.quantiles[i] : null;
  }

  function renderDistribution() {
    distEmpty.style.display = "none";
    distContent.classList.add("visible");

    var kph = getKPH();
    var ps = [50, 75, 90, 95, 99];
    var html = "";
    for (var i = 0; i < ps.length; i++) {
      var q = quantileFor(ps[i]);
      var sub = (kph && q !== null && isFinite(q))
        ? '<div class="stat-sub">' + formatTime(q, kph) + "</div>"
        : "";
      html += '<div class="stat"><div class="stat-label">P' + ps[i] +
        '</div><div class="stat-value">' + fmt(q) + "</div>" + sub + "</div>";
    }
    quickStats.innerHTML = html;

    refreshDistReadout();
  }

  function refreshDistReadout() {
    if (distMode === "pct") updateSliderReadout();
    else updateKCReadout();
  }

  function updateSliderReadout() {
    var p = parseInt(pctSlider.value, 10);
    pctValue.textContent = p + "%";
    if (pctInline) pctInline.textContent = p;
    if (state && state.distribution) {
      var q = quantileFor(p);
      quantileValue.textContent = fmt(q);
      quantileTime.textContent = q === null ? "" : formatTime(q, getKPH());
    }
    drawChart();
  }

  function updateKCReadout() {
    var kc = parseFloat(kcInput.value);
    if (!state || !isFinite(kc) || kc < 0) {
      quantileValue.textContent = "—";
      quantileTime.textContent = "";
      distCalloutLabel.textContent = "Chance of being done by now";
      drawChart();
      return;
    }
    // Evaluated exactly rather than interpolated off the plotting grid.
    var prob = CM.cdf(kc, state.groups);
    distCalloutLabel.textContent = "Chance of being done after " + fmt(kc) + " trials";
    quantileValue.textContent =
      (prob * 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
    quantileTime.textContent = "";
    drawChart();
  }

  function setMode(mode) {
    distMode = mode;
    modeBtnPct.classList.toggle("active", mode === "pct");
    modeBtnKc.classList.toggle("active", mode === "kc");
    pctModePanel.classList.toggle("hidden", mode !== "pct");
    kcModePanel.classList.toggle("hidden", mode !== "kc");

    if (mode === "pct") {
      distCalloutSub.textContent = "Move the slider to scrub through percentiles.";
      // Rebuild the label without innerHTML so the cached #sliderPctInline node
      // stays the one actually on the page.
      distCalloutLabel.textContent = "Trials to be done with ";
      pctInline = document.createElement("span");
      pctInline.id = "sliderPctInline";
      pctInline.textContent = pctSlider.value;
      distCalloutLabel.appendChild(pctInline);
      distCalloutLabel.appendChild(document.createTextNode("% probability"));
    } else {
      distCalloutSub.textContent = "Enter how many trials you've done to see your odds so far.";
      distCalloutLabel.textContent = "Chance of being done by now";
      pctInline = null;
    }
    if (state) refreshDistReadout();
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        el.setAttribute(key, attrs[key]);
      }
    }
    return el;
  }

  function drawChart() {
    while (chartSvg.firstChild) chartSvg.removeChild(chartSvg.firstChild);
    if (!state || !state.distribution) return;

    var W = 700, H = 360;
    var padL = 64, padR = 16, padT = 14, padB = 38;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;

    var dist = state.distribution;
    var pts = [];
    for (var i = 0; i < dist.percentiles.length; i++) {
      var q = dist.quantiles[i];
      if (q !== null && isFinite(q)) pts.push([dist.percentiles[i], q]);
    }
    if (pts.length < 2) {
      var msg = svgEl("text", {
        x: W / 2, y: H / 2, fill: "#64748b",
        "text-anchor": "middle", "font-size": "14"
      });
      msg.textContent = "Not enough data to plot";
      chartSvg.appendChild(msg);
      return;
    }

    var yMax = 0;
    for (i = 0; i < pts.length; i++) yMax = Math.max(yMax, pts[i][1]);
    var span = yMax || 1;

    var xToPx = function (p) { return padL + ((p - 1) / 98) * innerW; };
    var yToPx = function (v) { return padT + innerH - (v / span) * innerH; };

    // Gridlines and axis labels.
    var yTickCount = 5;
    for (i = 0; i <= yTickCount; i++) {
      var v = (yMax / yTickCount) * i;
      var y = yToPx(v);
      chartSvg.appendChild(svgEl("line", {
        x1: padL, y1: y.toFixed(1), x2: W - padR, y2: y.toFixed(1),
        stroke: "#1e293b", "stroke-width": "1"
      }));
      var yl = svgEl("text", {
        x: padL - 8, y: (y + 4).toFixed(1), fill: "#475569",
        "font-size": "10", "text-anchor": "end"
      });
      yl.textContent = fmt(v);
      chartSvg.appendChild(yl);
    }
    var xTicks = [1, 25, 50, 75, 99];
    for (i = 0; i < xTicks.length; i++) {
      var x = xToPx(xTicks[i]);
      chartSvg.appendChild(svgEl("line", {
        x1: x.toFixed(1), y1: padT, x2: x.toFixed(1), y2: padT + innerH,
        stroke: "#1e293b", "stroke-width": "1"
      }));
      var xl = svgEl("text", {
        x: x.toFixed(1), y: padT + innerH + 16, fill: "#475569",
        "font-size": "10", "text-anchor": "middle"
      });
      xl.textContent = xTicks[i] + "%";
      chartSvg.appendChild(xl);
    }

    var pathD = "";
    for (i = 0; i < pts.length; i++) {
      pathD += (i === 0 ? "M" : "L") + xToPx(pts[i][0]).toFixed(1) + "," +
        yToPx(pts[i][1]).toFixed(1);
      if (i < pts.length - 1) pathD += " ";
    }
    var baseline = padT + innerH;
    var areaD = pathD +
      " L" + xToPx(pts[pts.length - 1][0]).toFixed(1) + "," + baseline +
      " L" + xToPx(pts[0][0]).toFixed(1) + "," + baseline + " Z";

    var defs = svgEl("defs", {});
    var grad = svgEl("linearGradient", { id: "areaGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#7c3aed", "stop-opacity": "0.35" }));
    grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#7c3aed", "stop-opacity": "0.02" }));
    defs.appendChild(grad);
    chartSvg.appendChild(defs);

    chartSvg.appendChild(svgEl("path", { d: areaD, fill: "url(#areaGrad)" }));
    chartSvg.appendChild(svgEl("path", {
      d: pathD, fill: "none", stroke: "#a78bfa", "stroke-width": "2"
    }));

    // Marker: driven by the slider in pct mode, or by the entered trial count
    // (converted to its probability) in kc mode.
    var curP = null, curQ = null;
    if (distMode === "pct") {
      curP = parseInt(pctSlider.value, 10);
      curQ = quantileFor(curP);
    } else {
      var kc = parseFloat(kcInput.value);
      if (isFinite(kc) && kc >= 0) {
        var prob = CM.cdf(kc, state.groups);
        curP = Math.min(99, Math.max(1, prob * 100));
        curQ = kc;
      }
    }

    if (curP !== null && curQ !== null && isFinite(curP) && isFinite(curQ)) {
      var mx = xToPx(curP);
      // SVG does not clip its own overflow, so a trial count past the plotted
      // range would otherwise draw the marker outside the axes.
      var my = Math.min(baseline, Math.max(padT, yToPx(curQ)));
      chartSvg.appendChild(svgEl("line", {
        x1: mx.toFixed(1), y1: padT, x2: mx.toFixed(1), y2: baseline,
        stroke: "#7c3aed", "stroke-width": "1", "stroke-dasharray": "3,3", opacity: "0.6"
      }));
      chartSvg.appendChild(svgEl("line", {
        x1: padL, y1: my.toFixed(1), x2: mx.toFixed(1), y2: my.toFixed(1),
        stroke: "#7c3aed", "stroke-width": "1", "stroke-dasharray": "3,3", opacity: "0.6"
      }));
      chartSvg.appendChild(svgEl("circle", {
        cx: mx.toFixed(1), cy: my.toFixed(1), r: "5",
        fill: "#a78bfa", stroke: "#0f1117", "stroke-width": "2"
      }));
    }

    var xAxis = svgEl("text", {
      x: padL + innerW / 2, y: H - 6, fill: "#64748b",
      "font-size": "11", "text-anchor": "middle"
    });
    xAxis.textContent = "Probability of being done (%)";
    chartSvg.appendChild(xAxis);

    var yAxis = svgEl("text", {
      x: 14, y: padT + innerH / 2, fill: "#64748b", "font-size": "11",
      "text-anchor": "middle", transform: "rotate(-90 14 " + (padT + innerH / 2) + ")"
    });
    yAxis.textContent = "Trials needed";
    chartSvg.appendChild(yAxis);
  }

  // ----------------------------------------------------------------- events --

  btnAdd.addEventListener("click", function () { addRow(); });
  btnCalc.addEventListener("click", calculate);

  btnShare.addEventListener("click", function () {
    var hash = "#" + encodeState();
    try { history.replaceState(null, "", hash); } catch (e) { /* file:// */ }
    var url = location.href.split("#")[0] + hash;
    copyText(url).then(
      function () { showToast("Link copied — it reproduces this table."); },
      function () { showToast("Couldn't copy. The link is in your address bar."); }
    );
  });

  // Enter anywhere in the table submits, like a form would.
  tbody.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      calculate();
    }
  });
  kphInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); calculate(); }
  });

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      document.querySelectorAll(".tab-panel").forEach(function (p) {
        p.classList.toggle("active", p.dataset.tab === name);
      });
    });
  });

  modeBtnPct.addEventListener("click", function () { setMode("pct"); });
  modeBtnKc.addEventListener("click", function () { setMode("kc"); });
  pctSlider.addEventListener("input", updateSliderReadout);
  kcInput.addEventListener("input", updateKCReadout);

  kphInput.addEventListener("input", function () {
    // Time annotations are a pure re-render of the cached result — no re-solve.
    if (state) {
      resultTime.textContent = formatTime(state.expected, getKPH());
      renderDistribution();
    }
    saveLocal();
  });

  // ------------------------------------------------------------------ boot --

  function applyState(saved) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    for (var i = 0; i < saved.rows.length; i++) {
      var r = saved.rows[i];
      addRow(r.rate, r.k, r.label, r.count);
    }
    kphInput.value = saved.kph || "";
  }

  var fromHash = decodeState(location.hash);
  var restored = fromHash || loadLocal();
  if (restored && restored.rows.length) applyState(restored);
  else addRow("3000", "1");

  setMode("pct");

  // A shared link should land on its answer, not on an empty form.
  if (fromHash) calculate();

  // Pasting a share link into the address bar while the page is already open is
  // a same-document navigation — the hash changes but nothing reloads, so
  // without this the new table would be silently ignored. calculate() updates
  // the hash via replaceState, which does not fire hashchange, so this can't loop.
  window.addEventListener("hashchange", function () {
    var next = decodeState(location.hash);
    if (!next) return;
    applyState(next);
    calculate();
  });
})();
