# DGX Spark Live VLM card

A **Live VLM** card for the NVIDIA DGX Dashboard: point a webcam at the Spark
and have a local vision model describe what it sees, controlled from the same
grid as the stock cards.

It wraps [NVIDIA-AI-IOT/live-vlm-webui](https://github.com/NVIDIA-AI-IOT/live-vlm-webui)
(WebRTC camera → any OpenAI-compatible vision endpoint) and serves it from
[llama-swap](https://github.com/mostlygeek/llama-swap) behind the load gate in
its sibling project, [dgx-spark-model-card](https://github.com/paraporoco/dgx-spark-model-card).

```
browser ── https ─────────────► :8120  live-vlm-webui   (LAN, WebRTC media)
   │                                        │
   │                                        ▼
   └── dashboard :11000                :8112  live-vlm-card
        + injected card ──────────────►   card API + vision-filtered /v1
                                            │
                                            ▼
                                       :8111  load gate  ──► :8100 llama-swap
                                       (hold, headroom, vision check)
```

Nothing under `/opt/nvidia/`, `/usr/bin/dgx-dashboard` or the `dgx-dashboard`
package is modified. `install.sh` proves it: it diffs `dpkg -V dgx-dashboard`
and the NVIDIA binary hash before and after itself.

## Why

The dashboard has no extension point — the SPA is compiled into the service
binary, and the package ships zero asset files. So a card is a sidecar plus a
userscript, exactly as in the sibling project. This one adds three things a
plain `pip install live-vlm-webui` does not give you:

- **lifecycle control from the dashboard** — start, stop, warm the model, read
  the log, without a terminal;
- **a vision-only model list** — llama-swap serves text models too, and picking
  one against a camera fails once per frame with a message that names neither
  the model nor the fix;
- **the right URL** — the WebUI must be opened over the LAN, not through the
  tunnel everything else here uses, and the card says so.

## What the card shows

Three labelled blocks, so status never shares a widget with intent.

- **SERVICE** — state, bind address, uptime, pid, restarts, frame interval,
  unit name and enablement.
- **VISION MODEL** — the active model and whether it came from the WebUI's own
  selection or the card's default; size; resident state; a used/free memory bar
  that turns amber past 85 %; every registered vision model as a chip with its
  size; and the honest caveat that the headroom guard counts weights only.
- **OPEN** — every reachable URL, and why a localhost tunnel will not do.

Footer: `Show log` · `Warm up model` · `Stop` · `Start` · `Open WebUI`.

## Requirements

- DGX Spark (or any Linux host) with `dgx-dashboard`, `llama-swap`, and a
  `llama-server` new enough for the projector your model needs. Check with:
  `strings libmtmd.so* | grep -E 'qwen3vl|gemma3|internvl|pixtral'`
- Python 3.10+, `openssl`, `systemd` with user sessions.
- At least one llama-swap model whose `cmd` carries `--mmproj`. See
  `packaging/llama-swap-vision.yaml`.

## Install

```bash
git clone https://github.com/paraporoco/dgx-spark-live-vlm-card.git
cd dgx-spark-live-vlm-card
sudo ./install.sh --user "$USER"
```

Then install `userscript/dgx-dashboard-cards.user.js` in Violentmonkey or
Tampermonkey — it injects **both** this card and the Local models card, so
disable any older single-card script.

## User units, and why

Both services are systemd **user** units with lingering enabled. That is what
lets the card start and stop the WebUI with **no polkit rule, no sudoers entry
and no root at runtime**. `install.sh` needs root only to write program files
under `/opt/local` and to call `loginctl enable-linger`.

## Networking: LAN and TLS, not a tunnel

The camera is captured **in the browser** and streamed to the host over WebRTC.
`getUserMedia` needs a secure context, and the media plane needs a path the
browser can actually reach — an SSH or NVIDIA Sync **TCP** forward carries the
HTTP port but not the ICE candidates, so a tunnelled session loads the page and
shows no video.

So the WebUI binds `0.0.0.0:8120` with a self-signed certificate (`install.sh`
generates one with every local address as a SAN) and is opened directly at
`https://<host>:8120/`. Accept the warning once per browser.

The card sidecar is loopback-only and *is* meant to be tunnelled, like the
dashboard itself.

## Two places the vision check lives, and why one is not enough

`:8112/v1/models` is filtered to models whose llama-swap `cmd` carries
`--mmproj`, so the WebUI's dropdown offers only models that can see. Everything
else forwards to the gate unchanged — this adds a filter, it bypasses nothing.

**That filter alone is not sufficient.** live-vlm-webui keeps per-session config
in the browser, *including the API base URL*, so a session that remembers an
older endpoint routes straight past it. Any client that can name its own
endpoint can do the same.

So `patches/dgx-model-card-vision-check.patch` puts the same check in the
**gate**, the one point every client goes through. A request carrying
`image_url` for a model with no `--mmproj` is refused before it reaches
llama.cpp:

```
503 dgx-model-card: 'devstral-24b' cannot serve this request -- it has no
    vision projector, so it cannot read images.
    Models that can: cosmos-reason1-7b, qwen3-vl-4b, qwen3-vl-8b
```

The refusal deliberately drops the gate's usual "set automatic loading to
Allowed" advice: neither loading nor memory would fix this one. The best case
it catches is an image request naming a 65 GiB text model — refused in
milliseconds instead of starting a load that could never have answered.

A guard beside the path is advice; a guard on the path is a rule.

## Models

Measured on a DGX Spark (GB10, 121 GiB unified), synthetic test frame,
`llama-server` build 10341:

| id | weights + mmproj | cold | warm |
|---|---|---|---|
| `qwen3-vl-4b` | 3.1 GiB | 1.60 s | **1.15 s** |
| `qwen3-vl-8b` | 5.8 GiB | 9.73 s | 1.68 s |
| `qwen2.5-vl-7b` | 5.6 GiB | 11.53 s | 1.53 s |
| `cosmos-reason1-7b` | 5.7 GiB | 9.65 s | 3.34 s |

At the default of one frame in thirty (~1 fps) a warm round-trip under ~1.5 s
keeps the stream readable. `qwen3-vl-4b` is the recommended default.

Pull GGUFs with `aria2c -x16 -s16`: a single `curl` managed 230 KB/s against
the same CDN that aria2 pulled at 4–5 MB/s.

## Configuration

| Env | Default | |
|---|---|---|
| `LVC_PORT` | 8112 | card API, card page, filtered `/v1` |
| `LVC_UNIT` | `live-vlm-webui.service` | the user unit it controls |
| `LVC_WEBUI_PORT` / `LVC_WEBUI_SCHEME` | 8120 / https | where the WebUI listens |
| `LVC_PUBLIC_HOSTS` | auto-detected | addresses the Open links use |
| `LVC_API_BASE` | `http://127.0.0.1:8111/v1` | the gate (or llama-swap directly) |
| `LVC_SWAP_URL` | `http://127.0.0.1:8100` | llama-swap control API |
| `LVC_SWAP_CONFIG` | `/etc/llama-swap/config.yaml` | where `--mmproj` is discovered |
| `LVC_MODEL` | first model with `--mmproj` | card default; the WebUI's own choice wins |
| `LVC_ORIGINS` | `localhost:11000`, … | CORS allowlist, scoped — not `*` |

## API

| | |
|---|---|
| `GET /api/status` | service state, active model and its provenance, backend reachability, vision roster, memory, URLs |
| `GET /api/logs?n=` | journal tail for the WebUI unit |
| `POST /api/start` `/api/stop` `/api/restart` | `systemctl --user`, 202 |
| `POST /api/preload` | warm the active model through the gate, 202 |
| `GET /v1/models` | filtered to models that can see |
| `* /v1/*` | proxied to the gate; image requests to blind models refused 400 |
| `GET /` `/card.js` `/healthz` | card page, injection script, liveness |

## Security posture

- Both sockets bind `127.0.0.1`; only the WebUI is on the LAN, by necessity.
- CORS is an allowlist, never `*`. A foreign origin gets no ACAO header.
- No privilege: no polkit rule, no sudoers entry, no root at runtime.
- TLS verification is disabled for exactly one call — the loopback probe of the
  WebUI's own self-signed certificate. Nothing else in the process.
- Standard library only. No pip dependencies, nothing to break on arm64.

## Known limits

- The headroom guard in the sibling project counts the `-m` file only: not the
  mmproj (0.8–1.3 GiB here), not the KV cache, not the vision encoder's
  buffers. The card states the arithmetic; the guard has not been changed.
- llama-swap discards the upstream's stderr, so an out-of-memory failure
  surfaces as `upstream command exited prematurely` and nothing else.
- Card placement depends on the dashboard's DOM. A dashboard upgrade can move
  the card; it cannot break the dashboard.
- `index.html` references a version-specific dashboard stylesheet hash purely
  for visual parity; it 404s harmlessly on other versions.
- The card reports which model the WebUI *has selected*, not what a given
  browser session will ask for next — those differ, per the config note above.

## Licence

MIT. `live-vlm-webui` is NVIDIA's and carries its own licence.
