# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server when using the npm package. The Mise release archive includes its own Node.js runtime.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Install the CLI with Mise

Install the standalone CLI archive from GitHub Releases:

```bash
mise use -g "github:pingdotgg/t3code[matching=t3-cli]@latest"
```

Release archives are available for macOS arm64/x64 and Linux x64. For a prerelease or fork, use that repository and enable prerelease discovery, for example:

```bash
mise use -g "github:OWNER/REPOSITORY[matching=t3-cli,prerelease=true]@VERSION"
```

The installed `t3` command includes its runtime dependencies, but provider CLIs such as `codex`, `claude`, or `omp` still need to be installed separately.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

```bash
yay -S t3code-bin
```

## Providers

T3 Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with              |
| ---------- | ----------------------------------------------------- | -------------- | ------------------------ |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`            |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`      |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`            |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`             |
| OMP        | [Oh My Pi](./providers-omp.md)                        | `omp`          | Run `omp`, then `/login` |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login`    |

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For provider-specific setup, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), and [OMP](./providers-omp.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
