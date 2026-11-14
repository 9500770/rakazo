# @rakazo/agentd — the host agent without a window

Runs on a machine in the background, connects **outbound** to a Rakazo server, and executes the
commands that server's bots send. No UI, no chat, no Electron: one Node process and one file.

```sh
node dist/agentd.mjs setup --server https://app.rakazo.com --email me@example.com
node dist/agentd.mjs install        # launchd on macOS, systemd --user on Linux
node dist/agentd.mjs status
```

Or with no service manager at all, on any POSIX box:

```sh
node dist/agentd.mjs start          # a detached sh runner keeps it up; no launchd, no systemd
node dist/agentd.mjs status
node dist/agentd.mjs stop
```

## Why it is small

Everything that touches this machine already exists in `@rakazo/adapters` and is reused as-is:

| Piece | Source |
|---|---|
| outbound device socket, reconnect, ping | `adapters/src/user-device-client.ts` |
| validation, concurrency, timeouts, cancel | `adapters/src/host-computer-runner.ts` |
| wire format and size limits | `adapters/src/host-computer-protocol.ts` |
| spawning commands, files, workspaces | `adapters/src/desktop-sandbox.ts` |

Nothing in that layer imports Electron, so this package only adds: the socket's bits of
configuration, sign-in once, a launchd/systemd unit, and the files the agent writes.

## The two files that get swapped

Both are replaced at **build** time by `build.mjs`, never edited:

- `desktop-process-tree.ts` imports `koffi` at the top level for Windows Job Objects. macOS and
  Linux only need the POSIX half, so `src/posix/desktop-process-tree.ts` replaces it.
- `desktop-sandbox-win32-path.ts` is the same story one layer down, and is stubbed.

The result is a bundle with **no native dependencies**: `dist/agentd.mjs` (≈1.5 MB) runs on any
Node 22+ with `node dist/agentd.mjs run` — macOS, Linux, and anything with a POSIX shell (commands
run through the POSIX sandbox; Windows needs the desktop app).

## Staying up

The process is meant to outlive every problem it can recover from, so a service manager never has
to restart it in a loop:

| Situation | Behaviour |
|---|---|
| server unreachable | keeps retrying in the background, full jitter, ceiling 120 s; one log line every few minutes |
| network drops silently | 30 s ping; one missed pong terminates and reconnects |
| token refused / device revoked | stays up; pairs again by itself when a password was saved, otherwise waits for `setup` to rewrite `config.json` and reconnects with no restart |
| sign-in lapses | signs in again and re-pairs; an unreachable server during a check is retried in 30 minutes and never counted as an expired session |
| not set up yet | waits for `setup` instead of exiting, which a service manager would call a crash |
| crash | launchd, systemd (`Restart=on-failure`) or the portable runner restarts it |

`start` / `stop` / `status` work the same way on every platform: `start` runs the bundle under a
detached `sh` runner that restarts it after a crash, `stop` takes the runner and the agent down,
`status` says whether a live pid is behind the pid file.

## Installers

`npm run package` builds two tarballs in `dist-packages/`, one per platform:

```
rakazo-agentd-<version>-macos.tar.gz   install.sh registers the launchd agent
rakazo-agentd-<version>-linux.tar.gz   install.sh registers the systemd --user unit
```

Each holds the single-file bundle plus `install.sh` and `uninstall.sh`. Unpack, run `./install.sh`,
and the background service is registered. `rakazo-agentd install --portable` skips the service
manager entirely and only writes the runner.

## Configuration

`~/.rakazo-agent/config.json`, written by `setup`, owner-only (`0600`):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `ask` | `auto` runs everything, `ask` waits for `unlock`, `deny` stays connected but refuses |
| `askMinutes` | `30` | how long one `unlock` approves requests |
| `notify` / `notifyMinutes` | `true` / `15` | desktop notification when approval is needed |
| `workspaceRoot` | `~/.rakazo-agent/computers` | where bot workspaces live |
| `env` | `{}` | extra environment for bot commands. Rakazo passes only shell keys (`PATH`, `HTTP(S)_PROXY`, `LANG`/`LC_*`, `TZ`, TLS bundle paths); any other name is reported at startup and never reaches a command |
| `retryMs` | `{min: 5000, max: 120000}` | reconnect backoff for the device socket: quick at first, then about one attempt a minute while the server stays away |
| `sessionRefreshHours` | `6` | how often the pairing's sign-in is refreshed |
| `logMaxBytes` | `5 MiB` | `agent.log` is renamed to `.1` past this size, checked on a timer, twice an hour |

`RAKAZO_AGENT_HOME` moves all of it, so a second agent (or a test) can sit beside the real one.

## Logging

Under a service manager the agent appends `agent.log` itself instead of relying on the manager's
redirect: the manager holds the file open, so renaming it would leave the agent writing into
`agent.log.1` forever. A foreground run prints to the terminal instead.

## Sign-in lifetime

The device token itself never expires; the server keeps only its hash. What expires is the
better-auth sign-in that paired it (7 days idle), and the server revokes the device when that
sign-in ends. The daemon therefore refreshes the saved cookie every `sessionRefreshHours` — first
check one minute after start, so a restart does not postpone it — and, with `setup --remember`,
signs in again and re-pairs by itself if it ever lapses.

## Running it against a server on the same machine

`setup --server` decides which server the agent pairs with. A self-hosted one on the same Mac mini
is built from this checkout and deployed out of `~/rakazo-install`, so a change that only touches
server code (prompts, tool wiring) ships as a new image and needs no agent rebuild or restart.

Build the image with the commit it came from as its tag:

```sh
cd ~/rakazo-src
SHA=$(git rev-parse --short=8 HEAD)
docker build -f infra/compose/Dockerfile -t "rakazo/app:local-$SHA" .
```

Then deploy it by tag; `docker-compose.images.yml` renders `${RAKAZO_IMAGE:-...}:${RAKAZO_IMAGE_TAG:-edge}`
for api, web, worker and supervisor, so one `.env` value moves the whole stack:

| File | Keys |
|---|---|
| `~/rakazo-install/.env` | `RAKAZO_IMAGE_TAG=local-<sha>`, `RAKAZO_IMAGE_TAG_PREVIOUS=local-<sha>` |

```sh
cd ~/rakazo-install
./rakazo.sh start      # Docker stack + Tailscale serve + proxy allow-list check
./rakazo.sh status     # containers, tunnel, certificate, memory
./rakazo.sh logs       # api log
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/healthz   # 200 when up
```

Keep `RAKAZO_IMAGE_TAG_PREVIOUS` on the tag that was serving before, so a rollback is one edit plus
`start` and never a rebuild. Do not use `./rakazo.sh update` for a `local-*` tag: it pulls before
starting and there is nothing to pull. Change the tag, then `start`.

Then pair the headless agent with whichever server it should obey, the self-hosted one or the
public one: `setup --server` is the only thing that decides, and the agent keeps working across a
server image change without being reinstalled.

```sh
node dist/agentd.mjs setup --server https://<your-server> --email me@example.com
```

## Tests

```sh
node test/smoke.mjs auto   # provision → execute → files → reconnect against a mock device server
node test/smoke.mjs ask    # the same requests are refused until `unlock`
```

No server and no credentials: the test speaks the real wire protocol to a local WebSocket server.
