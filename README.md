# shell-unwrap

Applies your shell permission rules to wrapped commands, as an OpenCode 2
plugin, a Claude Code hook, and a Cursor hook that share one peel. The two
hooks are one bundle, `dist/hook/shell-unwrap.js`, which carries tree-sitter's
WASM once and takes its host as the first argument: `claude` or `cursor`.

OpenCode matches a `shell` rule against a command's raw text, so a deny for
`rm *` does not catch `timeout 30 rm -rf x`, `FOO=1 rm -rf x`, or
`/bin/rm -rf x`. The usual workaround is a copy of every deny behind every
wrapper, which multiplies a ruleset many times over. Claude Code peels some
wrappers itself, but it matches an allow only against a flat command, so a
loop, a pipeline into `xargs -n1`, or `timeout -k 5 30` prompts even when every
program in it is allowed, and it never shows the model why a deny exists.
Cursor Desktop's terminal allowlist has no deny list at all, so a broad allow
such as `git` also allows every `git` command a deny would forbid.

## How it works

Both entry points peel launch prefixes from a command, repeatedly, and judge
each peeled spelling by the host's own rules. It peels:

- leading `NAME=value` assignments and redirects (`> out`, `2>&1`);
- a program path or quoting, so `/bin/rm`, `\rm`, and `"rm"` are judged as `rm`;
- `builtin`, `command`, `doas`, `env` (including `-S`), `exec`, `nice`,
  `nocorrect`, `noglob`, `nohup`, `stdbuf`, `sudo`, `time`, `timeout`, and
  `xargs`, with the options each takes.

When the rules deny a peeled spelling, the command is denied. The one allow it
carries goes the other way: a command that would otherwise ask is allowed when
peeling only transparent wrappers reaches an allow rule, so
`timeout 30 git status` runs wherever `git status` does. Transparent means
`builtin`, `command`, `env -i` and `env -u`, `nice`, `nocorrect`, `noglob`,
`nohup`, `stdbuf`, `time -p`, `timeout`, and `xargs`, named bare or from
`/bin` or `/usr/bin`, with only the options that change when or how the
command runs or how much environment it sees; `time -o FILE`, `env -C`, and
`env NAME=value` do not qualify. `xargs` appends its input, so unless it
substitutes it (`-I`, `-J`) the command must pass with one more argument: an
exact rule never carries it. A narrower rule matching any spelling on the way
decides instead, so an ask written for `timeout * bq cp` still asks.
Assignments, program paths, and the other wrappers never carry an allow: they
change the program, its user, or its environment, and `./gradlew` must not
inherit anything from `gradlew`.

It does not interpret `sh -c` or `eval` payloads, split bundled short options
such as `-sT`, or skip options between a program and its subcommand.

### OpenCode

The plugin hooks `permission.evaluate`, which OpenCode runs for every shell
decision that its rules did not already deny, and judges spellings by the
agent's rules followed by the session's, last match wins. It loads rules only
for a command that has something to peel, and denies the command if the rules
cannot be loaded.

### Claude Code

The hook is a `Bash` PreToolUse command. It parses the command with
tree-sitter's bash grammar, embedded in the bundle, and judges every simple
command inside it, including those in loops, pipelines, subshells, and command
substitutions, against the `Bash(...)` rules in `settings.json` with Claude's
glob matching. It denies the whole command when any spelling of one is denied,
and allows it when every one reaches an allow. Claude still evaluates its own
deny and ask rules after a hook allow, so the hook only removes prompts.

It stays silent, leaving the command to Claude, on anything it does not model:
file redirects, `tee`, `find` actions, `fd -x`, `cd` outside the working
directories or beside `git`, shell variable assignments, function
definitions, dynamic program names, parse errors, and any failure.

### Cursor

The hook is a `beforeShellExecution` command in `~/.cursor/hooks.json`, which
both Cursor Desktop and the Cursor CLI load; Desktop can refuse user-local
plugins, so it is not one. The bundle sits in `~/.cursor/hooks/`. It reads `Bash(...)` ask and deny rules from the
`permissions` of the `shell-unwrap.json` beside it and judges every simple
command, including those inside functions and after declarations, with the
same peel and matching as the Claude hook. It denies the command when any
spelling of one is denied, and asks when any is asked. It also asks when it
cannot parse the command or read its rules, so the guards fail closed.
Otherwise it prints `{}`: Cursor ignores an `allow` from this hook, so the
terminal allowlist still decides, and the hook only adds prompts and refusals.

## Deny reasons

A denied command can tell the model what to run instead. Each entry point reads
`shell-unwrap.json` from the host's config root (`~/.config/opencode/`,
`~/.claude/`) or, for Cursor, from beside the bundle:

```json
{"reasons": {"rm *": "use `trash`"}}
```

Each key is the exact pattern of a shell deny rule. When the rule that decided
a denied command has a reason, the denial names it. OpenCode never runs
`permission.evaluate` for its own denies, so for those the plugin sets the
reason on the `Permission.BlockedError` from `tool.execute.after`. A missing
or unreadable file leaves reasons out; it never fails the OpenCode or Claude
entry point.

## Install

coding-agent-sync vendors the two bundles and installs them with the permissions
it compiles, which rely on them; its permission audit imports `spellings` from
the hook bundle. To update the vendored copies:

```sh
bun install
bun run check
targets=~/.local/share/src/coding-agent-sync/src/coding_agents_sync/targets/shell-unwrap
cp dist/opencode/shell-unwrap.js "$targets/opencode.js"
cp dist/hook/shell-unwrap.js "$targets/hook.js"
```

Standalone, copy `dist/opencode/shell-unwrap.js` into
`~/.config/opencode/plugins/`, or copy `dist/hook/shell-unwrap.js` into
`~/.claude/hooks/` and register it in `settings.json`:

```json
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
  {"type": "command", "command": "bun ~/.claude/hooks/shell-unwrap.js claude 2>/dev/null || true"}
]}]}}
```

## Develop

```sh
bun run check
```

`check` typechecks, builds the two bundles, and runs the tests: the peel's
golden tables (`test/spellings.json`, `test/transparent.json`), the OpenCode
review, and the Claude and Cursor hooks' decisions, run through the built
bundles. A Bun macro (`src/wasm.ts`) inlines tree-sitter's WASM at transpile
time. The plugin typechecks against OpenCode 2.2.6's `@opencode/schema`;
`bunfig.toml` exempts it from the global minimum release age. The live
OpenCode test lives in coding-agent-sync
(`tests/capabilities/targets/test_opencode_unwrap.py`).
