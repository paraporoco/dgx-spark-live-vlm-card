// ==UserScript==
// @name         DGX Dashboard — custom cards (Local models + Live VLM)
// @namespace    github.com/paraporoco/dgx-spark-model-card
// @version      2.3.0
// @description  Injects the local sidecar cards into the NVIDIA DGX Dashboard: Local models (:8110) and Live VLM (:8112). Touches no NVIDIA file.
// @homepageURL  https://github.com/paraporoco/dgx-spark-model-card
// @match        http://localhost:11000/*
// @match        http://127.0.0.1:11000/*
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Replaces "DGX Dashboard — Local models card" v2.2.0. Disable that one; this
 * script injects both cards.
 *
 * Each entry below is a sidecar that serves its own /card.js. All card markup,
 * polling and controls live server-side on the Spark, so changing a card means
 * editing card.js there — no userscript edit.
 *
 * Remote use
 *   Both sidecars bind 127.0.0.1 only. From another machine, forward every
 *   port you want:
 *       ssh -L 11000:127.0.0.1:11000 -L 8110:127.0.0.1:8110 -L 8112:127.0.0.1:8112 you@spark
 *   Through NVIDIA Sync, register 8110 and 8112 in custom.json and reconnect.
 *
 * The Live VLM WebUI itself (:8120) is NOT tunnelled: it is reached directly
 * over the LAN or Tailscale on https, because WebRTC media does not survive a
 * TCP-only tunnel. The card links to the right URL.
 *
 * Remove a card without touching the extension:
 *     window.__dgxModelCard.destroy()
 *     window.__liveVlmCard.destroy()
 */

(function () {
  "use strict";

  var CARDS = [
    { id: "dgx-model-card-loader", src: "http://127.0.0.1:8110", label: "Local models" },
    { id: "live-vlm-card-loader",  src: "http://127.0.0.1:8112", label: "Live VLM" }
  ];

  function inject(c) {
    if (document.getElementById(c.id)) return;
    var s = document.createElement("script");
    s.id = c.id;
    s.src = c.src + "/card.js?v=" + Date.now();
    s.async = true;
    s.onerror = function () {
      console.warn("[dgx-cards] " + c.label + " sidecar unreachable at " + c.src +
                   " — is the service running, and is the port forwarded?");
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function injectAll() { CARDS.forEach(inject); }

  injectAll();

  var reinject = new MutationObserver(function () {
    CARDS.forEach(function (c) { if (!document.getElementById(c.id)) inject(c); });
  });
  reinject.observe(document.documentElement, { childList: true, subtree: false });
})();
