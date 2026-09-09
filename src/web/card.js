/* live-vlm-card v1.2.0 — "Live VLM" card for the NVIDIA DGX Dashboard.
 *
 * Sibling of dgx-model-card's "Local models" card and deliberately built the
 * same way: touches no NVIDIA file, mounts one node into the card grid, and is
 * removed with window.__liveVlmCard.destroy().
 *
 * Three labelled blocks — SERVICE / VISION MODEL / OPEN — so status is never
 * the same widget as intent.
 */
(function () {
  "use strict";

  if (window.__liveVlmCard && window.__liveVlmCard.destroy) {
    window.__liveVlmCard.destroy();
  }

  var API = (function () {
    var s = document.currentScript && document.currentScript.src;
    if (s) { try { return new URL(s).origin; } catch (e) {} }
    return "http://127.0.0.1:8112";
  })();

  var MOUNT_ID = "live-vlm-card-root";
  var STYLE_ID = "live-vlm-card-style";
  var LOG_ID = "live-vlm-card-logs";

  var POLL_IDLE = 8000, POLL_BUSY = 2500;
  var timer = null, observer = null, logsOpen = false, busy = false;
  var lastStatus = null, notice = null;

  var OK = "var(--text-color-feedback-success, #76b900)";
  var WARN = "var(--text-color-feedback-warning, #f5b800)";
  var ERR = "var(--text-color-feedback-error, #f5484c)";
  var MUTED = "var(--text-color-secondary, #8f8f8f)";
  var LINE = "var(--border-color-base, #3a3a3a)";
  var RAISED = "var(--background-color-surface-raised, #1a1a1a)";

  var LBL = "nv-text nv-text--body-regular-sm";
  var MONO = "nv-text nv-text--mono-sm";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = "";
    css += "#" + MOUNT_ID + " .lvc-split{display:flex;flex-wrap:wrap;gap:20px 28px;}";
    css += "#" + MOUNT_ID + " .lvc-split > *{flex:1 1 300px;min-width:0;}";
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function api(path, opts) {
    return fetch(API + path, Object.assign({ mode: "cors", cache: "no-store" }, opts || {}))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }
  function post(path, payload) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" },
                       body: JSON.stringify(payload || {}) });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "style") n.setAttribute("style", attrs[k]);
      else if (k === "class") n.className = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function heading(text) {
    return el("div", {
      class: "nv-text nv-text--label-bold-xs",
      style: "letter-spacing:.09em;text-transform:uppercase;color:" + MUTED + ";"
    }, [text]);
  }

  function dot(color, size) {
    return el("span", {
      class: "nv-status-indicator",
      style: "--size:" + (size || 10) + "px;--color:" + color + ";background-color:" + color +
             ";width:" + (size || 10) + "px;height:" + (size || 10) + "px;border-radius:999px;" +
             "display:inline-block;flex:0 0 auto;"
    });
  }

  function line(text, style) {
    return el("div", { class: LBL, style: style || "" }, [text]);
  }

  function dur(s) {
    if (s === null || s === undefined) return null;
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min";
    if (s < 86400) return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
    return Math.floor(s / 86400) + " d " + Math.floor((s % 86400) / 3600) + " h";
  }

  function findGrid() {
    var p = document.querySelector('[data-testid="skele-panel"]');
    if (p && p.parentElement) return p.parentElement;
    var g = document.querySelector("div.flex.gap-4.flex-wrap");
    if (g) return g;
    var col = document.querySelector('[class*="max-w-"] .flex.flex-col.gap-8');
    if (col && col.lastElementChild) return col.lastElementChild;
    return null;
  }

  // ---------------------------------------------------------------- sections

  function serviceBlock(st) {
    var svc = st.service || {};
    var color = st.state === "serving" ? OK
              : st.state === "starting" ? WARN
              : st.state === "failed" ? ERR : MUTED;
    var rows = [];

    rows.push(el("div", { style: "display:flex;align-items:center;gap:8px;" }, [
      dot(color, 10),
      el("span", { class: "nv-text nv-text--body-bold-sm" }, [
        st.state === "serving" ? "Serving" :
        st.state === "starting" ? "Starting" :
        st.state === "failed" ? "Failed" : "Stopped"
      ]),
      el("span", { class: MONO, style: "opacity:.6;" }, [
        st.webui_scheme + "://0.0.0.0:" + st.webui_port
      ])
    ]));

    if (st.state === "serving" || st.state === "starting") {
      var bits = [];
      if (svc.uptime_s !== null && svc.uptime_s !== undefined) bits.push("up " + dur(svc.uptime_s));
      if (svc.pid) bits.push("pid " + svc.pid);
      if (svc.restarts) bits.push(svc.restarts + " restart" + (svc.restarts > 1 ? "s" : ""));
      bits.push("1 frame per " + st.process_every);
      rows.push(line(bits.join(" · "), "opacity:.65;"));
    } else if (st.state === "failed") {
      rows.push(line("The unit failed (" + (svc.result || "unknown") + "). Show log below.",
                     "color:" + ERR + ";"));
    } else {
      rows.push(line("Nothing is listening on port " + st.webui_port + ".", "opacity:.65;"));
    }

    rows.push(line("live-vlm-webui 0.4.0 · unit " + st.unit + " (" + (svc.enabled || "?") + ")",
                   "opacity:.45;font-size:11px;"));

    return el("div", { style: "display:flex;flex-direction:column;gap:8px;" },
              [heading("Service")].concat(rows));
  }

  function modelBlock(st) {
    var b = st.backend || {};
    var sz = st.model_size;
    var mem = st.memory || {};
    var rows = [];

    var mColor = !b.reachable ? ERR : (b.resident ? OK : (b.model_present ? MUTED : ERR));
    rows.push(el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" }, [
      dot(mColor, 8),
      el("span", { class: MONO }, [b.model || "(none)"]),
      sz ? el("span", { class: "nv-tag nv-tag--kind-outline", style: "opacity:.7;" },
              [sz.total_gib + " GiB"]) : null,
      b.resident ? el("span", { class: "nv-tag nv-tag--kind-outline nv-tag--color-green" }, ["loaded"]) : null,
      el("span", { class: LBL, style: "opacity:.45;font-size:11px;" },
         [st.active_source === "webui" ? "selected in the WebUI" : "card default"])
    ]));

    if (!b.reachable) {
      rows.push(line("Load gate at " + b.api_base + " is unreachable — inference will fail.",
                     "color:" + ERR + ";"));
    } else if (!b.model_present) {
      rows.push(line("Not registered in llama-swap. Add it to /etc/llama-swap/config.yaml.",
                     "color:" + ERR + ";"));
    } else if (b.resident) {
      rows.push(line("Resident and answering. Frames go straight to it.", "opacity:.65;"));
    } else {
      var fits = sz && mem.available_gib !== undefined
        ? (mem.available_gib >= sz.total_gib + 2) : true;
      rows.push(line(
        fits ? "Not loaded. The first frame will load it (" + (sz ? sz.total_gib + " GiB" : "") + ") — warm it up first to avoid a stalled stream."
             : "Not loaded, and only " + mem.available_gib + " GiB is free — the load gate will refuse it.",
        fits ? "opacity:.65;" : "color:" + WARN + ";"));
    }

    if (sz && sz.mmproj_gib) {
      rows.push(line("weights " + sz.weights_gib + " GiB + projector " + sz.mmproj_gib +
                     " GiB — the headroom guard counts the weights only.",
                     "opacity:.45;font-size:11px;"));
    }

    if (mem.total_gib) {
      var pct = Math.min(100, mem.used_pct || 0);
      rows.push(el("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:2px;" }, [
        el("div", { style: "height:6px;border-radius:999px;background:" + RAISED +
                           ";border:1px solid " + LINE + ";overflow:hidden;" }, [
          el("div", { style: "height:100%;width:" + pct + "%;background:" +
                             (pct > 85 ? WARN : OK) + ";" })
        ]),
        line(mem.used_gib + " used / " + mem.available_gib + " GiB free of " + mem.total_gib,
             "opacity:.55;font-size:11px;")
      ]));
    }

    var roster = st.vision_models || [];
    if (roster.length > 1) {
      rows.push(el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;" },
        roster.map(function (m) {
          var on = m.id === (st.active_model || b.model);
          return el("span", {
            class: "nv-tag nv-tag--kind-outline" + (on ? " nv-tag--color-green" : ""),
            title: m.name + " — " + m.total_gib + " GiB",
            style: on ? "" : "opacity:.55;"
          }, [m.id + " · " + m.total_gib + " GiB"]);
        })));
      rows.push(line("Switch in the WebUI sidebar (Model). Only models with a vision " +
                     "projector are offered — text-only models are filtered out.",
                     "opacity:.45;font-size:11px;"));
    }

    var pre = st.preload || {};
    if (pre.running) {
      rows.push(line("Warming up — a cold load can take minutes.", "color:" + WARN + ";"));
    } else if (pre.result) {
      rows.push(pre.result.ok
        ? line("Warm-up finished in " + pre.result.seconds + " s.", "color:" + OK + ";")
        : line("Warm-up refused" + (pre.result.code ? " (" + pre.result.code + ")" : "") +
               ": " + (pre.result.detail || "").slice(0, 140), "color:" + WARN + ";"));
    }

    return el("div", { style: "display:flex;flex-direction:column;gap:8px;" },
              [heading("Vision model")].concat(rows));
  }

  function openBlock(st) {
    var u = st.urls || {};
    var rows = [];
    rows.push(line("The camera is captured in your browser and streamed to the GX10 over WebRTC, " +
                   "so open it on the machine holding the webcam.", "opacity:.65;"));
    (u.public || []).forEach(function (href) {
      rows.push(el("a", {
        class: MONO, href: href, target: "_blank", rel: "noopener",
        style: "color:" + OK + ";text-decoration:none;"
      }, [href]));
    });
    rows.push(line("Self-signed certificate — accept the browser warning once per machine. " +
                   "A plain-HTTP tunnel to localhost loads the page but not the video.",
                   "opacity:.45;font-size:11px;"));
    return el("div", { style: "display:flex;flex-direction:column;gap:6px;" },
              [heading("Open")].concat(rows));
  }

  // ------------------------------------------------------------------ render

  function render(st) {
    injectStyle();

    var running = st.state === "serving" || st.state === "starting";
    var tagColor = st.state === "serving" ? "green"
                 : st.state === "starting" ? "yellow"
                 : st.state === "failed" ? "red" : "gray";
    var tagText = st.state === "serving" ? "Serving"
                : st.state === "starting" ? "Starting"
                : st.state === "failed" ? "Failed" : "Idle";

    var startBtn = el("button", {
      class: "nv-button nv-button--kind-primary nv-button--color-brand",
      disabled: (busy || running) ? "" : null,
      onclick: function () { act("/api/start"); }
    }, ["Start"]);

    var stopBtn = el("button", {
      class: "nv-button",
      disabled: (busy || !running) ? "" : null,
      onclick: function () { act("/api/stop"); }
    }, ["Stop"]);

    var warmBtn = el("button", {
      class: "nv-button",
      disabled: (busy || (st.preload && st.preload.running) ||
                 !(st.backend && st.backend.model_present) ||
                 (st.backend && st.backend.resident)) ? "" : null,
      onclick: function () { act("/api/preload"); }
    }, ["Warm up model"]);

    var openBtn = el("a", {
      class: "nv-button nv-button--kind-primary nv-button--color-brand",
      href: (st.urls && st.urls.open) || "#", target: "_blank", rel: "noopener",
      style: running ? "" : "opacity:.4;pointer-events:none;",
      "aria-disabled": running ? null : "true"
    }, ["Open WebUI"]);

    var body = [
      el("div", { class: "lvc-split" }, [serviceBlock(st), modelBlock(st)]),
      el("div", { style: "height:1px;background:" + LINE + ";" }),
      openBlock(st)
    ];

    if (notice) {
      body.push(el("div", {
        class: LBL,
        style: "border:1px solid " + LINE + ";border-radius:6px;padding:8px 10px;color:" + WARN + ";"
      }, [notice]));
    }

    if (logsOpen) {
      body.push(el("pre", {
        id: LOG_ID, class: MONO,
        style: "margin:0;max-height:220px;overflow:auto;background:" + RAISED +
               ";border:1px solid " + LINE + ";border-radius:6px;padding:10px;font-size:11px;"
      }, ["(loading…)"]));
    }

    var panel = el("div", {
      id: MOUNT_ID,
      class: "nv-panel nv-panel--elevation-low flex-1 min-w-full md:min-w-[520px]",
      style: "border:1px solid " + LINE + ";border-radius:8px;display:flex;" +
             "flex-direction:column;flex:1 1 100%;min-width:100%;"
    }, [
      el("div", { class: "nv-panel-header",
                  style: "display:flex;align-items:center;justify-content:space-between;" +
                         "gap:12px;padding:14px 18px;border-bottom:1px solid " + LINE + ";" }, [
        el("div", { style: "display:flex;flex-direction:column;gap:2px;" }, [
          el("span", { class: "nv-panel-header-heading nv-text nv-text--title-sm" }, ["Live VLM"]),
          el("span", { class: LBL, style: "opacity:.55;" },
             ["webcam → " + (st.active_model || (st.backend && st.backend.model) || "vision model") +
              " · " + ((st.vision_models || []).length || 0) + " vision model" +
              (((st.vision_models || []).length === 1) ? "" : "s") + " · port " + st.webui_port])
        ]),
        el("span", { class: "nv-tag nv-tag--kind-outline nv-tag--color-" + tagColor }, [tagText])
      ]),
      el("div", { style: "display:flex;flex-direction:column;gap:16px;padding:16px 18px;" }, body),
      el("div", { class: "nv-panel-footer",
                  style: "display:flex;align-items:center;justify-content:space-between;" +
                         "gap:12px;padding:12px 18px;border-top:1px solid " + LINE + ";" }, [
        el("button", {
          class: "nv-button",
          onclick: function () { logsOpen = !logsOpen; refresh(); if (logsOpen) loadLogs(); }
        }, [logsOpen ? "Hide log" : "Show log"]),
        el("div", { style: "display:flex;gap:8px;" }, [warmBtn, stopBtn, startBtn, openBtn])
      ])
    ]);

    return panel;
  }

  // ----------------------------------------------------------------- actions

  function act(path) {
    busy = true; notice = null; refresh();
    post(path).then(function (r) {
      if (!r.ok && r.body) {
        notice = r.body.detail || r.body.reason || ("HTTP " + r.status);
      }
    }).catch(function () { notice = "Card sidecar unreachable at " + API; })
      .then(function () { busy = false; schedule(POLL_BUSY); tick(); });
  }

  function mount(node) {
    var grid = findGrid();
    if (!grid) return false;
    var cur = document.getElementById(MOUNT_ID);
    if (cur && cur.parentElement === grid) {
      grid.replaceChild(node, cur);
    } else {
      if (cur && cur.parentElement) cur.parentElement.removeChild(cur);
      grid.appendChild(node);
    }
    return true;
  }

  function loadLogs() {
    api("/api/logs?n=120").then(function (r) {
      var p = document.getElementById(LOG_ID);
      if (p) {
        p.textContent = (r.body.lines || []).join("\n") || "(empty)";
        p.scrollTop = p.scrollHeight;
      }
    }).catch(function () {});
  }

  function refresh() { if (lastStatus) mount(render(lastStatus)); }

  function tick() {
    api("/api/status").then(function (r) {
      lastStatus = r.body;
      mount(render(lastStatus));
      if (logsOpen) loadLogs();
      var b = lastStatus.state === "starting" ||
              (lastStatus.preload && lastStatus.preload.running);
      schedule(b ? POLL_BUSY : POLL_IDLE);
    }).catch(function (e) {
      lastStatus = {
        state: "unknown", unit: "?", service: {}, webui_port: 8120,
        webui_scheme: "https", urls: {}, backend: {}, memory: {},
        process_every: 30, preload: {}
      };
      notice = "Card sidecar unreachable at " + API +
               ". If you are browsing through NVIDIA Sync, port 8112 needs a tile.";
      mount(render(lastStatus));
      schedule(POLL_IDLE);
    });
  }

  function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(tick, ms); }

  function watch() {
    observer = new MutationObserver(function () {
      if (!document.getElementById(MOUNT_ID) && lastStatus && findGrid()) mount(render(lastStatus));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function waitForGrid(n) {
    if (findGrid()) { tick(); watch(); return; }
    if (n > 120) return;
    setTimeout(function () { waitForGrid(n + 1); }, 500);
  }

  window.__liveVlmCard = {
    api: API, refresh: tick,
    destroy: function () {
      if (timer) clearTimeout(timer);
      if (observer) observer.disconnect();
      var n = document.getElementById(MOUNT_ID);
      if (n && n.parentElement) n.parentElement.removeChild(n);
      var s = document.getElementById(STYLE_ID);
      if (s && s.parentElement) s.parentElement.removeChild(s);
      delete window.__liveVlmCard;
    }
  };

  waitForGrid(0);
})();
