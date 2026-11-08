# shell-unwrap

Applies your shell permission rules to wrapped commands, as an OpenCode 2
plugin, a Pi extension, and Claude Code, Codex and Cursor hooks that share one
peel. The hooks are one bundle, `dist/hook/shell-unwrap.js`, which carries
tree-sitter's WASM once and takes its host as the first argument: `claude`,
`codex` or `cursor`. The Pi extension runs the `codex` host.

OpenCode matches a `shell` rule against a command's raw text, so a deny for
`rm *` does not catch `timeout 30 rm -rf x`, `FOO=1 rm -rf x`, or
`/bin/rm -rf x`. The usual workaround is a copy of every deny behind every
wrapper, which multiplies a ruleset many times over. Claude Code peels some
wrappers itself and its denies catch most peeled spellings, but a loop, a
subshell, a command substitution, `xargs -n1`, or `env -u` prompts even when
every program in it is allowed, and it never shows the model why a deny exists.
Cursor Desktop's terminal allowlist has no deny list at all, so a broad allow
such as `git` also allows every `git` command a deny would forbid.

## How it works

Every entry point peels launch prefixes from a command, repeatedly, and judges
each peeled spelling by the host's own rules. It peels:

- leading `NAME=value` assignments and redirects (`> out`, `2>&1`);
- a program path or quoting, so `/bin/rm`, `\rm`, and `"rm"` are judged as `rm`;
- `builtin`, `command`, `doas`, `env` (including `-S`), `exec`, `nice`,
  `nocorrect`, `noglob`, `nohup`, `stdbuf`, `sudo`, `time`, `timeout`, and
  `xargs`, with the options each takes.

The innermost command is also judged with its flags read apart: a bundle of up
to four short flags split (`-fu` as `-f -u`), a joined value detached
(`--method=POST`, `-chdir=dir`, `-n1`, `-XPOST`), and a short bundle whose
tail could be a value read both ways (`-oL` as `-o -L` and `-o L`), so a rule
written for `-f` or `--method POST` needs no copy for each spelling. A longer
run of letters is a single-dash long option (`-extra`) and stays whole.

When the rules deny a peeled spelling, the command is denied, and when a rule
asks for one, an allowed command asks. The one allow it
carries goes the other way: a command that would otherwise ask is allowed when
peeling only transparent wrappers and harmless assignments (`GIT_EDITOR=true`,
`PYTHONDONTWRITEBYTECODE=1`, and the `IFS=` separators `read` takes) reaches
an allow rule, so
`timeout 30 git status` runs wherever `git status` does. Transparent means
`builtin`, `command`, `env -i` and `env -u`, `nice`, `nocorrect`, `noglob`,
`nohup`, `stdbuf`, `time -p`, `timeout`, and `xargs`, named bare or from
`/bin` or `/usr/bin`, with only the options that change when or how the
command runs or how much environment it sees; `time -o FILE`, `env -C`, and
`env NAME=value` do not qualify. `xargs` appends its input, so unless it
substitutes it (`-I`, `-J`) the command must pass with one more argument: an
exact rule never carries it. A narrower rule matching any spelling on the way
decides instead, so an ask written for `timeout * bq cp` still asks.
Other assignments, program paths, and the other wrappers never carry an allow:
they change the program, its user, or its environment, and `./gradlew` must
not inherit anything from `gradlew`.

It does not interpret `sh -c` or `eval` payloads, or skip options between a
program and its subcommand: a rule set covers those with a `prog -* sub` hole,
as coding-agent-sync writes one for every ask and deny.

### OpenCode

The plugin hooks `permission.evaluate`, which OpenCode runs for every shell
decision that its rules did not already deny, and judges spellings by the
agent's rules followed by the session's, last match wins; the catch-all `*`
rule never makes a spelling ask. It loads rules only
for a command that has something to peel, and denies the command if the rules
cannot be loaded.

### Claude Code

The hook is a `Bash` PreToolUse command. It parses the command with
tree-sitter's bash grammar, embedded in the bundle, and judges every simple
command inside it, including those in loops, pipelines, subshells, and command
substitutions, against the `Bash(...)` rules in `settings.json` with Claude's
glob matching. It denies the whole command when any spelling of one is denied,
asks when any spelling of one is asked, and allows it when every one reaches an
allow. Claude still evaluates its own deny and ask rules after a hook allow, so
the hook only removes prompts. Claude itself peels `xargs` only bare, so a rule
set may leave `xargs` with options to this hook; it therefore asks when it
cannot parse the command or fails, and its guards fail closed. Claude's bypass
permissions mode still shows a hook's ask, so in that mode the hook never asks;
its denies still apply, as Claude's own deny rules do.

For an allow, it stays silent, leaving the command to Claude, on anything it
does not model: file redirects, `tee`, `find` actions, `fd -x`, `cd` outside
the working directories or beside `git`, shell variable assignments, function
definitions, and dynamic program names.

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

### Codex

The hook is a `Bash` `PreToolUse` command in `~/.codex/config.toml`, and the
bundle sits in `~/.codex/hooks/` beside a `shell-unwrap.json` that holds the
deny rules as `Bash(...)` entries. Codex prefix rules match a literal argv
prefix and hold no text rule, so the hook judges every command inside a call
with the Claude hook's peel and matching, and denies it when any spelling of
one is denied. It only denies: Codex rejects an `ask` from a `PreToolUse`
hook, so asks stay native `prompt` prefix rules. It denies when it cannot read
its rules or fails, so the guards fail closed, except when the approval policy
is `never` (`permission_mode` `bypassPermissions`). Codex runs a hook only after
the user trusts it in `/hooks`.

### Pi

The extension, `dist/pi/index.js`, sits in
`~/.pi/agent/extensions/shell-unwrap/` beside the hook bundle and its
`shell-unwrap.json`. On every `bash` tool call it runs the bundle's Codex host
and blocks the call with the hook's reason when the hook denies, or when the
hook cannot run. Pi runs extensions in Node, so the bundle runs in a Bun
subprocess, started in the bundle's directory so a project's mise config
cannot break the `bun` shim. It never asks: the permission system Pi runs alongside it,
pi-permission-system, already asks for a command behind a wrapper it does not
know.

## Deny reasons

A denied command can tell the model what to run instead. Each entry point reads
`shell-unwrap.json` from the host's config root (`~/.config/opencode/`,
`~/.claude/`) or, for Codex, Cursor and Pi, from beside the bundle:

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

coding-agent-sync vendors the three bundles and installs them with the
permissions it compiles, which rely on them; its permission audit imports
`spellings` from the hook bundle. To update the vendored copies:

```sh
bun install
bun run check
targets=~/.local/share/src/coding-agent-sync/src/coding_agents_sync/targets/shell-unwrap
cp dist/opencode/shell-unwrap.js "$targets/opencode.js"
cp dist/hook/shell-unwrap.js "$targets/hook.js"
cp dist/pi/index.js "$targets/pi.js"
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

`check` typechecks, builds the three bundles, and runs the tests: the peel's
golden tables (`test/spellings.json`, `test/transparent.json`), the OpenCode
review, and the Claude, Codex and Cursor hooks' decisions and the Pi
extension's, run through the built bundles. A Bun macro (`src/wasm.ts`) inlines tree-sitter's WASM at transpile
time. The plugin typechecks against OpenCode 2.2.6's `@opencode/schema`;
`bunfig.toml` exempts it from the global minimum release age. The live
OpenCode test lives in coding-agent-sync
(`tests/capabilities/targets/test_opencode_unwrap.py`).
