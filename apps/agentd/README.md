# @rakazo/agentd — the host agent without a window

Runs on a machine in the background, connects **outbound** to a Rakazo server, and executes the
commands that server's bots send. No UI, no chat, no Electron: one Node process and one file.

```sh
node dist/agentd.mjs setup --server https://app.rakazo.com --email me@example.com
node dist/agentd.mjs install        # launchd on macOS, systemd --user on Linux
node dist/agentd.mjs status
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
Node 22+ with `node dist/agentd.mjs run`.

## Configuration

`~/.rakazo-agent/config.json`, written by `setup`, owner-only (`0600`):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `ask` | `auto` runs everything, `ask` waits for `unlock`, `deny` stays connected but refuses |
| `askMinutes` | `30` | how long one `unlock` approves requests |
| `notify` / `notifyMinutes` | `true` / `15` | desktop notification when approval is needed |
| `workspaceRoot` | `~/.rakazo-agent/computers` | where bot workspaces live |
| `env` | `{}` | extra environment for bot commands (proxy, toolchain `PATH`) |
| `retryMs` | `{min: 1000, max: 60000}` | reconnect backoff for the device socket |
| `sessionRefreshHours` | `6` | how often the pairing's sign-in is refreshed |
| `logMaxBytes` | `5 MiB` | `agent.log` is renamed to `.1` past this size |

`RAKAZO_AGENT_HOME` moves all of it, so a second agent (or a test) can sit beside the real one.

## Sign-in lifetime

The device token itself never expires; the server keeps only its hash. What expires is the
better-auth sign-in that paired it (7 days idle), and the server revokes the device when that
sign-in ends. The daemon therefore refreshes the saved cookie every `sessionRefreshHours`, and,
with `setup --remember`, signs in again and re-pairs by itself if it ever lapses.

## Tests

```sh
node test/smoke.mjs auto   # provision → execute → files → reconnect against a mock device server
node test/smoke.mjs ask    # the same requests are refused until `unlock`
```

No server and no credentials: the test speaks the real wire protocol to a local WebSocket server.
