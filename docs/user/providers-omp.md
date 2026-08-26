# Oh My Pi (OMP)

T3 Code can run OMP as a native provider. OMP runs on the machine hosting the T3 server; web,
desktop, and mobile clients connect through T3 as usual.

## Install and set up OMP

Install OMP using the [official installation instructions](https://github.com/can1357/oh-my-pi#install).
Then launch `omp` and use `/login`, or configure the API keys required by your models as described in
the [OMP provider guide](https://omp.sh/docs/providers). Confirm the binary is available:

```bash
omp --version
```

T3 uses OMP's credentials, profiles, and model catalog. It does not require a separate login inside
T3. OMP owns the session file format, but T3 overrides the storage location: sessions launched by T3
live under the active server state directory at `provider-sessions/<provider-instance-id>`. This is
normally `<T3 home>/userdata/provider-sessions/<provider-instance-id>`; an implicit development
server uses `<T3 home>/dev/provider-sessions/<provider-instance-id>`.

## Configure the provider

Open **Settings → Providers → OMP**. The default instance uses:

```text
Binary path: omp
Profile: empty
Launch arguments: empty
```

Set **Binary path** when OMP is not on the server's `PATH`. Set **Profile** to select an existing OMP
profile. Additional launch arguments may enable or disable OMP tools, extensions, hooks, skills, or
rules; T3 rejects arguments that would override its RPC mode, workspace, session, model, thinking,
or approval-policy ownership.

Capability-altering launch arguments are not compatible with T3's generated-content roles. If an
OMP instance uses tool, extension, hook, skill, or rule arguments, do not select that instance for
title, branch-name, commit-message, or pull-request-content generation. Configure a separate OMP
instance with empty **Launch arguments** for those roles.

You can add multiple OMP provider instances when different profiles or environments are needed.
Each instance owns its running sessions and environment variables independently.

## Supported behavior

OMP support uses native JSONL `rpc-ui`, not ACP. It includes:

- OMP model selection, thinking levels, fast mode, slash commands, and skills
- streaming text, reasoning, tool activity, todos, usage, tasks, and nested agents
- structured approvals and multi-question input dialogs
- steering and queued follow-up messages
- native plan mode with pause, resume, parallel or iterative workflow, refine, cancel, and execution
  with fresh, preserved, or compacted context
- session resume and checkpoint revert through OMP host-turn history

OMP exposes three permission modes in T3: **Approval required**, **Auto-accept edits**, and
**Full access**. The **Auto** reviewer mode is hidden because OMP does not implement that policy.
Permission mode is selected when a provider session starts; changing it starts a new session rather
than mutating an active OMP process.

## Remote use

OMP stays on the T3 server. Hosted web, direct remote, relay, tunnel, desktop, and mobile clients need
only a connection to that server; they do not need an OMP binary or OMP credentials on the client
device.

## Compatibility and updates

T3 checks OMP's negotiated RPC capabilities instead of guessing support from a version number. If an
installed binary is reported as incompatible, use the update action in **Settings → Providers →
OMP** when it is available. To update manually, run `update` through the configured **Binary path**;
for the default path, that is:

```bash
omp update
```

For a custom path, run `<configured-binary-path> update` instead.

T3 does not fall back to ACP or approximate missing approval, input, plan, history, or rollback
semantics.
