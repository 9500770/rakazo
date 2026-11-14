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
# Rakazo host agent — installs the background agent on ${platform}.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
NODE=\${RAKAZO_NODE:-$(command -v node || true)}
if [ -z "$NODE" ]; then
  echo "Node.js 22 or newer is required: https://nodejs.org" >&2
  exit 1
fi
mkdir -p "$HOME/.rakazo-agent"
chmod 700 "$HOME/.rakazo-agent"
cp "$here/agentd.mjs" "$HOME/.rakazo-agent/agentd.mjs"
chmod 755 "$HOME/.rakazo-agent/agentd.mjs"
cat > "$HOME/.rakazo-agent/rakazo-agentd" <<EOF
#!/bin/sh
exec "$NODE" "$HOME/.rakazo-agent/agentd.mjs" "\\$@"
EOF
chmod 755 "$HOME/.rakazo-agent/rakazo-agentd"

echo "Installed to $HOME/.rakazo-agent/agentd.mjs"
if ! "$NODE" "$HOME/.rakazo-agent/agentd.mjs" status >/dev/null 2>&1; then
  echo
  echo "Pair this computer first:"
  echo "  $HOME/.rakazo-agent/rakazo-agentd setup --server <url> --email <you>"
  echo "It keeps running once setup writes the configuration; no restart needed."
  echo
fi
echo "Registering the background service (${service})..."
"$NODE" "$HOME/.rakazo-agent/agentd.mjs" install
echo
"$NODE" "$HOME/.rakazo-agent/agentd.mjs" status || true
echo
echo "Command: $HOME/.rakazo-agent/rakazo-agentd  (start/stop/status/setup/mode/unlock)"
echo "Log:     $HOME/.rakazo-agent/agent.log"
`;

const uninstallSh = `#!/bin/sh
# Removes the service and the installed bundle. Pairing data is kept.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
NODE=\${RAKAZO_NODE:-$(command -v node || true)}
if [ -f "$HOME/.rakazo-agent/agentd.mjs" ]; then
  "$NODE" "$HOME/.rakazo-agent/agentd.mjs" uninstall || true
fi
rm -f "$HOME/.rakazo-agent/agentd.mjs"
echo "Service and bundle removed. ~/.rakazo-agent still has your configuration and log."
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
  await chmod(path.join(dir, "install.sh"), 0o755);
  const archive = `${dir}.tar.gz`;
  await exec("tar", ["czf", archive, "-C", out, path.basename(dir)]);
  await rm(dir, { recursive: true, force: true });
  console.log(archive);
}
