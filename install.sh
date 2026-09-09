#!/usr/bin/env bash
# Install the Live VLM card sidecar and, optionally, live-vlm-webui itself.
#
# Touches nothing under /opt/nvidia/. Verifies that afterwards.
#
# Both services are systemd USER units, not system units. That is deliberate:
# it is what lets the card start and stop the WebUI with no polkit rule, no
# sudoers entry and no root at runtime. Root is used here only to write the
# program files under /opt/local and to enable lingering.
set -euo pipefail

PREFIX=/opt/local/live-vlm-card
VENV_PREFIX=/opt/local/live-vlm-webui
SERVICE_USER="${SUDO_USER:-$USER}"
PORT=8112
WEBUI_PORT=8120
API_BASE=http://127.0.0.1:8111/v1
SWAP_URL=http://127.0.0.1:8100
SWAP_CONFIG=/etc/llama-swap/config.yaml
MODEL=""
WEBUI_VERSION=0.4.0
INSTALL_WEBUI=1
PUBLIC_HOSTS=""

usage() {
  cat <<EOF
usage: sudo ./install.sh [options]

  --user <name>          run as this user             (default: ${SERVICE_USER})
  --port <n>             card + API + filter port     (default: ${PORT})
  --webui-port <n>       live-vlm-webui port          (default: ${WEBUI_PORT})
  --model <id>           default vision model         (default: first with --mmproj)
  --api-base <url>       load gate, or llama-swap     (default: ${API_BASE})
  --swap-url <url>       llama-swap control API       (default: ${SWAP_URL})
  --swap-config <path>   llama-swap config.yaml       (default: ${SWAP_CONFIG})
  --public-hosts <list>  comma-separated addresses the card links to
                         (default: auto-detected LAN addresses)
  --webui-version <v>    pin live-vlm-webui           (default: ${WEBUI_VERSION})
  --no-webui             install only the card; bring your own WebUI
  -h, --help
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) SERVICE_USER=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --webui-port) WEBUI_PORT=$2; shift 2;;
    --model) MODEL=$2; shift 2;;
    --api-base) API_BASE=$2; shift 2;;
    --swap-url) SWAP_URL=$2; shift 2;;
    --swap-config) SWAP_CONFIG=$2; shift 2;;
    --public-hosts) PUBLIC_HOSTS=$2; shift 2;;
    --webui-version) WEBUI_VERSION=$2; shift 2;;
    --no-webui) INSTALL_WEBUI=0; shift;;
    -h|--help) usage;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "no such user: $SERVICE_USER" >&2; exit 1; }
USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
UID_N=$(id -u "$SERVICE_USER")
asuser() { runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/${UID_N}" "$@"; }

echo "==> preflight"
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
python3 - <<'PY' || { echo "python 3.10+ required" >&2; exit 1; }
import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)
PY
[ -r "$SWAP_CONFIG" ] || echo "    warning: $SWAP_CONFIG not readable - the vision filter will be permissive"
curl -fsS -m 5 "$SWAP_URL/v1/models" >/dev/null 2>&1 \
  || echo "    warning: llama-swap not answering at $SWAP_URL - installing anyway"
for p in "$PORT" "$WEBUI_PORT"; do
  if ss -ltn 2>/dev/null | grep -q ":$p "; then echo "port $p already in use" >&2; exit 1; fi
done
if [ -r "$SWAP_CONFIG" ] && ! grep -q -- '--mmproj' "$SWAP_CONFIG"; then
  echo "    warning: no model in $SWAP_CONFIG carries --mmproj, so nothing can read a camera frame."
  echo "             See packaging/llama-swap-vision.yaml."
fi

echo "==> baseline (so we can prove we did not touch NVIDIA)"
BASE=$(mktemp -d)
dpkg -V dgx-dashboard > "$BASE/dpkg-V.before" 2>&1 || true
sha256sum /opt/nvidia/dgx-dashboard-service/dashboard-service > "$BASE/sha.before" 2>/dev/null || true

echo "==> lingering for $SERVICE_USER"
# Without this the user manager exits at logout and both services stop with it.
loginctl enable-linger "$SERVICE_USER"

echo "==> card files -> $PREFIX"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$PREFIX" "$PREFIX/web" "$PREFIX/userscript"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$HERE/src/live_vlm_card.py" "$PREFIX/live_vlm_card.py"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 "$HERE/src/web/card.js"      "$PREFIX/web/card.js"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 "$HERE/src/web/index.html"   "$PREFIX/web/index.html"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 \
  "$HERE/userscript/dgx-dashboard-cards.user.js" "$PREFIX/userscript/dgx-dashboard-cards.user.js"

if [ "$INSTALL_WEBUI" = 1 ]; then
  echo "==> live-vlm-webui ${WEBUI_VERSION} -> $VENV_PREFIX"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$VENV_PREFIX"
  asuser python3 -m venv "$VENV_PREFIX/.venv"
  asuser "$VENV_PREFIX/.venv/bin/pip" install -q --upgrade pip wheel
  asuser "$VENV_PREFIX/.venv/bin/pip" install -q "live-vlm-webui==${WEBUI_VERSION}"
  asuser "$VENV_PREFIX/.venv/bin/live-vlm-webui" --version

  echo "==> TLS certificate"
  # The camera needs a secure context and WebRTC media needs a direct path,
  # so this is served over https on the LAN rather than through a tunnel.
  CERTDIR="$USER_HOME/.config/live-vlm-webui"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$CERTDIR"
  if [ ! -f "$CERTDIR/cert.pem" ]; then
    SANS="DNS:$(hostname),DNS:localhost,IP:127.0.0.1"
    for ip in $(ip -4 -o addr show 2>/dev/null | awk '$2!="lo"{split($4,a,"/"); print a[1]}'); do
      SANS="$SANS,IP:$ip"
    done
    asuser openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$CERTDIR/key.pem" -out "$CERTDIR/cert.pem" -days 3650 \
      -subj "/CN=$(hostname)" -addext "subjectAltName=$SANS" 2>/dev/null
    chmod 600 "$CERTDIR/key.pem"
    echo "    self-signed cert for: $SANS"
  else
    echo "    keeping existing cert"
  fi
fi

echo "==> user units -> $USER_HOME/.config/systemd/user"
UNITDIR="$USER_HOME/.config/systemd/user"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$UNITDIR"

# Pick the default model: the first llama-swap model carrying --mmproj.
if [ -z "$MODEL" ] && [ -r "$SWAP_CONFIG" ]; then
  MODEL=$(python3 - "$SWAP_CONFIG" <<'PY'
import re, sys
try:
    t = open(sys.argv[1]).read()
except OSError:
    sys.exit(0)
for m in re.finditer(r"^  ([A-Za-z0-9._-]+):\n(.*?)(?=^  \S|\Z)", t, re.S | re.M):
    if "--mmproj" in m.group(2):
        print(m.group(1)); break
PY
)
fi
[ -n "$MODEL" ] && echo "    default vision model: $MODEL" || echo "    no vision model found; set one later with LVC_MODEL"

sed -e "s#REPLACE_PREFIX#${PREFIX}#g" \
    -e "s#REPLACE_MODEL#${MODEL}#g" \
    -e "s#^Environment=LVC_PORT=.*#Environment=LVC_PORT=${PORT}#" \
    -e "s#^Environment=LVC_WEBUI_PORT=.*#Environment=LVC_WEBUI_PORT=${WEBUI_PORT}#" \
    -e "s#^Environment=LVC_API_BASE=.*#Environment=LVC_API_BASE=${API_BASE}#" \
    -e "s#^Environment=LVC_SWAP_URL=.*#Environment=LVC_SWAP_URL=${SWAP_URL}#" \
    -e "s#^Environment=LVC_SWAP_CONFIG=.*#Environment=LVC_SWAP_CONFIG=${SWAP_CONFIG}#" \
    "$HERE/packaging/live-vlm-card.service" > "$UNITDIR/live-vlm-card.service"
[ -n "$PUBLIC_HOSTS" ] && sed -i "s##Environment=LVC_PUBLIC_HOSTS=#Environment=LVC_PUBLIC_HOSTS=${PUBLIC_HOSTS}#" "$UNITDIR/live-vlm-card.service"

if [ "$INSTALL_WEBUI" = 1 ]; then
  sed -e "s#REPLACE_VENV_PREFIX#${VENV_PREFIX}#g" \
      -e "s#REPLACE_MODEL#${MODEL}#g" \
      -e "s#--port 8120#--port ${WEBUI_PORT}#" \
      -e "s#http://127.0.0.1:8112/v1#http://127.0.0.1:${PORT}/v1#g" \
      "$HERE/packaging/live-vlm-webui.service" > "$UNITDIR/live-vlm-webui.service"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$UNITDIR"

echo "==> start"
asuser systemctl --user daemon-reload
asuser systemctl --user enable --now live-vlm-card.service
[ "$INSTALL_WEBUI" = 1 ] && asuser systemctl --user enable --now live-vlm-webui.service
sleep 4

echo "==> verify"
curl -fsS -m 5 "http://127.0.0.1:${PORT}/healthz" && echo
echo -n "    vision models offered: "
curl -fsS -m 8 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null \
  | python3 -c 'import sys,json;print([m["id"] for m in json.load(sys.stdin)["data"]])' \
  || echo "(gate unreachable)"
if [ "$INSTALL_WEBUI" = 1 ]; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' -m 8 "https://127.0.0.1:${WEBUI_PORT}/models" || true)
  echo "    webui https://127.0.0.1:${WEBUI_PORT}/models -> HTTP ${code}"
fi

dpkg -V dgx-dashboard > "$BASE/dpkg-V.after" 2>&1 || true
sha256sum /opt/nvidia/dgx-dashboard-service/dashboard-service > "$BASE/sha.after" 2>/dev/null || true
if diff -q "$BASE/dpkg-V.before" "$BASE/dpkg-V.after" >/dev/null 2>&1 &&
   diff -q "$BASE/sha.before" "$BASE/sha.after" >/dev/null 2>&1; then
  echo "    NVIDIA package unchanged (dpkg -V and binary hash identical)"
else
  echo "    WARNING: NVIDIA state differs from before this install - investigate" >&2
fi
rm -rf "$BASE"

cat <<EOF

Done.

  card         http://127.0.0.1:${PORT}
  API          http://127.0.0.1:${PORT}/api/status
  vision /v1   http://127.0.0.1:${PORT}/v1        (model list filtered to models that can see)
$([ "$INSTALL_WEBUI" = 1 ] && echo "  WebUI        https://<this host's LAN address>:${WEBUI_PORT}/")

Next:
  1. install userscript/dgx-dashboard-cards.user.js in Violentmonkey or Tampermonkey
     (disable any older single-card script)
  2. apply patches/dgx-model-card-vision-check.patch to dgx-model-card, so a
     blind model asked to read an image is refused at the gate rather than
     once per frame by llama.cpp
  3. open the WebUI over the LAN, not through a tunnel - WebRTC media does not
     survive a TCP-only forward

Uninstall:
  systemctl --user disable --now live-vlm-webui.service live-vlm-card.service
  rm -f ~/.config/systemd/user/live-vlm-{webui,card}.service
  systemctl --user daemon-reload
  sudo rm -rf ${PREFIX} ${VENV_PREFIX}
EOF
