// Builds one install tarball per platform. Each holds the single-file bundle and an install.sh that
// copies it somewhere stable and hands it to the platform's service manager, so unpacking and
// running install.sh is the whole setup.
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "dist-packages");
const bundle = path.join(here, "dist/agentd.mjs");
const { version } = JSON.parse(await readFile(path.join(here, "package.json"), "utf8"));

const installSh = (platform, service) => `#!/bin/sh
# Rakazo host agent installer (${platform}).
#
#   ./install.sh              copy the bundle, put "rakazo-agentd" on PATH, register the service
#   ./install.sh --no-service copy the bundle only; you run start/stop/status yourself
#   ./install.sh --portable   use the plain sh runner (no launchd/systemd), then: rakazo-agentd start
set -eu
here=$(cd "$(dirname "$0")" && pwd)
NODE=\${RAKAZO_NODE:-$(command -v node || true)}
if [ -z "$NODE" ]; then
  echo "Node.js 22 or newer is required: https://nodejs.org" >&2
  exit 1
fi
portable=
noservice=
for arg in "$@"; do
  case "$arg" in
    --portable) portable=1 ;;
    --no-service) noservice=1 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# *//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

DEST="$HOME/.rakazo-agent"
BIN="$HOME/.local/bin"
mkdir -p "$DEST" "$BIN"
chmod 700 "$DEST"
cp "$here/agentd.mjs" "$DEST/agentd.mjs"
chmod 755 "$DEST/agentd.mjs"
cp "$here/uninstall.sh" "$DEST/uninstall.sh"
chmod 755 "$DEST/uninstall.sh"
cat > "$DEST/rakazo-agentd" <<EOF
#!/bin/sh
exec "$NODE" "$DEST/agentd.mjs" "\\$@"
EOF
chmod 755 "$DEST/rakazo-agentd"
ln -sf "$DEST/rakazo-agentd" "$BIN/rakazo-agentd"

onpath=0
case ":$PATH:" in *":$BIN:"*) onpath=1 ;; esac

echo "Installed:"
echo "  bundle   $DEST/agentd.mjs"
echo "  command  $BIN/rakazo-agentd -> $DEST/rakazo-agentd"
echo "  config   $DEST/config.json    (written by setup, not by install)"
echo "  log      $DEST/agent.log"
if [ "$onpath" = 0 ]; then
  echo
  echo "  $BIN is not on your PATH. Either call $BIN/rakazo-agentd directly, or add:"
  echo "    export PATH=\\"\\$HOME/.local/bin:\\$PATH\\""
fi

if [ -n "$noservice" ]; then
  echo
  echo "Skipped service registration (--no-service). Start it with:"
  echo "  rakazo-agentd start"
elif [ -n "$portable" ]; then
  echo
  echo "Registering the portable runner (no ${service})..."
  "$NODE" "$DEST/agentd.mjs" install --portable
else
  echo
  echo "Registering the background service (${service})..."
  "$NODE" "$DEST/agentd.mjs" install
fi

echo
if ! "$NODE" "$DEST/agentd.mjs" status >/dev/null 2>&1; then
  echo "Next: pair this computer (once). Nothing is configured yet:"
  echo "  rakazo-agentd setup --server <https://your-server> --email <you>"
  echo "  (add --remember to keep the password locally; without it the saved session"
  echo "   renews itself and only needs setup again if it lapses after 7+ days offline)"
  echo "The agent keeps running when setup writes the configuration; no restart needed."
else
  echo "Already paired. Status:"
  "$NODE" "$DEST/agentd.mjs" status || true
fi

echo
echo "Command: rakazo-agentd  (setup/start/stop/status/install/mode/unlock)"
echo "Remove:  $DEST/uninstall.sh"
echo "The unpacked folder can be deleted now; everything lives in $DEST."
`;

const uninstallSh = `#!/bin/sh
# Removes the service and the installed bundle. Pairing data is kept.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
NODE=\${RAKAZO_NODE:-$(command -v node || true)}
if [ -f "$HOME/.rakazo-agent/agentd.mjs" ]; then
  "$NODE" "$HOME/.rakazo-agent/agentd.mjs" uninstall || true
fi
rm -f "$HOME/.rakazo-agent/agentd.mjs" "$HOME/.rakazo-agent/rakazo-agentd"
rm -f "$HOME/.local/bin/rakazo-agentd"
echo "Service and bundle removed. ~/.rakazo-agent still has your configuration and log."
echo "Reinstall, or delete ~/.rakazo-agent to forget the pairing."
`;

const readme = (platform, service) => `Rakazo host agent ${version} (${platform})

WHAT THIS IS
  A headless background daemon. It connects outbound to your Rakazo server and runs
  the shell/file commands bots send it. No window, no desktop app.

INSTALL
  tar xzf rakazo-agentd-${version}-${platform}.tar.gz
  cd rakazo-agentd-${version}-${platform}
  ./install.sh

  Requires Node.js 22+ on PATH (or set RAKAZO_NODE=/path/to/node).

WHERE THINGS GO
  ~/.rakazo-agent/agentd.mjs       the bundle (single file)
  ~/.rakazo-agent/rakazo-agentd    launcher script
  ~/.local/bin/rakazo-agentd       symlink, so "rakazo-agentd" works
  ~/.rakazo-agent/config.json      created by setup, mode 600
  ~/.rakazo-agent/agent.log        log
  ${platform === "macos" ? "~/Library/LaunchAgents/dev.rakazo.agentd.plist   service definition" : "~/.config/systemd/user/rakazo-agentd.service   service definition"}

  The unpacked folder is not needed after install; delete it.

PAIR (once)
  rakazo-agentd setup --server https://your-server --email you@example.com
  Optional: --name <label> --remember --auto|--ask|--deny
  --remember stores the password locally so a lapsed sign-in can re-pair itself.
  Without it, the saved session renews on its own; only 7+ days fully offline
  forces a new setup.

NO SYSTEMD / NO LAUNCHD
  ./install.sh --portable     writes ~/.rakazo-agent/agentd-run.sh instead
  rakazo-agentd start         starts it now (detached sh runner)
  rakazo-agentd status
  rakazo-agentd stop

  On Linux, plain ./install.sh falls back to this automatically if systemctl
  --user does not work (containers, minimal distros, no session bus).

COMMANDS
  setup | status | mode | unlock | lock | pause | resume | logout
  start | stop | install | uninstall | run (foreground)

  rakazo-agentd start    background, no service manager, works on any POSIX box
  rakazo-agentd install  register at login: launchd (macOS) / systemd --user (Linux)

UNINSTALL
  ~/.rakazo-agent/uninstall.sh    removes service + bundle, keeps config
  rm -rf ~/.rakazo-agent          forget the pairing too
`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const [platform, service] of [
  ["macos", "launchd"],
  ["linux", "systemd --user"],
]) {
  const dir = path.join(out, `rakazo-agentd-${version}-${platform}`);
  await mkdir(dir, { recursive: true });
  await cp(bundle, path.join(dir, "agentd.mjs"));
  await writeFile(path.join(dir, "install.sh"), installSh(platform, service));
  await writeFile(path.join(dir, "uninstall.sh"), uninstallSh, { mode: 0o755 });
  await writeFile(path.join(dir, "README.txt"), readme(platform, service));
  await chmod(path.join(dir, "install.sh"), 0o755);
  const archive = `${dir}.tar.gz`;
  await exec("tar", ["czf", archive, "-C", out, path.basename(dir)]);
  await rm(dir, { recursive: true, force: true });
  console.log(archive);
}
