# Findings

Things that cost time to establish and would cost the same again. Measured on a
DGX Spark (GB10, 121 GiB unified, Ubuntu 24.04 arm64), `llama-server` build
10341 (6ad4ab0ea), `live-vlm-webui` 0.4.0, `dgx-dashboard` 0.29.2-2.

## 1. A vision-capable dropdown is not optional

llama-swap serves every model it knows about through one `/v1/models`. Point a
camera at a text-only one and llama.cpp answers, once per frame:

```
400 Multimodal data provided, but model does not support multimodal requests.
```

It names neither the model at fault nor the fix, and at one frame per second it
produces a wall of identical errors. With 4 of 11 models able to see, the
default outcome of a fresh session is failure. Filtering the list is not
cosmetic.

## 2. A filter beside the path is advice; on the path it is a rule

`live-vlm-webui` 0.4.0 keeps per-session configuration **in the browser,
including the API base URL** — that is what its "cloud deployment configuration
overrides" release note means in practice. Changing the server's `--api-base`
does not change an existing session. A filter placed at a new endpoint is
therefore routed around by any client that remembers, or simply names, another
one.

The check has to sit at the single point every client must traverse. Here that
is the load gate. Same conclusion the gate itself reached when Hold was
advisory; rediscovered for a different failure.

## 3. `exclusive: false` does not protect a llama-swap group

Putting the vision models in their own non-exclusive group is not enough.
Loading a member of another group that is `exclusive: true` still evicts them —
exclusivity is asserted over everything outside the loading group, not
negotiated with it.

```yaml
vision:
  swap: true
  exclusive: false
  persistent: true    # <- this is the line that matters
```

Measured: with `persistent: false`, loading `mistral-7b` (in the exclusive
`large` group) evicted the resident VLM. With `persistent: true`,
`resident: ['mistral-7b', 'qwen2.5-vl-7b']` — coexistence. `swap: true` still
keeps only one *vision* model resident, which is what keeps this affordable.

## 4. WebRTC media does not survive a TCP tunnel

The page loads and the video never starts. `getUserMedia` needs a secure
context (localhost qualifies, so the page over a tunnel looks fine), but the
media plane negotiates ICE candidates the browser must reach directly. An SSH
or NVIDIA Sync forward carries the HTTP port only.

Serving `0.0.0.0` with a self-signed certificate over the LAN is the path that
works, confirmed by `ICE connection state: completed` and a received video
track. Cost: one certificate warning per browser.

## 5. Context size, not model size, killed the first loads

A VLM at `-c 16384` died with `upstream command exited prematurely` while a
fine-tuning job held 72 GiB. The same model at `-c 8192` loads and answers. The
headroom guard had allowed it: it stats the `-m` file and nothing else — not
the mmproj (0.8–1.3 GiB), not the KV cache, not the vision encoder's compute
buffers. For a VLM that underestimate is a large fraction of the real
footprint.

A webcam caption needs nothing like 16k context.

## 6. llama-swap discards the upstream's stderr

Every start failure looks identical:

```
[WARN] group: starting <model> failed: upstream command exited prematurely
```

Run the same command by hand and it loads in seconds. The message says nothing
about *why*, so an out-of-memory condition is indistinguishable from a bad path
or an unsupported projector. Always reproduce by hand before believing the
config is wrong.

## 7. llama-swap runs with `-watch-config`

Config changes are picked up live. `systemctl restart llama-swap` is not only
unnecessary, it drops whatever is resident — an expensive habit when the
resident model takes minutes to reload.

## 8. This build's projector support is broader than the docs suggest

`libmtmd.so` in build 10341 carries:

```
qwen3vl_merger  qwen2.5vl_merger  qwen2vl_merger  gemma3  gemma4v  glm4v
internvl  pixtral  idefics3  minicpmv4_6  lfm2  cogvlm  janus_pro  kimivl
dots_ocr  paddleocr  granite4_vision   + audio: voxtral ultravox qwen2a qwen3a
```

`strings` on that library is a faster answer than any compatibility table.

## 9. Measured latency, and what it means at 1 fps

| id | weights + mmproj | cold | warm |
|---|---|---|---|
| `qwen3-vl-4b` | 3.1 GiB | 1.60 s | **1.15 s** |
| `qwen3-vl-8b` | 5.8 GiB | 9.73 s | 1.68 s |
| `qwen2.5-vl-7b` | 5.6 GiB | 11.53 s | 1.53 s |
| `cosmos-reason1-7b` | 5.7 GiB | 9.65 s | 3.34 s |

On the same frame the Qwen3-VL models reported the spatial relation ("a yellow
circle sitting *atop* a red rectangle"); Qwen2.5-VL listed the shapes ("a yellow
circle *and* a red rectangle"). Cosmos-Reason1 is the slowest because it
reasons before answering — which is the point of it, and why it suits stills
and robotics prompts rather than a live stream.

## 10. GB10 reports no VRAM

`live-vlm-webui`'s GPU panel logs `VRAM monitoring not supported on NVIDIA GB10
(GB10/Blackwell limitation)` and shows utilisation only. On unified memory
`nvidia-smi --query-compute-apps` is the useful view: it attributes memory per
process where `ps` RSS does not.

## 11. Pull GGUFs with aria2

Against the same Hugging Face CDN: single-stream `curl` 230 KB/s,
`aria2c -x16 -s16 -k4M` 4–5 MB/s. A 4.7 GiB model is the difference between six
hours and twenty minutes.

## 12. `--image-min-tokens`

llama.cpp warns that Qwen-VL models want `--image-min-tokens 1024` for
grounding accuracy. Left off here: it raises per-frame cost, which is the
binding constraint on a live stream. Add it for still-frame or grounding work.
