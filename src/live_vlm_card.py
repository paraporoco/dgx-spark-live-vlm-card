#!/usr/bin/env python3
"""live-vlm-card - "Live VLM" card sidecar for the NVIDIA DGX Dashboard.

Companion to dgx-model-card (:8110). Same rules:
  * touches no NVIDIA file, no /opt/nvidia, no dgx-dashboard package;
  * Python 3 standard library only - no pip, no venv, nothing to break on
    arm64 or at upgrade;
  * no privilege. It runs as a systemd *user* service and controls another
    systemd *user* service, so there is no polkit rule, no sudoers entry and
    no root anywhere.

Serves:
    GET  /                 standalone card page
    GET  /card.js          the injection script (same one the dashboard uses)
    GET  /healthz          liveness
    GET  /api/status       service state, backend reachability, URLs, memory
    GET  /api/logs?n=      journal tail for the webui unit
    POST /api/start        systemctl --user start   (202)
    POST /api/stop         systemctl --user stop    (202)
    POST /api/restart      systemctl --user restart (202)
    POST /api/preload      warm the VLM through the load gate (202)

Version 1.0.0
"""

import json
import os
import re
import http.client
import shutil
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.2.0"

HOST = os.environ.get("LVC_HOST", "127.0.0.1")
PORT = int(os.environ.get("LVC_PORT", "8112"))
UNIT = os.environ.get("LVC_UNIT", "live-vlm-webui.service")
WEBROOT = os.environ.get("LVC_WEBROOT", "/opt/local/live-vlm-card/web")

WEBUI_SCHEME = os.environ.get("LVC_WEBUI_SCHEME", "https")
WEBUI_PORT = int(os.environ.get("LVC_WEBUI_PORT", "8120"))
def _local_addresses():
    """Non-loopback IPv4 addresses of this host, for the card's Open links.

    The WebUI must be opened over the LAN rather than a tunnel (see README),
    so the card has to show a reachable address. Override with LVC_PUBLIC_HOSTS
    when the useful address is not one this host can see - a Tailscale name,
    a DNS name, a NAT address.
    """
    out = []
    try:
        for line in subprocess.run(["ip", "-4", "-o", "addr", "show"],
                                   capture_output=True, text=True,
                                   timeout=5).stdout.splitlines():
            parts = line.split()
            if len(parts) < 4 or parts[1] == "lo":
                continue
            addr = parts[3].split("/")[0]
            if addr.startswith(("127.", "172.17.", "172.18.", "172.19.")):
                continue          # loopback and docker bridges are not useful here
            out.append(addr)
    except Exception:
        pass
    return out


_env_hosts = os.environ.get("LVC_PUBLIC_HOSTS", "")
PUBLIC_HOSTS = ([h.strip() for h in _env_hosts.split(",") if h.strip()]
                or _local_addresses())

API_BASE = os.environ.get("LVC_API_BASE", "http://127.0.0.1:8111/v1")
SWAP_URL = os.environ.get("LVC_SWAP_URL", "http://127.0.0.1:8100")
MODEL = os.environ.get("LVC_MODEL", "qwen2.5-vl-7b")

ORIGINS = set(o.strip() for o in os.environ.get(
    "LVC_ORIGINS",
    "http://localhost:11000,http://127.0.0.1:11000,"
    "http://localhost:11005,http://127.0.0.1:8112,http://localhost:8112"
).split(",") if o.strip())

SYSTEMCTL = shutil.which("systemctl") or "/usr/bin/systemctl"
JOURNALCTL = shutil.which("journalctl") or "/usr/bin/journalctl"

_preload = {"running": False, "started": 0, "result": None}
_lock = threading.Lock()


# ------------------------------------------------------------------ helpers

def _run(argv, timeout=15):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as exc:                                   # pragma: no cover
        return 127, "", str(exc)


def _get_json(url, timeout=3):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def unit_state():
    """systemd properties of the webui unit, read through the user manager."""
    props = ["ActiveState", "SubState", "UnitFileState", "MainPID",
             "NRestarts", "ExecMainStartTimestampMonotonic", "Result"]
    rc, out, err = _run([SYSTEMCTL, "--user", "show", UNIT,
                         "-p", ",".join(props)])
    d = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v
    if rc != 0 and not d:
        return {"active": "unknown", "sub": "", "enabled": "unknown",
                "pid": 0, "restarts": 0, "uptime_s": None,
                "error": (err or out).strip()[:200]}
    uptime = None
    try:
        mono = int(d.get("ExecMainStartTimestampMonotonic", "0"))
        if mono:
            uptime = int(time.monotonic() - mono / 1e6)
            if uptime < 0:
                uptime = None
    except Exception:
        pass
    return {
        "active": d.get("ActiveState", "unknown"),
        "sub": d.get("SubState", ""),
        "enabled": d.get("UnitFileState", "unknown"),
        "pid": int(d.get("MainPID", "0") or 0),
        "restarts": int(d.get("NRestarts", "0") or 0),
        "uptime_s": uptime,
        "result": d.get("Result", ""),
    }


def port_open(host, port, timeout=0.6):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def webui_probe():
    """Ask the webui itself what backend models it can see.

    The cert is self-signed on purpose, so verification is off for this one
    loopback call. Nothing else in this process disables verification.
    """
    url = "%s://127.0.0.1:%d/models" % (WEBUI_SCHEME, WEBUI_PORT)
    ctx = ssl._create_unverified_context() if WEBUI_SCHEME == "https" else None
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=3, context=ctx) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
        ids, cur = [], None
        if isinstance(body, dict):
            for m in body.get("models", body.get("data", [])) or []:
                if isinstance(m, dict):
                    ids.append(m.get("id"))
                    if m.get("current"):
                        cur = m.get("id")
                else:
                    ids.append(str(m))
        return {"reachable": True, "models": [i for i in ids if i], "current": cur}
    except Exception as exc:
        return {"reachable": False, "models": [], "current": None,
                "error": str(exc)[:160]}


def backend_probe(model=None):
    """The load gate at :8111 - the same path the webui uses for inference."""
    model = model or MODEL
    out = {"api_base": API_BASE, "model": model, "reachable": False,
           "model_present": False, "models": [], "resident": False,
           "gate": None}
    try:
        body = _get_json(API_BASE.rstrip("/") + "/models")
        ids = [m.get("id") for m in body.get("data", []) if isinstance(m, dict)]
        out["reachable"] = True
        out["models"] = [i for i in ids if i]
        out["model_present"] = model in out["models"]
    except Exception as exc:
        out["error"] = str(exc)[:160]
    try:
        running = _get_json(SWAP_URL.rstrip("/") + "/running").get("running", [])
        names = []
        for r in running:
            names.append(r.get("model") if isinstance(r, dict) else str(r))
        out["resident"] = model in names
        out["resident_models"] = [n for n in names if n]
    except Exception:
        out["resident_models"] = None
    try:
        out["gate"] = _get_json("http://127.0.0.1:8110/api/status").get("gate")
    except Exception:
        out["gate"] = None
    return out


def memory():
    info = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                k, _, v = line.partition(":")
                info[k] = int(v.split()[0])
    except Exception:
        return {}
    gib = lambda kb: round(kb / 1048576.0, 1)
    total, avail = info.get("MemTotal", 0), info.get("MemAvailable", 0)
    return {"total_gib": gib(total), "available_gib": gib(avail),
            "used_gib": gib(total - avail),
            "used_pct": round(100.0 * (total - avail) / total, 1) if total else 0}


def model_size_gib(model=None):
    """Size of the VLM weights plus its projector, read off disk.

    dgx-model-card's headroom guard only stats the -m path, so the mmproj
    bytes are invisible to it. Reporting both here keeps the number honest.
    """
    model = model or MODEL
    cfg = os.environ.get("LVC_SWAP_CONFIG", "/etc/llama-swap/config.yaml")
    weights = proj = 0
    try:
        with open(cfg) as fh:
            text = fh.read()
        block = re.search(r"^\s{2}%s:\n(.*?)(?=^\s{2}\S|\Z)" % re.escape(model),
                          text, re.S | re.M)
        if block:
            b = block.group(1)
            m = re.search(r"-m\s+(\S+)", b)
            p = re.search(r"--mmproj\s+(\S+)", b)
            if m and os.path.exists(m.group(1)):
                weights = os.stat(m.group(1)).st_size
            if p and os.path.exists(p.group(1)):
                proj = os.stat(p.group(1)).st_size
    except Exception:
        pass
    if not weights:
        return None
    return {"weights_gib": round(weights / 2**30, 1),
            "mmproj_gib": round(proj / 2**30, 1),
            "total_gib": round((weights + proj) / 2**30, 1)}


def vision_models():
    """Every llama-swap model whose cmd carries an --mmproj - i.e. can see.

    Read straight from the swap config, so registering a new VLM shows up on
    the card with no card change.
    """
    cfg = os.environ.get("LVC_SWAP_CONFIG", "/etc/llama-swap/config.yaml")
    out = []
    try:
        text = open(cfg).read()
        for m in re.finditer(r"^  ([A-Za-z0-9._-]+):\n(.*?)(?=^  \S|\Z)", text, re.S | re.M):
            mid, body = m.group(1), m.group(2)
            if "--mmproj" not in body:
                continue
            name = re.search(r'name:\s*"([^"]+)"', body)
            w = re.search(r"-m\s+(\S+)", body)
            p = re.search(r"--mmproj\s+(\S+)", body)
            size = 0
            for path in (w, p):
                if path and os.path.exists(path.group(1)):
                    size += os.stat(path.group(1)).st_size
            out.append({"id": mid, "name": name.group(1) if name else mid,
                        "total_gib": round(size / 2**30, 1)})
    except Exception:
        pass
    return out


def urls():
    out = {"local": "%s://localhost:%d/" % (WEBUI_SCHEME, WEBUI_PORT),
           "public": []}
    for h in PUBLIC_HOSTS:
        out["public"].append("%s://%s:%d/" % (WEBUI_SCHEME, h.strip(), WEBUI_PORT))
    out["open"] = out["public"][0] if out["public"] else out["local"]
    return out


def status():
    u = unit_state()
    listening = port_open("127.0.0.1", WEBUI_PORT)
    probe = webui_probe() if listening else {"reachable": False, "models": []}
    state = "stopped"
    if u["active"] == "active":
        state = "serving" if probe.get("reachable") else "starting"
    elif u["active"] == "failed":
        state = "failed"
    elif u["active"] in ("activating", "reloading"):
        state = "starting"
    active = probe.get("current") or MODEL
    with _lock:
        pre = dict(_preload)
    return {
        "active_model": active,
        "configured_model": MODEL,
        "active_source": "webui" if probe.get("current") else "config",
        "version": VERSION,
        "state": state,
        "unit": UNIT,
        "service": u,
        "listening": listening,
        "webui": probe,
        "webui_port": WEBUI_PORT,
        "webui_scheme": WEBUI_SCHEME,
        "urls": urls(),
        "backend": backend_probe(active),
        "model_size": model_size_gib(active),
        "vision_models": vision_models(),
        "memory": memory(),
        "process_every": int(os.environ.get("LIVE_VLM_PROCESS_EVERY", "30")),
        "preload": pre,
        "now": int(time.time()),
    }


def logs(n=120):
    rc, out, err = _run([JOURNALCTL, "--user", "-u", UNIT, "-n", str(n),
                         "--no-pager", "-o", "short-iso"], timeout=20)
    lines = (out or err).splitlines()
    return [l for l in lines if l.strip()]


# ------------------------------------------------------------------- actions

def _preload_worker(model):
    """Warm the VLM by asking the gate for one token.

    Deliberately routed through :8111 and not straight at llama-swap, so the
    headroom guard decides whether the load happens. A 503 here is the guard
    working, not an outage, and is reported as such.
    """
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    }).encode()
    req = urllib.request.Request(
        API_BASE.rstrip("/") + "/chat/completions", data=payload,
        headers={"Content-Type": "application/json"})
    result = {}
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            r.read()
        result = {"ok": True, "seconds": int(time.time() - t0)}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        code = None
        try:
            code = json.loads(body).get("error", {}).get("code")
        except Exception:
            pass
        result = {"ok": False, "status": exc.code, "code": code,
                  "detail": body, "seconds": int(time.time() - t0)}
    except Exception as exc:
        result = {"ok": False, "detail": str(exc)[:300],
                  "seconds": int(time.time() - t0)}
    with _lock:
        _preload["running"] = False
        _preload["result"] = result


def start_preload(model=None):
    model = model or MODEL
    with _lock:
        if _preload["running"]:
            return False, "already running"
        _preload["running"] = True
        _preload["started"] = int(time.time())
        _preload["result"] = None
    threading.Thread(target=_preload_worker, args=(model,), daemon=True).start()
    return True, None


def systemd_action(verb):
    rc, out, err = _run([SYSTEMCTL, "--user", verb, UNIT], timeout=30)
    return rc == 0, ((err or out).strip()[:300] or None)


# --------------------------------------------------------------- vision proxy
#
# Why this exists, measured: llama-swap serves 8 models and only some carry an
# --mmproj. The WebUI's model dropdown lists whatever the backend reports, so a
# text-only model can be selected against a camera stream - and then every
# frame comes back
#     400 "Multimodal data provided, but model does not support multimodal
#          requests."
# once per frame, ~1/s, with nothing on screen saying which model is at fault.
#
# So the WebUI is pointed at THIS proxy instead of the gate directly. It
# filters /v1/models down to the models that can actually see, and refuses a
# vision request naming a blind model with a message that names the fix. It
# then forwards to the gate (:8111), so Hold and the headroom guard still
# apply - this adds a filter, it does not bypass anything.

GATE_HOST, GATE_PORT = "127.0.0.1", 8111
try:
    _u = urllib.parse.urlsplit(API_BASE)
    GATE_HOST, GATE_PORT = _u.hostname or GATE_HOST, _u.port or GATE_PORT
except Exception:
    pass


def vision_ids():
    return set(m["id"] for m in vision_models())


def filtered_models():
    body = _get_json("http://%s:%d/v1/models" % (GATE_HOST, GATE_PORT), timeout=5)
    ids = vision_ids()
    body["data"] = [m for m in body.get("data", []) if m.get("id") in ids]
    return body


# ------------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    server_version = "live-vlm-card/" + VERSION
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    # -- plumbing

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _file(self, name, ctype):
        path = os.path.join(WEBROOT, name)
        try:
            with open(path, "rb") as fh:
                self._send(200, fh.read(), ctype)
        except OSError:
            self._send(404, {"error": "not found", "path": path})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    # -- routes

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        if path in ("/", "/index.html"):
            return self._file("index.html", "text/html; charset=utf-8")
        if path == "/card.js":
            return self._file("card.js", "application/javascript; charset=utf-8")
        if path == "/healthz":
            return self._send(200, {"ok": True, "version": VERSION})
        if path == "/v1/models":
            try:
                return self._send(200, filtered_models())
            except Exception as exc:
                return self._send(502, {"error": {"message":
                    "upstream gate unreachable: %s" % str(exc)[:160],
                    "type": "upstream_error"}})
        if path.startswith("/v1/"):
            return self._proxy("GET", path, b"")
        if path == "/api/status":
            return self._send(200, status())
        if path == "/api/logs":
            n = 120
            m = re.search(r"n=(\d+)", query)
            if m:
                n = max(1, min(1000, int(m.group(1))))
            return self._send(200, {"lines": logs(n)})
        return self._send(404, {"error": "not found"})

    # -- vision-only proxy to the load gate

    def _proxy(self, method, path, body):
        try:
            conn = http.client.HTTPConnection(GATE_HOST, GATE_PORT, timeout=1800)
            headers = {"Content-Type": self.headers.get("Content-Type",
                                                        "application/json")}
            if body:
                headers["Content-Length"] = str(len(body))
            conn.request(method, path, body=body or None, headers=headers)
            r = conn.getresponse()
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() in ("transfer-encoding", "connection",
                                 "content-length"):
                    continue
                self.send_header(k, v)
            self.send_header("Transfer-Encoding", "chunked")
            self._cors()
            self.end_headers()
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                self.wfile.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except Exception as exc:
            try:
                self._send(502, {"error": {"message": str(exc)[:200],
                                           "type": "upstream_error"}})
            except Exception:
                pass

    def _proxy_v1(self, path):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        # Only chat/completions carries images; only it is worth checking.
        if path.endswith("/chat/completions"):
            try:
                req = json.loads(body.decode("utf-8", "replace"))
            except Exception:
                req = {}
            model = req.get("model")
            ids = vision_ids()
            has_image = "image_url" in body.decode("utf-8", "replace")[:200000]
            if has_image and model and ids and model not in ids:
                return self._send(400, {"error": {
                    "message": ("live-vlm-card: '%s' has no vision projector, so it "
                                "cannot read camera frames. Pick one of: %s "
                                "(sidebar > Model > refresh)."
                                % (model, ", ".join(sorted(ids)))),
                    "type": "invalid_request_error",
                    "code": "model_not_multimodal",
                    "param": model}})
        return self._proxy("POST", path, body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/v1/"):
            return self._proxy_v1(path)
        if path in ("/api/start", "/api/stop", "/api/restart"):
            verb = path.rsplit("/", 1)[1]
            ok, detail = systemd_action(verb)
            return self._send(202 if ok else 500,
                              {"accepted": ok, "action": verb, "detail": detail})
        if path == "/api/preload":
            active = status().get("active_model") or MODEL
            ok, reason = start_preload(active)
            return self._send(202 if ok else 409,
                              {"accepted": ok, "reason": reason,
                               "model": active})
        return self._send(404, {"error": "not found"})


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("live-vlm-card %s on http://%s:%d (unit %s, webui :%d)"
          % (VERSION, HOST, PORT, UNIT, WEBUI_PORT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
