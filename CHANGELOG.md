# Changelog

## 1.2.0 — 2026-09-09

First public release.

- **Live VLM card** (`:8112`): service lifecycle, active model with provenance,
  vision-model roster, memory bar, warm-up, log drawer, correct Open URLs.
- **Vision-only `/v1`**: `/v1/models` filtered to models whose llama-swap `cmd`
  carries `--mmproj`; image requests to blind models refused with a message
  that names the fix; everything else proxied to the load gate unchanged.
- **Gate patch** for `dgx-spark-model-card`, because the filter alone is
  routed around by per-session client config.
- **Card tracks the WebUI's own model selection** (`current: true` from its
  `/models`) rather than a hardcoded name.
- **Installer** for both user units, lingering, venv, pinned
  `live-vlm-webui==0.4.0`, and a self-signed certificate with every local
  address as a SAN. Proves the NVIDIA package is untouched.
- **Userscript 2.3.0** injects both this card and the Local models card.

### Version history before publication

- 1.0.0 — card, control plane, standalone page, userscript.
- 1.1.0 — track the WebUI's selection; report the vision roster.
- 1.2.0 — vision-only `/v1` filter and proxy; gate patch.
