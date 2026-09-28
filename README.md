# opencode-unwrap

An OpenCode 2 plugin that applies your shell permission rules to wrapped
commands.

OpenCode matches a `shell` rule against a command's raw text, so a deny for
`rm *` does not catch `timeout 30 rm -rf x`, `FOO=1 rm -rf x`, or
`/bin/rm -rf x`. The usual workaround is a copy of every deny behind every
wrapper, which multiplies a ruleset many times over. This plugin removes the
need for those copies.

## How it works

The plugin hooks `permission.evaluate`, which OpenCode runs for every shell
decision that its rules did not already deny. For each command it peels
launch prefixes, repeatedly, and judges each peeled spelling by the same rules
OpenCode uses: the agent's rules followed by the session's, last match wins.
The strictest result stands, except for the one allow described below.

It peels:

- leading `NAME=value` assignments and redirects (`> out`, `2>&1`);
- a program path or quoting, so `/bin/rm`, `\rm`, and `"rm"` are judged as `rm`;
- `builtin`, `command`, `doas`, `env` (including `-S`), `exec`, `nice`,
  `nocorrect`, `noglob`, `nohup`, `stdbuf`, `sudo`, `time`, `timeout`, and
  `xargs`, with the options each takes.

When the rules deny a peeled spelling, the command is denied. The one allow it
carries goes the other way: a command that fell to the catch-all `ask` is
allowed when peeling only transparent wrappers reaches an allow rule, so
`timeout 30 git status` runs wherever `git status` does. Transparent means
`nice`, `nohup`, `noglob`, `nocorrect`, `time -p`, and `timeout`, named bare
or from `/bin` or `/usr/bin`, with only the options that change when or how
the command runs; `time -o FILE` does not qualify. A narrower rule matching
any spelling on the way decides instead, so an ask written for `timeout * bq
cp` still asks. Assignments, program paths, and the other wrappers never carry
an allow: they change the program, its arguments, or its user, and
`./gradlew` must not inherit anything from `gradlew`. It loads rules only for a
command that has something to peel, and denies the command if the rules
cannot be loaded.

It does not interpret `sh -c` or `eval` payloads, split bundled short options
such as `-sT`, or skip options between a program and its subcommand.

## Deny reasons

A denied command can tell the model what to run instead. The plugin reads
`opencode-unwrap.json` from beside its plugins directory:

```json
{"reasons": {"rm *": "use `trash`"}}
```

Each key is the exact `resource` of a shell deny rule. When the rule that
decided a denied command has a reason, the denial names it. OpenCode never
runs `permission.evaluate` for its own denies, so for those the plugin sets
the reason on the `Permission.BlockedError` from `tool.execute.after`. A
missing or unreadable file leaves reasons out; it never fails the plugin.

## Install

coding-agent-sync vendors the bundle and installs it with the OpenCode
permissions it compiles, which rely on it. Its audit ports the peeling to
Python and must match `test/spellings.json` exactly. To update both copies:

```sh
bun install
bun run build
cp dist/opencode-unwrap.js ~/.local/share/src/coding-agent-sync/src/coding_agents_sync/targets/
cp test/spellings.json ~/.local/share/src/coding-agent-sync/tests/fixtures/opencode-unwrap/
```

Standalone, copy the bundle into `~/.config/opencode/plugins/`.

## Develop

```sh
bun run check
```

`check` typechecks against `@opencode/plugin` and runs the unit tests. The live
test lives in coding-agent-sync
(`tests/capabilities/targets/test_opencode_unwrap.py`) and reads the bundle
path from `OPENCODE_UNWRAP_PLUGIN`.
