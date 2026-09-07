#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "bash is required... /ᐠ - ˕ -マ"
  exit 1
fi

set -euo pipefail

export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}:/usr/local/sbin:/usr/sbin:/sbin"

NEGATIVE="... /ᐠ - ˕ -マ"
POSITIVE="!! (˵◝ ⩊  ◜˵マ"

log() {
  printf '[setup] %s\n' "$*"
}

fail() {
  printf '[setup] %s%s\n' "$*" "$NEGATIVE" >&2
}

success() {
  printf '[setup] %s%s\n' "$*" "$POSITIVE"
}

trap 'fail "setup failed at line $LINENO"' ERR

retry() {
  local attempts="$1"
  shift
  local n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then
      return 1
    fi
    n=$((n + 1))
    sleep 2
  done
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "$cmd is required but was not found"
    exit 1
  fi
}

PROXY_CPUS=$(nproc 2>/dev/null || echo 1)
PROXY_RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)
[[ "$PROXY_CPUS" =~ ^[1-9][0-9]*$ ]] || PROXY_CPUS=1
[[ "$PROXY_RAM_MB" =~ ^[1-9][0-9]*$ ]] || PROXY_RAM_MB=2048
AUTO_INSTANCES=$((PROXY_CPUS / 2))
RAM_INSTANCES=$((PROXY_RAM_MB / 2048))
[ "$AUTO_INSTANCES" -le "$RAM_INSTANCES" ] || AUTO_INSTANCES=$RAM_INSTANCES
[ "$AUTO_INSTANCES" -ge 1 ] || AUTO_INSTANCES=1
[ "$AUTO_INSTANCES" -le 32 ] || AUTO_INSTANCES=32
MOCHI_AUTO=0
[ "${MOCHI_INSTANCES+x}" ] || MOCHI_AUTO=1
MOCHI_INSTANCES="${MOCHI_INSTANCES-$AUTO_INSTANCES}"
NURU_AUTO_INSTANCES=$AUTO_INSTANCES
[ "$NURU_AUTO_INSTANCES" -le 18 ] || NURU_AUTO_INSTANCES=18
NURU_INSTANCES="${NURU_INSTANCES-$NURU_AUTO_INSTANCES}"
for count in "$MOCHI_INSTANCES" "$NURU_INSTANCES"; do
  if ! [[ "$count" =~ ^([1-9]|[12][0-9]|3[0-2])$ ]]; then
    fail "proxy instance counts must be integers from 1 to 32"
    exit 1
  fi
done
configure_mochi_instances() {
  MOCHI_UPSTREAMS=""
  MOCHI_SERVICES=()
  local i
  for ((i = 0; i < MOCHI_INSTANCES; i++)); do
    MOCHI_UPSTREAMS+=" 127.0.0.1:$((4100 + i))"
    MOCHI_SERVICES+=("mochi@$i")
  done
}
configure_mochi_instances
NURU_UPSTREAMS=""
NURU_SERVICES=()
for ((i = 0; i < NURU_INSTANCES; i++)); do
  NURU_UPSTREAMS+=" 127.0.0.1:$((4200 + i))"
  NURU_SERVICES+=("nuru@$i")
done

configure_proxy_limits() {
  MOCHI_MEMORY_MB=$((PROXY_RAM_MB * 30 / 100 / MOCHI_INSTANCES))
  NURU_MEMORY_MB=$((PROXY_RAM_MB * 20 / 100 / NURU_INSTANCES))
  MOCHI_REQUESTS=$((MOCHI_MEMORY_MB / 8))
  NURU_REQUESTS=$((NURU_MEMORY_MB / 16))
  [ "$MOCHI_REQUESTS" -ge 1 ] || MOCHI_REQUESTS=1
  [ "$NURU_REQUESTS" -ge 1 ] || NURU_REQUESTS=1
  [ "$MOCHI_REQUESTS" -le 256 ] || MOCHI_REQUESTS=256
  [ "$NURU_REQUESTS" -le 128 ] || NURU_REQUESTS=128
}
configure_proxy_limits

proxy_limits_active() {
  local limit value
  for limit in cpu.max memory.high memory.max memory.swap.max pids.max; do
    read -r value _ < "$1/$limit" || return 1
    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    if [ "$limit" = memory.swap.max ]; then
      [ "$value" -eq 0 ] || return 1
    else
      [ "$value" -gt 0 ] || return 1
    fi
  done
}

case "$(uname -s)" in
Linux) ;;
*)
  fail "this setup needs apt + systemd"
  log "detected os: $(uname -s)"
  exit 1
  ;;
esac

if [ ! -f /etc/os-release ]; then
  fail "can't detect distro (/etc/os-release missing)"
  exit 1
fi

. /etc/os-release
if [ "${ID:-}" != "debian" ] && [ "${ID:-}" != "ubuntu" ] && [[ "${ID_LIKE:-}" != *debian* ]]; then
  fail "unsupported distro for this setup: ${PRETTY_NAME:-unknown}"
  exit 1
fi

require_cmd apt-get
require_cmd systemctl

for controller in cpu memory pids; do
  if ! grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
    fail "proxy resource limits require cgroup v2 with cpu, memory, and process controllers"
    exit 1
  fi
done
if [ "$MOCHI_MEMORY_MB" -lt 384 ] || [ "$NURU_MEMORY_MB" -lt 256 ]; then
  fail "insufficient memory for the proxy worker counts"
  exit 1
fi

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  sudo() { "$@"; }
elif ! command -v sudo >/dev/null 2>&1; then
  fail "sudo is required when not root"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

export DEBIAN_FRONTEND=noninteractive

log "the setup process is about to start; support is available at discord.gg/4GeWaGPh6c"
success "setup started"

stop_pm2() {
  local candidate
  local pm2_bin=""
  local candidates=()

  if command -v pm2 >/dev/null 2>&1; then
    candidates+=("$(command -v pm2)")
  fi
  candidates+=("$HOME/.bun/bin/pm2" "$ROOT/node_modules/.bin/pm2")

  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      pm2_bin="$candidate"
      break
    fi
  done

  if [ -n "$pm2_bin" ]; then
    PATH="$HOME/.bun/bin:$PATH" "$pm2_bin" stop all >/dev/null 2>&1 || true
    PATH="$HOME/.bun/bin:$PATH" "$pm2_bin" delete all >/dev/null 2>&1 || true
    PATH="$HOME/.bun/bin:$PATH" "$pm2_bin" kill >/dev/null 2>&1 || true
  fi
}

kill_service_processes() {
  local name
  local pattern
  local signal
  local used=0
  local names=(tls-approval lyra nuru mochi cloudsync isao caddy eturnal coturn turnserver)
  local patterns=(
    '[s]ervices/tls-approval/server\.js'
    '[s]erver/prod\.mjs'
    '[s]erver/dev\.mjs'
    '[n]uru-route\.sh'
  )

  if ! command -v pkill >/dev/null 2>&1; then
    return
  fi
  for signal in TERM KILL; do
    for name in "${names[@]}"; do
      sudo pkill -"$signal" -x "$name" 2>/dev/null || true
    done
    for pattern in "${patterns[@]}"; do
      sudo pkill -"$signal" -f "$pattern" 2>/dev/null || true
    done
    if [ "$signal" = TERM ]; then
      sleep 1
    fi
  done

  for name in "${names[@]}"; do
    if sudo pgrep -x "$name" >/dev/null 2>&1; then
      fail "service process $name is still running"
      used=1
    fi
  done
  for pattern in "${patterns[@]}"; do
    if sudo pgrep -f "$pattern" >/dev/null 2>&1; then
      fail "a managed service process is still running"
      used=1
    fi
  done

  [ "$used" -eq 0 ]
}

release_service_ports() {
  local port
  local protocol
  local used=0
  local ports=(3001 4000 4001 4002 4003 4005 4444 6001 8923 3478 "${TURN_PORT:-3478}")

  if ! command -v fuser >/dev/null 2>&1; then
    return
  fi

  for port in "${ports[@]}"; do
    for protocol in tcp udp; do
      sudo fuser -k "$port/$protocol" >/dev/null 2>&1 || true
    done
  done

  sleep 1
  for port in "${ports[@]}"; do
    if sudo fuser "$port/tcp" >/dev/null 2>&1 || sudo fuser "$port/udp" >/dev/null 2>&1; then
      fail "service port $port is still in use"
      used=1
    fi
  done

  [ "$used" -eq 0 ]
}

log "stopping all running services..."
while read -r unit _; do
  if [[ "$unit" =~ ^(mochi|nuru)@[0-9]+\.service$ ]]; then
    sudo systemctl stop "$unit"
    sudo systemctl disable "$unit"
  fi
done < <(
  {
    systemctl list-unit-files --type=service --no-legend
    systemctl list-units --all --plain --type=service --no-legend
  } | awk '{print $1}' | sort -u
)
sudo systemctl stop "pm2-$USER.service" 2>/dev/null || true
stop_pm2
for svc in tls-approval lyra waves ask cloudsync isao mochi nuru nuru-route.timer nuru-route wg-quick@wg0 caddy eturnal coturn; do
  sudo systemctl stop "$svc" 2>/dev/null || true
  sudo systemctl disable "$svc" 2>/dev/null || true
done
if command -v docker >/dev/null 2>&1; then
  if sudo docker compose version >/dev/null 2>&1 && [ -f "$ROOT/services/turn/compose.yml" ]; then
    sudo docker compose -f "$ROOT/services/turn/compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  fi
fi
if command -v wg-quick >/dev/null 2>&1; then
  sudo wg-quick down wg0 2>/dev/null || true
fi
if command -v ip >/dev/null 2>&1; then
  sudo ip link delete veth0-global 2>/dev/null || true
  sudo ip link delete wg0 2>/dev/null || true
fi
kill_service_processes
release_service_ports
success "all services stopped"

WG_ENABLED=0
WG_REUSE=0
WG_CONFIG_EXISTS=0

if sudo [ -f /etc/wireguard/wg0.conf ]; then
  WG_CONFIG_EXISTS=1
  log "detected existing wireguard config"
fi

if [ -t 0 ]; then
  log "route mochi and nuru through a wireguard vpn?"
  fail "all outbound traffic from both services will use the vpn and may be slower"
  if [ "$WG_CONFIG_EXISTS" -eq 1 ]; then
    log "type 'y' to use wireguard or 'n' to keep both services on the server's direct connection"
  else
    log "type 'y' to configure wireguard or 'n' to use the server's direct connection"
  fi
  while true; do
    read -r -p "> " ws_choice
    case "$ws_choice" in
    yes | y)
      WG_ENABLED=1
      break
      ;;
    no | n)
      WG_ENABLED=0
      break
      ;;
    *)
      fail "please type 'y' or 'n'"
      ;;
    esac
  done

  if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_CONFIG_EXISTS" -eq 1 ]; then
    log "type 'k' to keep existing config or 'r' to replace it"
    while true; do
      read -r -p "> " keep_choice
      case "$keep_choice" in
      k | keep)
        WG_REUSE=1
        break
        ;;
      r | replace)
        WG_REUSE=0
        break
        ;;
      *)
        fail "please type 'k' or 'r'"
        ;;
      esac
    done
  fi

  if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_REUSE" -eq 0 ]; then
    while true; do
      WG_CONFIG_FILE="/tmp/wg0-config-paste"
      cat >"$WG_CONFIG_FILE" <<'WGEOF'
# paste your wireguard config below then save and exit!
#
# example:
# [Interface]
# PrivateKey = ...
# Address = ...
# DNS = ...
#
# [Peer]
# PublicKey = ...
# AllowedIPs = ...
# Endpoint = ...
# PresharedKey = ...
WGEOF
      nano "$WG_CONFIG_FILE" </dev/tty >/dev/tty 2>&1 || true
      if ! grep -Eq '^[[:space:]]*[^#[:space:]]' "$WG_CONFIG_FILE" 2>/dev/null; then
        fail "empty config"
        log "type 'r' to retry or 'c' to cancel vpn setup"
        read -r -p "> " retry
        case "$retry" in
        r | retry) continue ;;
        *)
          WG_ENABLED=0
          break
          ;;
        esac
      elif ! grep -Eq '^[[:space:]]*\[Interface\][[:space:]]*$' "$WG_CONFIG_FILE" 2>/dev/null; then
        fail "invalid config (missing [Interface] section)"
        log "type 'r' to retry or 'c' to cancel vpn setup"
        read -r -p "> " retry
        case "$retry" in
        r | retry) continue ;;
        *)
          WG_ENABLED=0
          break
          ;;
        esac
      else
        success "wireguard config is valid"
        break
      fi
    done
  fi
else
  case "${LYRA_WIREGUARD:-no}" in
  1 | true | yes | y)
    if [ "$WG_CONFIG_EXISTS" -eq 1 ]; then
      WG_ENABLED=1
      WG_REUSE=1
      success "wireguard routing enabled by LYRA_WIREGUARD using the existing config"
    else
      fail "LYRA_WIREGUARD requested, but /etc/wireguard/wg0.conf is missing; using the direct connection"
    fi
    ;;
  *)
    log "wireguard routing mode: direct connection"
    ;;
  esac
fi

if [ "$WG_ENABLED" -eq 0 ]; then
  sudo systemctl stop nuru 2>/dev/null || true
  sudo systemctl disable nuru 2>/dev/null || true
  sudo systemctl stop nuru-route.timer 2>/dev/null || true
  sudo systemctl disable nuru-route.timer 2>/dev/null || true
  sudo systemctl stop wg-quick@wg0 2>/dev/null || true
  sudo systemctl disable wg-quick@wg0 2>/dev/null || true
  sudo wg-quick down wg0 2>/dev/null || true
  sudo rm -f /etc/systemd/system/nuru-route.service /etc/systemd/system/nuru-route.timer /usr/local/bin/nuru-route.sh
  sudo systemctl daemon-reload
fi

if command -v ip >/dev/null 2>&1; then
  sudo ip link delete veth0-global 2>/dev/null || true
fi
if command -v modprobe >/dev/null 2>&1; then
  sudo modprobe nf_conntrack || true
fi
retry 3 sudo apt-get update -y
retry 3 sudo apt-get install -y --no-install-recommends unzip libcap2-bin jq dnsutils binaryen build-essential pkg-config libssl-dev git nodejs debian-keyring debian-archive-keyring apt-transport-https docker.io docker-cli libjemalloc2 ca-certificates curl gnupg lsb-release openssl psmisc
release_service_ports

if [ "$WG_ENABLED" -eq 1 ]; then
  RESOLV_CONF_BACKUP=""
  if ! command -v wg-quick >/dev/null 2>&1; then
    log "installing wireguard-tools..."
    if ! retry 3 sudo apt-get install -y --no-install-recommends wireguard-tools; then
      fail "wireguard-tools installation failed"
      exit 1
    fi
  fi
  if ! command -v resolvconf >/dev/null 2>&1; then
    if ! retry 3 getent ahosts registry.npmjs.org >/dev/null 2>&1; then
      fail "dns resolution is unavailable before resolver setup"
      exit 1
    fi
    RESOLV_CONF_BACKUP="$(mktemp)"
    cp -L /etc/resolv.conf "$RESOLV_CONF_BACKUP"
    RESOLVER_PACKAGE="openresolv"
    if ! apt-cache show "$RESOLVER_PACKAGE" >/dev/null 2>&1; then
      RESOLVER_PACKAGE="systemd-resolved"
    fi
    log "installing $RESOLVER_PACKAGE..."
    if ! retry 3 sudo apt-get install -y --no-install-recommends "$RESOLVER_PACKAGE"; then
      fail "dns resolver installation failed"
      exit 1
    fi
  fi
  require_cmd wg
  require_cmd wg-quick
  require_cmd resolvconf
  if ! retry 3 getent ahosts registry.npmjs.org >/dev/null 2>&1; then
    if [ -n "$RESOLV_CONF_BACKUP" ] && [ -s "$RESOLV_CONF_BACKUP" ]; then
      if ! sudo cp --remove-destination "$RESOLV_CONF_BACKUP" /etc/resolv.conf || ! sudo chmod 644 /etc/resolv.conf; then
        fail "dns resolver setup failed and the previous configuration could not be restored"
        exit 1
      fi
      rm -f "$RESOLV_CONF_BACKUP"
      fail "dns resolver setup failed; the previous configuration was restored"
      exit 1
    fi
    fail "dns resolution is unavailable"
    exit 1
  fi
  [ -z "$RESOLV_CONF_BACKUP" ] || rm -f "$RESOLV_CONF_BACKUP"
  if [ "$WG_ENABLED" -eq 1 ] && [ "$WG_REUSE" -eq 0 ]; then
    log "installing wireguard config..."
    sed -i '/^[[:space:]]*#/d' "$WG_CONFIG_FILE"
    sed -i -E 's/[0-9a-f]*:[0-9a-f:.]+\/[0-9]+//g' "$WG_CONFIG_FILE"
    sed -i -E 's/,\s*,/, /g' "$WG_CONFIG_FILE"
    sed -i -E 's/=\s*,/ = /g' "$WG_CONFIG_FILE"
    sed -i -E 's/,\s*$//' "$WG_CONFIG_FILE"
    PHYS_DEV=$(ip -4 route show default 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' | head -1)
    if [ -n "$PHYS_DEV" ]; then
      PHYS_MTU=$(ip link show "$PHYS_DEV" 2>/dev/null | sed -n 's/.*mtu \([0-9]*\).*/\1/p')
    fi
    WG_MTU=$((${PHYS_MTU:-1500} - 80))
    [ "$WG_MTU" -lt 1280 ] && WG_MTU=1280
    sed -i "/^\[Interface\]/a MTU = $WG_MTU" "$WG_CONFIG_FILE"
    sudo mkdir -p /etc/wireguard
    sudo cp "$WG_CONFIG_FILE" /etc/wireguard/wg0.conf
    sudo chmod 600 /etc/wireguard/wg0.conf
    rm -f "$WG_CONFIG_FILE"
    success "wireguard config installed at /etc/wireguard/wg0.conf (mtu: $WG_MTU)"
  fi
  if [ "$WG_ENABLED" -eq 1 ]; then
    WG_FWMARK=$(sudo sed -n -E \
      's/^[[:space:]]*FwMark[[:space:]]*=[[:space:]]*([^[:space:]#]+).*$/\1/p' \
      /etc/wireguard/wg0.conf | head -1)
    if ! [[ "$WG_FWMARK" =~ ^(0[xX][[:xdigit:]]+|[[:digit:]]+)$ ]]; then
      WG_FWMARK=0xca6c
    fi
    sudo sed -i -E \
      -e '/^[[:space:]]*Table[[:space:]]*=/Id' \
      -e '/^[[:space:]]*FwMark[[:space:]]*=/Id' \
      -e '/^[[:space:]]*PostUp[[:space:]]*=[[:space:]]*wg[[:space:]]+set[[:space:]]+%i[[:space:]]+fwmark[[:space:]]+0xca6c[[:space:]]*$/Id' \
      /etc/wireguard/wg0.conf
    sudo sed -i \
      "/^[[:space:]]*\[Interface\][[:space:]]*$/a\\
FwMark = $WG_FWMARK\\
Table = off
" \
      /etc/wireguard/wg0.conf
    sudo chmod 600 /etc/wireguard/wg0.conf
    success "wireguard policy routing normalized"
    if sudo grep -Eq '^[[:space:]]*DNS[[:space:]]*=' /etc/wireguard/wg0.conf; then
      sudo sed -i -E \
        's|^[[:space:]]*DNS[[:space:]]*=[[:space:]]*(.*)$|# LyraVPNDNS = \1|' \
        /etc/wireguard/wg0.conf
      success "wireguard dns reserved for routed services; host dns left unchanged"
    fi
    sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
    [ "$WG_REUSE" -eq 1 ] && log "reusing existing wireguard config at /etc/wireguard/wg0.conf"
  fi
fi

if ! command -v eturnalctl >/dev/null 2>&1 && [ ! -x /opt/eturnal/bin/eturnalctl ]; then
  curl -fsS -o /tmp/eturnal-install.sh https://eturnal.net/install
  sudo sh /tmp/eturnal-install.sh
  rm -f /tmp/eturnal-install.sh
fi
if ! command -v eturnalctl >/dev/null 2>&1 && [ ! -x /opt/eturnal/bin/eturnalctl ]; then
  fail "eturnal installation failed"
  exit 1
fi
export PATH="/opt/eturnal/bin:$PATH"

BUN_VERSION="1.4.2"
BUN_CURRENT_VERSION="$(bun --version 2>/dev/null || true)"
if [ "$BUN_CURRENT_VERSION" != "$BUN_VERSION" ]; then
  log "installing bun $BUN_VERSION"
  curl -fsSL https://bun.com/install | bash -s -- "bun-v$BUN_VERSION"
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  fail "bun installation failed"
  exit 1
fi
require_cmd bun

BUN_BIN="$(command -v bun)"
if [ "$("$BUN_BIN" --version)" != "$BUN_VERSION" ]; then
  fail "bun $BUN_VERSION is required"
  exit 1
fi

if ! "$BUN_BIN" pm -g ls | grep -q "pm2@"; then
  if ! retry 3 "$BUN_BIN" add -g pm2; then
    fail "pm2 installation failed"
    exit 1
  fi
else
  if ! retry 3 "$BUN_BIN" update -g pm2; then
    fail "pm2 update failed"
    exit 1
  fi
fi

PM2_BIN="$(command -v pm2 || true)"
if [ -z "$PM2_BIN" ] && [ -x "$HOME/.bun/bin/pm2" ]; then
  PM2_BIN="$HOME/.bun/bin/pm2"
fi
if [ -z "$PM2_BIN" ]; then
  fail "pm2 installation failed"
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
fi

require_cmd rustup

if ! command -v cargo >/dev/null 2>&1; then
  fail "cargo installation failed"
  exit 1
fi
require_cmd cargo

CARGO_BIN="$(command -v cargo)"

RUST_NIGHTLY="nightly-2026-06-30"
if ! rustup run "$RUST_NIGHTLY" rustc --version >/dev/null 2>&1; then
  rustup toolchain install "$RUST_NIGHTLY" --profile minimal --component rust-src
else
  rustup component add rust-src --toolchain "$RUST_NIGHTLY"
fi

if ! command -v wasm-bindgen >/dev/null 2>&1 || [ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.105" ]; then
  "$CARGO_BIN" install wasm-bindgen-cli --version 0.2.105 --locked
fi

if ! command -v wasm-snip >/dev/null 2>&1; then
  "$CARGO_BIN" install wasm-snip --version 0.4.0 --locked
fi

if ! dpkg-query -W -f='${Status}' caddy 2>/dev/null | grep -q "install ok installed"; then
  sudo mkdir -p /usr/share/keyrings /etc/apt/sources.list.d
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  retry 3 sudo apt-get update -y
  retry 3 sudo apt-get install -y --no-install-recommends caddy
fi

if [ -f /etc/sysctl.d/99-lyra-optimizations.conf ]; then
  sudo cp /etc/sysctl.d/99-lyra-optimizations.conf /etc/sysctl.d/99-lyra-optimizations.conf.bak.$(date +%s)
fi

cat <<EOF | sudo tee /etc/sysctl.d/99-lyra-optimizations.conf
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 10
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 10
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.ip_local_port_range = 1024 65535
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 0
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192
fs.file-max = 2097152
fs.nr_open = 2097152
vm.swappiness = 10
vm.vfs_cache_pressure = 50
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_fin_timeout = 10
net.core.optmem_max = 25165824
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.send_redirects = 0
EOF
sudo sysctl -p /etc/sysctl.d/99-lyra-optimizations.conf || true

if ! grep -q "^\* soft nofile" /etc/security/limits.conf; then
  echo "* soft nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi
if ! grep -q "^\* hard nofile" /etc/security/limits.conf; then
  echo "* hard nofile 1048576" | sudo tee -a /etc/security/limits.conf
fi

if [ -d "$ROOT/services/nuru" ]; then
  (
    cd "$ROOT/services/nuru"
    RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
    sudo cp target/release/nuru /usr/local/bin/nuru
    sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru || true
  )
else
  fail "nuru service directory not found"
  exit 1
fi

id -u mochi >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin mochi
id -u nuru >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin nuru

if [ "$WG_ENABLED" -eq 0 ]; then
  MOCHI_UID=$(id -u mochi 2>/dev/null || echo "")
  NURU_UID=$(id -u nuru 2>/dev/null || echo "")
  [ -n "$MOCHI_UID" ] && sudo ip rule del uidrange "$MOCHI_UID"-"$MOCHI_UID" lookup 200 2>/dev/null || true
  [ -n "$NURU_UID" ] && sudo ip rule del uidrange "$NURU_UID"-"$NURU_UID" lookup 200 2>/dev/null || true
fi

JEMALLOC_PATH=""
for jemalloc_candidate in /usr/lib/*-linux-gnu/libjemalloc.so.2; do
  if [ -f "$jemalloc_candidate" ]; then
    JEMALLOC_PATH="$jemalloc_candidate"
    break
  fi
done

if [ "$WG_ENABLED" -eq 1 ]; then
  sudo chown nuru:nuru /usr/local/bin/nuru
  sudo setcap cap_net_bind_service=+ep /usr/local/bin/nuru || true

  cat <<'NRSCRIPT' | sudo tee /usr/local/bin/nuru-route.sh >/dev/null
#!/bin/bash
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "[nuru-route] must run as root... /ᐠ - ˕ -マ" >&2
    exit 0
fi

log() { echo "[nuru-route] $(date '+%H:%M:%S') $*"; }
fail() { log "$*... /ᐠ - ˕ -マ"; }
success() { log "$*!! (˵◝ ⩊  ◜˵マ"; }

NURU_UID=$(id -u nuru 2>/dev/null || echo "")
[ -z "$NURU_UID" ] && { fail "nuru user not found"; exit 0; }
MOCHI_UID=$(id -u mochi 2>/dev/null || echo "")
[ -z "$MOCHI_UID" ] && { fail "mochi user not found"; exit 0; }

WG_IFACES=()
if command -v wg >/dev/null 2>&1; then
    IFS=' ' read -r -a WG_IFACES < <(wg show interfaces 2>/dev/null || true) || true
fi

if [ ${#WG_IFACES[@]} -eq 0 ]; then
    for iface in utun420 tun0 tun1 wg0; do
        if ip link show "$iface" &>/dev/null 2>&1; then
            if ! command -v wg >/dev/null 2>&1 || wg show "$iface" >/dev/null 2>&1; then
                WG_IFACES+=("$iface")
            fi
        fi
    done
fi

log "detected wireguard interfaces: ${WG_IFACES[*]:-none}"

VPN_IF=""
for iface in "${WG_IFACES[@]}"; do
    if [ "$iface" = "wg0" ]; then
        VPN_IF="$iface"
        break
    fi
    [ -n "$VPN_IF" ] || VPN_IF="$iface"
done

MAIN_DEF=""
while read -r route; do
    if ! echo "$route" | grep -qE 'dev (utun|tun|wg)'; then
        MAIN_DEF="$route"
        break
    fi
done < <(ip route show default 2>/dev/null || true)

if [ -z "$MAIN_DEF" ]; then
    PHYS_IF=$(ip -br link show 2>/dev/null | grep -vE '^(lo|utun|tun|wg|veth|docker|br-)' | awk 'NR==1 {print $1}')
    if [ -n "$PHYS_IF" ]; then
        PHYS_GW=$(ip route show 0/0 dev "$PHYS_IF" 2>/dev/null | awk '{print $3}' || true)
        if [ -z "$PHYS_GW" ]; then
            PHYS_IP=$(ip -4 addr show "$PHYS_IF" 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
            if [ -n "$PHYS_IP" ]; then
                PHYS_GW=$(echo "$PHYS_IP" | awk -F. '{print $1"."$2"."$3".1"}')
            fi
        fi
        [ -n "$PHYS_GW" ] && MAIN_DEF="default via $PHYS_GW dev $PHYS_IF"
    fi
fi
[ -z "$MAIN_DEF" ] && { fail "cannot determine physical default route"; exit 0; }

WG_MARK=0xca6c
if [ -n "$VPN_IF" ]; then
    CURRENT_WG_MARK=$(wg show "$VPN_IF" fwmark 2>/dev/null || true)
    if [[ "$CURRENT_WG_MARK" =~ ^(0[xX][[:xdigit:]]+|[[:digit:]]+)$ ]]; then
        WG_MARK="$CURRENT_WG_MARK"
    else
        wg set "$VPN_IF" fwmark "$WG_MARK"
    fi
    RULES=$(ip rule list 2>/dev/null || true)
    TABLE_DEFAULT=$(ip route show table 200 default 2>/dev/null || true)
    if echo "$RULES" | grep -Eq "^[[:space:]]*500:.*fwmark ${WG_MARK}(/[^[:space:]]+)?[[:space:]].*lookup main" \
        && echo "$RULES" | grep -Eq "^[[:space:]]*1000:.*uidrange ${NURU_UID}-${NURU_UID}.*lookup 200" \
        && echo "$RULES" | grep -Eq "^[[:space:]]*1001:.*uidrange ${MOCHI_UID}-${MOCHI_UID}.*lookup 200" \
        && echo "$TABLE_DEFAULT" | grep -Fq " dev $VPN_IF" \
        && ! ip route show default 2>/dev/null | grep -qE 'dev (utun|tun|wg)'; then
        success "vpn policy routing already configured"
        exit 0
    fi
fi

ip rule del fwmark 0xca6c/0xca6c lookup main priority 500 2>/dev/null || true
ip rule del fwmark "$WG_MARK" lookup main priority 500 2>/dev/null || true
ip rule del uidrange "$NURU_UID"-"$NURU_UID" lookup 200 2>/dev/null || true
ip rule del uidrange "$MOCHI_UID"-"$MOCHI_UID" lookup 200 2>/dev/null || true
ip route flush table 200 2>/dev/null || true
while read -r route; do
    ip route del $route 2>/dev/null || true
done < <(ip route show default 2>/dev/null | grep -E "dev (utun|tun|wg)" || true)
ip route replace $MAIN_DEF 2>/dev/null || true

log "main table default: $MAIN_DEF"

ip rule add fwmark "$WG_MARK" lookup main priority 500 2>/dev/null || true
ip rule add uidrange "$NURU_UID"-"$NURU_UID" lookup 200 priority 1000 2>/dev/null || true
ip rule add uidrange "$MOCHI_UID"-"$MOCHI_UID" lookup 200 priority 1001 2>/dev/null || true

if [ -n "$VPN_IF" ]; then
    log "routing nuru and mochi through $VPN_IF"

    VPN_DEF=$(ip route show default dev "$VPN_IF" 2>/dev/null | head -1 || true)
    if [ -n "$VPN_DEF" ]; then
        ip route replace $VPN_DEF table 200 2>/dev/null || true
    else
        ip route replace default dev "$VPN_IF" table 200 2>/dev/null || true
    fi

    ip route show dev "$VPN_IF" 2>/dev/null | while read -r route; do
        [ -n "$route" ] && ip route replace $route table 200 2>/dev/null || true
    done

    success "table 200 configured via $VPN_IF"
else
    log "no vpn: routed services using physical ip"
    ip route replace $MAIN_DEF table 200 2>/dev/null || true
fi

log "--- policy routing rules ---"
ip rule list 2>/dev/null | head -10 || true
exit 0
NRSCRIPT
  sudo chmod 755 /usr/local/bin/nuru-route.sh

  if [ -f /etc/wireguard/wg0.conf ]; then
    log "bringing up wg0..."
    if ! sudo systemctl restart wg-quick@wg0; then
      fail "wireguard interface failed to start"
      exit 1
    fi
    if ! sudo wg show wg0 >/dev/null 2>&1; then
      fail "wireguard interface is unavailable after startup"
      exit 1
    fi
    sudo /usr/local/bin/nuru-route.sh
  fi

  cat <<NRROUTE | sudo tee /etc/systemd/system/nuru-route.service >/dev/null
[Unit]
Description=setup nuru vpn routing
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/flock /run/lyra-vpn-route.lock /usr/local/bin/nuru-route.sh
NRROUTE

  cat <<NRTIMER | sudo tee /etc/systemd/system/nuru-route.timer >/dev/null
[Unit]
Description=nuru vpn routing check

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=timers.target
NRTIMER

  sudo systemctl daemon-reload
  sudo systemctl enable nuru-route.timer >/dev/null 2>&1 || true
  sudo systemctl start nuru-route.timer 2>/dev/null || true
  sudo systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
fi

PUBLIC_IP="$(curl -s4 --max-time 8 ifconfig.me || true)"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(dig +short txt ch whoami.cloudflare @1.0.0.1 2>/dev/null | tr -d '"' || true)"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}' || true)"

if [ -z "$PUBLIC_IP" ]; then
  fail "couldn't detect public ip"
  exit 1
fi

TURN_HOST="${TURN_HOST:-$PUBLIC_IP}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_USERNAME="${TURN_USERNAME:-lyly}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-$(openssl rand -hex 24)}"

if [ -f /etc/eturnal.yml ]; then
  sudo cp /etc/eturnal.yml /etc/eturnal.yml.bak.$(date +%s)
fi

sudo tee /etc/eturnal.yml >/dev/null <<EOF
eturnal:
  credentials:
    "$TURN_USERNAME": "$TURN_CREDENTIAL"
  realm: "$TURN_HOST"
  relay_ipv4_addr: "$PUBLIC_IP"
  listen:
    - ip: "0.0.0.0"
      port: $TURN_PORT
      transport: udp
    - ip: "0.0.0.0"
      port: $TURN_PORT
      transport: tcp
  relay_min_port: 49152
  relay_max_port: 65535
  log_dir: stdout
  log_level: warning
  modules:
    mod_log_stun: {}
EOF
if [ -f /etc/eturnal.yml ]; then
  success "/etc/eturnal.yml applied"
else
  fail "/etc/eturnal.yml was not created"
  exit 1
fi

sudo chown eturnal:eturnal /etc/eturnal.yml
sudo chmod 640 /etc/eturnal.yml
sudo systemctl stop coturn 2>/dev/null || true
sudo systemctl disable coturn 2>/dev/null || true
sudo fuser -k "$TURN_PORT"/tcp 2>/dev/null || true
sudo fuser -k "$TURN_PORT"/udp 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable eturnal
sudo systemctl restart eturnal

if ! systemctl is-active --quiet eturnal; then
  fail "eturnal failed to start"
  sudo journalctl -u eturnal --no-pager -n 20 >&2
  exit 1
fi

sudo systemctl enable docker >/dev/null 2>&1 || true
sudo systemctl start docker >/dev/null 2>&1 || true
if ! sudo docker info >/dev/null 2>&1; then
  fail "docker daemon is not ready"
  exit 1
fi
require_cmd docker
require_cmd caddy

export PATH="$HOME/.bun/bin:$PATH"
export IP="$PUBLIC_IP"

if [ -f bun.lock ]; then
  "$BUN_BIN" install --frozen-lockfile --prefer-offline || "$BUN_BIN" install
else
  "$BUN_BIN" install
fi

if [ -d "$ROOT/services/mochi" ]; then
  (
    cd "$ROOT/services/mochi"
    RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
  )
fi

if [ -d "$ROOT/services/cloudsync" ]; then
  (
    cd "$ROOT/services/cloudsync"
    RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
  )
fi

if [ -d "$ROOT/services/isao" ]; then
  (
    cd "$ROOT/services/isao"
    RUSTFLAGS="-C target-cpu=native" "$CARGO_BIN" build --release
  )
fi

sudo cp "$ROOT/services/mochi/target/release/mochi" /usr/local/bin/mochi
sudo chmod 755 /usr/local/bin/mochi
sudo mkdir -p /var/cache/lyra-mochi
sudo chown -R mochi:mochi /var/cache/lyra-mochi
CACHE_AVAILABLE_KB=$(df -Pk /var/cache/lyra-mochi | awk 'NR == 2 { print $4 }')
if [[ ! "$CACHE_AVAILABLE_KB" =~ ^[1-9][0-9]*$ ]]; then
  fail "available cache disk space could not be determined"
  exit 1
fi
ANIME_CACHE_GB=$((CACHE_AVAILABLE_KB / 1048576 / 5))
if [ "$ANIME_CACHE_GB" -lt 1 ]; then
  ANIME_CACHE_GB=1
elif [ "$ANIME_CACHE_GB" -gt 100 ]; then
  ANIME_CACHE_GB=100
fi
if [ "$MOCHI_AUTO" -eq 1 ] && [ "$MOCHI_INSTANCES" -gt "$ANIME_CACHE_GB" ]; then
  MOCHI_INSTANCES=$ANIME_CACHE_GB
  configure_mochi_instances
fi
ANIME_CACHE_GB=$((ANIME_CACHE_GB / MOCHI_INSTANCES))
if [ "$ANIME_CACHE_GB" -lt 1 ]; then
  fail "insufficient cache space for the requested mochi instance count"
  exit 1
fi
if [ "$ANIME_CACHE_GB" -lt 20 ]; then
  ANIME_CACHE_TTL_DAYS=3
elif [ "$ANIME_CACHE_GB" -lt 50 ]; then
  ANIME_CACHE_TTL_DAYS=5
else
  ANIME_CACHE_TTL_DAYS=7
fi
log "proxy instances: mochi=$MOCHI_INSTANCES, nuru=$NURU_INSTANCES"
log "anime cache per instance: ${ANIME_CACHE_GB} gb with ${ANIME_CACHE_TTL_DAYS} day retention"
configure_proxy_limits
sudo tee /etc/systemd/system/lyra-proxy.slice >/dev/null <<EOF
[Unit]
Description=lyra proxy resource budget

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
CPUQuota=$((PROXY_CPUS * 70))%
MemoryHigh=40%
MemoryMax=50%
MemorySwapMax=0
TasksMax=4096
EOF

MOCHI_VPN_AFTER=""
MOCHI_VPN_PRESTART=""
if [ "$WG_ENABLED" -eq 1 ]; then
  MOCHI_VPN_AFTER=" wg-quick@wg0.service"
  MOCHI_VPN_PRESTART="ExecStartPre=!/usr/bin/flock /run/lyra-vpn-route.lock /usr/local/bin/nuru-route.sh"
fi
sudo tee /etc/systemd/system/nuru@.service >/dev/null <<EOF
[Unit]
Description=nuru proxy
After=network-online.target nss-lookup.target$MOCHI_VPN_AFTER
Wants=network-online.target$MOCHI_VPN_AFTER
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=nuru
Type=simple
Slice=lyra-proxy.slice
MemoryHigh=$((NURU_MEMORY_MB * 80 / 100))M
MemoryMax=${NURU_MEMORY_MB}M
OOMPolicy=kill
$MOCHI_VPN_PRESTART
ExecStart=/usr/local/bin/nuru /etc/nuru/config-%i.toml
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=10
Environment=RUST_LOG=off
Environment=NURU_INSTANCES=$NURU_INSTANCES
Environment=LD_PRELOAD=$JEMALLOC_PATH
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

for ((i = 0; i < MOCHI_INSTANCES; i++)); do
  sudo mkdir -p "/var/cache/lyra-mochi/instance-$i/cache/stream"
  sudo chown -R mochi:mochi "/var/cache/lyra-mochi/instance-$i"
done
sudo tee /etc/systemd/system/mochi@.service <<EOF
[Unit]
Description=mochi reverse proxy and anime stream cache
After=network-online.target$MOCHI_VPN_AFTER
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=mochi
Group=mochi
Type=simple
Slice=lyra-proxy.slice
MemoryHigh=$((MOCHI_MEMORY_MB * 80 / 100))M
MemoryMax=${MOCHI_MEMORY_MB}M
OOMPolicy=kill
WorkingDirectory=/var/cache/lyra-mochi/instance-%i
EnvironmentFile=/etc/mochi/instance-%i.env
$MOCHI_VPN_PRESTART
ExecStart=/usr/local/bin/mochi
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=15
Environment=RUST_LOG=warn
Environment=MOCHI_HOST=127.0.0.1
Environment=MOCHI_INSTANCES=$MOCHI_INSTANCES
Environment=MOCHI_STREAM_CACHE_GB=$ANIME_CACHE_GB
Environment=MOCHI_STREAM_CACHE_TTL_DAYS=$ANIME_CACHE_TTL_DAYS
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo mkdir -p /etc/mochi
for ((i = 0; i < MOCHI_INSTANCES; i++)); do
  printf 'MOCHI_PORT=%s\n' "$((4100 + i))" | sudo tee "/etc/mochi/instance-$i.env" >/dev/null
done

"$BUN_BIN" --bun run build

sudo mkdir -p /etc/nuru /etc/systemd/system/caddy.service.d

if [ -f /etc/systemd/system/caddy.service.d/override.conf ]; then
  sudo cp /etc/systemd/system/caddy.service.d/override.conf /etc/systemd/system/caddy.service.d/override.conf.bak.$(date +%s)
  success "existing caddy override config backed up"
fi

sudo tee /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
Environment="NO_PROXY=127.0.0.1"
LimitNOFILE=1048576
EOF
sudo systemctl daemon-reload

if [ -f /etc/caddy/Caddyfile ]; then
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%s)
  success "existing caddy config backed up"
fi

sudo tee /etc/caddy/Caddyfile <<EOF
{
    email sefiicc@gmail.com

    servers {
        protocols h1 h2 h3
    }

    on_demand_tls {
        ask http://127.0.0.1:3001/
    }
}

http://127.0.0.1:4000 {
    bind 127.0.0.1
    reverse_proxy $MOCHI_UPSTREAMS {
        lb_policy least_conn
        unhealthy_request_count $MOCHI_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        flush_interval -1
    }
}

http://127.0.0.1:4001 {
    bind 127.0.0.1
    reverse_proxy $NURU_UPSTREAMS {
        lb_policy least_conn
        unhealthy_request_count $NURU_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        flush_interval -1
    }
}

:443 {
    tls {
        on_demand
    }

    @compressible {
        not path /stream/*
    }
    encode @compressible zstd gzip

    handle /lyra/health {
        rewrite * /health
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /tls-approval/health {
        rewrite * /health
        reverse_proxy 127.0.0.1:3001 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /cloudsync/health {
        rewrite * /health
        reverse_proxy 127.0.0.1:4005 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /isao/health {
        rewrite * /health
        reverse_proxy 127.0.0.1:6001 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /mochi/health {
        rewrite * /health
        reverse_proxy $MOCHI_UPSTREAMS {
            lb_policy least_conn
            unhealthy_request_count $MOCHI_REQUESTS
            fail_duration 10s
            health_uri /health
            header_up X-Real-IP {remote_host}
        }
    }

    handle /nuru/health {
        rewrite * /health
        reverse_proxy $NURU_UPSTREAMS {
            lb_policy least_conn
            unhealthy_request_count $NURU_REQUESTS
            fail_duration 10s
            health_uri /health
            header_up X-Real-IP {remote_host}
        }
    }

    handle /eturnal/health {
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /health {
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {remote_host}
        }
    }

    @nuru_routes {
        path /w/*
    }
    reverse_proxy @nuru_routes $NURU_UPSTREAMS {
        lb_policy least_conn
        unhealthy_request_count $NURU_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        max_fails 4
        header_up Host {upstream_hostport}
        header_up X-Real-IP {remote_host}
        flush_interval -1
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            read_buffer 65536
            write_buffer 65536
        }
    }

    @mochi_routes {
        path /!!raw/* /!!/* /!!folio/* /!cover!/* /stream/*
        not path /stream/anime*
    }
    reverse_proxy @mochi_routes $MOCHI_UPSTREAMS {
        lb_policy least_conn
        unhealthy_request_count $MOCHI_REQUESTS
        health_uri /health
        health_interval 10s
        fail_duration 10s
        max_fails 4
        header_up Host {upstream_hostport}
        header_up X-Real-IP {remote_host}
        flush_interval -1
        transport http {
            keepalive 120s
            keepalive_idle_conns 4096
            keepalive_idle_conns_per_host 1024
            dial_timeout 5s
            response_header_timeout 30s
        }
    }

    @static_assets {
        path /assets/* /b/* /bmux/* /epoxy/* /libcurl/*
    }
    reverse_proxy @static_assets h2c://127.0.0.1:4444 {
        header_up X-Real-IP {remote_host}
    }

    handle /api/auth/* {
        reverse_proxy 127.0.0.1:4005 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /api/sync/* {
        reverse_proxy 127.0.0.1:4005 {
            header_up X-Real-IP {remote_host}
        }
    }

    handle /api/anime/* {
        reverse_proxy 127.0.0.1:6001 {
            header_up X-Real-IP {remote_host}
        }
    }

    @lyra_player {
        path /stream/anime*
    }
    reverse_proxy @lyra_player h2c://127.0.0.1:4444 {
        header_up X-Real-IP {remote_host}
    }

    handle /s {
        reverse_proxy h2c://127.0.0.1:4444 {
            header_up X-Real-IP {remote_host}
        }
    }

    reverse_proxy 127.0.0.1:4444 {
        header_up X-Real-IP {remote_host}
        transport http {
            keepalive 120s
            keepalive_idle_conns 512
            keepalive_idle_conns_per_host 64
            dial_timeout 5s
        }
    }
}

:80 {
    redir https://{host}{uri} permanent
}
EOF
if [ -f /etc/caddy/Caddyfile ]; then
  success "/etc/caddy/Caddyfile applied"
else
  fail "/etc/caddy/Caddyfile was not created"
  exit 1
fi

if [ ! -f "$ROOT/services/nuru/config.toml" ]; then
  fail "nuru config was not found at $ROOT/services/nuru/config.toml"
  exit 1
fi
if [ "$WG_ENABLED" -eq 1 ] && [ -f /etc/wireguard/wg0.conf ]; then
  VPN_DNS_LIST=$(sed -n -E 's/^[[:space:]]*(DNS|#[[:space:]]*LyraVPNDNS)[[:space:]]*=[[:space:]]*(.*)$/\2/ip' /etc/wireguard/wg0.conf 2>/dev/null | tr -d ' ' | tr ',' '\n' | grep -v '^$' || true)
  if [ -n "$VPN_DNS_LIST" ]; then
    DNS_TOML="["
    first=true
    while IFS= read -r dns; do
      if [ -n "$dns" ]; then
        [ "$first" = false ] && DNS_TOML+=", "
        DNS_TOML+="\"$dns\""
        first=false
      fi
    done <<<"$VPN_DNS_LIST"
    DNS_TOML+="]"
    sed -i "s|^dns_servers = \[.*\]|dns_servers = $DNS_TOML|" "$ROOT/services/nuru/config.toml"
    success "nuru dns updated to use vpn dns: $DNS_TOML"
  fi
fi
sudo cp "$ROOT/services/nuru/config.toml" /etc/nuru/config.toml
for ((i = 0; i < NURU_INSTANCES; i++)); do
  sed "s|^bind = .*|bind = [\"tcp\", \"127.0.0.1:$((4200 + i))\"]|" \
    /etc/nuru/config.toml | sudo tee "/etc/nuru/config-$i.toml" >/dev/null
done
if [ -f /etc/nuru/config.toml ]; then
  success "/etc/nuru/config.toml applied"
  sudo chown -R nuru:nuru /etc/nuru
else
  fail "/etc/nuru/config.toml was not created"
  exit 1
fi

TOTAL_RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || free -m | awk '/^Mem:/ {print $2}' 2>/dev/null || 8192)
[ -z "$TOTAL_RAM_MB" ] || [ "$TOTAL_RAM_MB" -le 0 ] && TOTAL_RAM_MB=8192

calc_mem() {
  local pct=$1 min=$2 max=$3
  local val=$((TOTAL_RAM_MB * pct / 100))
  [ "$val" -lt "$min" ] && val=$min
  [ "$val" -gt "$max" ] && val=$max
  echo "$val"
}

LYRA_MEM="$(calc_mem 16 256 2560)M"
CLOUDSYNC_MEM="$(calc_mem 6 128 768)M"
ISAO_MEM="$(calc_mem 8 128 768)M"
log "memory restart thresholds — lyra: $LYRA_MEM, cloudsync: $CLOUDSYNC_MEM, isao: $ISAO_MEM"

"$PM2_BIN" stop all >/dev/null 2>&1 || true
"$PM2_BIN" delete all >/dev/null 2>&1 || true

tee ecosystem.config.cjs >/dev/null <<EOF
module.exports = {
  apps: [
    {
      name: "tls-approval",
      script: "$BUN_BIN",
      args: "run services/tls-approval/server.js",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10000,
      max_memory_restart: "256M"
    },
    {
      name: "lyra",
      script: "$BUN_BIN",
      args: "server/prod.mjs",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      min_uptime: 15000,
      kill_timeout: 10000,
      max_memory_restart: "$LYRA_MEM",
      env: {
        NODE_ENV: "production",
        PORT: "4444",
        MOCHI_ORIGIN: "http://127.0.0.1:4000",
        WEBRTC_TURN_ENABLED: "1",
        WEBRTC_FORCE_RELAY: "1",
        TURN_HOST: "$TURN_HOST",
        TURN_PORT: "$TURN_PORT",
        TURN_USERNAME: "$TURN_USERNAME",
        TURN_CREDENTIAL: "$TURN_CREDENTIAL"
      }
    },
    {
      name: "cloudsync",
      script: "./target/release/cloudsync",
      cwd: "$ROOT/services/cloudsync",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "$CLOUDSYNC_MEM",
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
       env: {
         RUST_LOG: "warn",
         CLOUDSYNC_DB_PATH: "$ROOT/services/cloudsync/.db",
         CLOUDSYNC_MEMORY_MB: "${CLOUDSYNC_MEM%M}"
       }
    },
EOF
tee -a ecosystem.config.cjs >/dev/null <<EOF
    {
      name: "isao",
      script: "$ROOT/services/isao/target/release/isao",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "$ISAO_MEM",
      max_restarts: 10,
      min_uptime: 10000,
      kill_timeout: 5000,
      env: {
        RUST_LOG: "warn",
        ISAO_PORT: "6001"
      }
    },
EOF
tee -a ecosystem.config.cjs >/dev/null <<'EOF'
  ]
};
EOF
chmod 600 ecosystem.config.cjs

if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS=$(sudo ufw status)
  if grep -q "Status: active" <<<"$UFW_STATUS"; then
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow 443/udp
    sudo ufw allow "$TURN_PORT"/tcp
    sudo ufw allow "$TURN_PORT"/udp
    sudo ufw allow 49152:65535/udp
  fi
fi

if [ ! -f .env ]; then
  JWT_SECRET=$(openssl rand -hex 64)
  SYNC_SECRET=$(openssl rand -hex 32)
  echo "JWT_SECRET=$JWT_SECRET" >.env
  echo "SYNC_SECRET=$SYNC_SECRET" >>.env
  chmod 600 .env
else
  if ! grep -q "JWT_SECRET" .env; then
    JWT_SECRET=$(openssl rand -hex 64)
    echo "" >>.env
    echo "JWT_SECRET=$JWT_SECRET" >>.env
  else
    JWT_SECRET=$(grep "^JWT_SECRET=" .env | cut -d '=' -f2)
  fi

  if ! grep -q "SYNC_SECRET" .env; then
    SYNC_SECRET=$(openssl rand -hex 32)
    echo "SYNC_SECRET=$SYNC_SECRET" >>.env
  else
    SYNC_SECRET=$(grep "^SYNC_SECRET=" .env | cut -d '=' -f2)
  fi
fi

chmod 600 .env

if [ -d "$ROOT/services/cloudsync" ]; then
  echo "JWT_SECRET=$JWT_SECRET" >"$ROOT/services/cloudsync/.env"
  echo "SYNC_SECRET=$SYNC_SECRET" >>"$ROOT/services/cloudsync/.env"
  echo "COOKIE_SECURE=true" >>"$ROOT/services/cloudsync/.env"
  chmod 600 "$ROOT/services/cloudsync/.env"
  if [ -f "$ROOT/services/cloudsync/.env" ]; then
    success "cloudsync environment applied"
  else
    fail "cloudsync environment was not created"
    exit 1
  fi
fi

if [ ! -f "$ROOT/services/cloudsync/.db" ]; then
  touch "$ROOT/services/cloudsync/.db"
fi

if [ -f "$ROOT/services/cloudsync/.db" ]; then
  chmod 600 "$ROOT/services/cloudsync/.db"
  chmod 600 "$ROOT/services/cloudsync/.db-shm" 2>/dev/null || true
  chmod 600 "$ROOT/services/cloudsync/.db-wal" 2>/dev/null || true
fi

sudo systemctl daemon-reload
sudo systemctl start lyra-proxy.slice
PROXY_CGROUP=$(systemctl show --property=ControlGroup --value lyra-proxy.slice)
if [ -z "$PROXY_CGROUP" ] || ! proxy_limits_active "/sys/fs/cgroup$PROXY_CGROUP" 2>/dev/null; then
  fail "proxy resource limits could not be activated"
  exit 1
fi
sudo systemctl enable "${MOCHI_SERVICES[@]}" >/dev/null 2>&1
sudo systemctl restart "${MOCHI_SERVICES[@]}"
for svc in "${MOCHI_SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    fail "mochi instance failed to start"
    sudo journalctl -u "$svc" --no-pager -n 30 >&2
    exit 1
  fi
done

"$PM2_BIN" start ecosystem.config.cjs --update-env
"$PM2_BIN" save
sudo env PATH="$PATH:$HOME/.bun/bin" "$PM2_BIN" startup systemd -u "$USER" --hp "$HOME" || true
PM2_SYSTEMD_SERVICE="pm2-$USER.service"
if systemctl cat "$PM2_SYSTEMD_SERVICE" >/dev/null 2>&1; then
  sudo mkdir -p "/etc/systemd/system/$PM2_SYSTEMD_SERVICE.d"
  cat <<EOF | sudo tee "/etc/systemd/system/$PM2_SYSTEMD_SERVICE.d/limits.conf" >/dev/null
[Service]
LimitNOFILE=1048576
EOF
  sudo systemctl daemon-reload
  "$PM2_BIN" kill >/dev/null 2>&1 || true
  sudo systemctl restart "$PM2_SYSTEMD_SERVICE"
fi

log "starting nuru systemd service..."
sudo systemctl enable "${NURU_SERVICES[@]}" >/dev/null 2>&1
sudo systemctl restart "${NURU_SERVICES[@]}"
sleep 2
for svc in "${NURU_SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    fail "nuru instance failed to start"
    sudo journalctl -u "$svc" --no-pager -n 10 >&2
    exit 1
  fi
done
success "nuru instances are running"

PM2_SVCS=(tls-approval lyra cloudsync isao)
for svc in "${PM2_SVCS[@]}"; do
  if ! "$PM2_BIN" jlist | jq -e --arg name "$svc" \
    '.[] | select(.name == $name and .pm2_env.status == "online")' >/dev/null; then
    fail "pm2 service failed to start: $svc"
    exit 1
  fi
done

health_ok() {
  [ "$(curl --fail --silent --max-time 3 "$1")" = "oki" ]
}

for upstream in $MOCHI_UPSTREAMS $NURU_UPSTREAMS; do
  if ! retry 10 health_ok "http://$upstream/health"; then
    fail "proxy worker health check failed"
    exit 1
  fi
done
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl restart caddy

SERVICE_HEALTH_CHECKS=(
  "tls-approval|http://127.0.0.1:3001/health"
  "lyra|http://127.0.0.1:4444/health"
  "cloudsync|http://127.0.0.1:4005/health"
  "isao|http://127.0.0.1:6001/health"
  "mochi|http://127.0.0.1:4000/health"
  "nuru|http://127.0.0.1:4001/health"
  "eturnal|http://127.0.0.1:4444/eturnal/health"
)
for ((i = 0; i < MOCHI_INSTANCES; i++)); do
  SERVICE_HEALTH_CHECKS+=("mochi@$i|http://127.0.0.1:$((4100 + i))/health")
done
for ((i = 0; i < NURU_INSTANCES; i++)); do
  SERVICE_HEALTH_CHECKS+=("nuru@$i|http://127.0.0.1:$((4200 + i))/health")
done
for health_check in "${SERVICE_HEALTH_CHECKS[@]}"; do
  service_name="${health_check%%|*}"
  service_url="${health_check#*|}"
  if ! retry 10 health_ok "$service_url"; then
    fail "$service_name health check failed"
    exit 1
  fi
done

success "all done!! lyra is now up and running!!!!"
