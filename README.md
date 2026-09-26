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
The strictest result stands.

It peels:

- leading `NAME=value` assignments and redirects (`> out`, `2>&1`);
- a program path or quoting, so `/bin/rm`, `\rm`, and `"rm"` are judged as `rm`;
- `builtin`, `command`, `doas`, `env` (including `-S`), `exec`, `nice`,
  `nocorrect`, `noglob`, `nohup`, `stdbuf`, `sudo`, `time`, `timeout`, and
  `xargs`, with the options each takes.

It only ever denies: when the rules deny a peeled spelling, the command is
denied. Any other result of a peeled spelling is ignored, because a spelling
no narrower rule covers falls to the catch-all, and `./gradlew` must not
inherit that `ask` as `gradlew`. It loads rules only for a command that has
something to peel, and denies the command if the rules cannot be loaded.

It does not interpret `sh -c` or `eval` payloads, split bundled short options
such as `-sT`, or skip options between a program and its subcommand.

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
