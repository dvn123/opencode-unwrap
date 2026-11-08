# shell-unwrap

Applies your shell permission rules to wrapped commands, as Claude Code, Codex
and Cursor hooks, an OpenCode 2 plugin, and a Pi extension that share one peel.
The hooks are one Go binary, `dist/hook/shell-unwrap`, which takes its host as
the first argument: `claude`, `codex` or `cursor`. The OpenCode plugin and the
Pi extension run inside their hosts, so they stay TypeScript and ask the same
binary: the plugin its `opencode` operations, the extension its `codex` host.

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
`env NAME=value` do not qualify. `xargs` appends its input, or puts it in
place of its replacement string (`-I`, `-J`), so the command must pass with
that input in place: an exact rule never carries it, and a guard judges it.
A narrower rule matching any spelling on the way
decides instead, so an ask written for `timeout * bq cp` still asks.
Other assignments, program paths, and the other wrappers never carry an allow:
they change the program, its user, or its environment, and `./gradlew` must
not inherit anything from `gradlew`.

It does not interpret `sh -c` or `eval` payloads, or skip options between a
program and its subcommand: a rule set covers those with a `prog -* sub` hole,
as coding-agent-sync writes one for every ask and deny.

### OpenCode

The plugin hooks `permission.evaluate`, which OpenCode runs for every shell
decision that its rules did not already deny, and has the binary, installed as
`shell-unwrap` one directory above the plugin, judge spellings by the agent's
rules followed by the session's, last match wins; the catch-all `*` rule never
makes a spelling ask. zsh's reading of a command, quoting removed, is judged
as one more spelling, and an allow is carried through a wrapper only when zsh
fixes every word, so `timeout 30 git push $X` asks however `git *` reads. The
binary asks for the rules only when a command has something to peel, and the plugin denies the command if it cannot load the
rules or run the binary.

### Claude Code

The hook is a `Bash` PreToolUse command. It judges every simple command in the
script, including those in loops, pipelines, subshells, and command and
process substitutions, against the `Bash(...)` rules in `settings.json` with
Claude's glob matching. It denies the whole command when any spelling of one is
denied, asks when any spelling of one is asked, and allows it when every one
provably reaches an allow. Claude skips its own prompts after a hook allow and
evaluates only its deny and ask rules, so an allow must never be wrong. Claude
itself peels `xargs` only bare, so a rule set may leave `xargs` with options to
this hook; it therefore asks when it cannot parse the command or fails, and its
guards fail closed. Claude's bypass permissions mode still shows a hook's ask,
so in that mode the hook never asks; its denies still apply, as Claude's own
deny rules do.

The deny and ask guards find commands with mvdan/sh's parser in its zsh and
bash dialects, keeping every command either finds, and judge each piece
between shell operators when neither parses the script. An allow rests on
zsh's reading alone: `internal/unwrap/zsh.go` turns each simple command into
the words zsh passes, with quoting removed and every part zsh decides at run
time (a parameter, a command
substitution, a glob, a brace list, the input `xargs` adds) standing for any
text, including several words or none. What zsh fixes before it runs is
text, not a wildcard: `$HOME`, `$USER`, `$LOGNAME` and `$TMPDIR`, which the shell
inherits from the process that runs the hook and which no allowed command can
reassign, and a loop variable over literal words, judged once per word when
nothing else in the script sets it. Each rule is then graded against those
words. A deny or ask rule that matches every value decides the command, so
`for m in -XPOST; do gh api $m repos/x; done` is denied with the rule's
reason; one that matches only some values, as a guard does for
`git push ${X:---force}` or `echo --force | xargs git push`, leaves it to
Claude, since only run time can tell. A command is allowed only when an allow
rule matches every value and no guard matches any.

Some run-time text cannot reach every part of a rule, and the guards' "may
match" test knows it. A word that cannot split and starts with literal text
other than `-` keeps its run-time part inside that one argument: `src/*`
expands only to names that start `src/`, so `rg -n x src/*.py` cannot meet
`rg * --pre *`. A bare `$f` stays any text, since it may be an option such as
`-XPOST` that a rule matches only once spelled out, except after a literal
`--` in a program that ends its options there (`rg`, `grep`, `fd`, `sed`, `jq`
and the like): `rg -n x -- $f` and `fd -e py | xargs rg -l x --` hold no
option, so only a rule about a path can meet them. Git reads settings only
from `-c` and `--config-env` before its subcommand, from `git config`, and
from a transport URL, so a rule about text inside a word (`git*core.pager*`,
`git -* config*alias.*`) cannot be met by a value after any other literal
subcommand: `git diff $M..HEAD` is allowed, `git -c $x diff` is not. A rule
starting with `*` is about the script's text, such as a variable it names,
which no value adds, so it is judged on the text and on every assignment and
`export` in it. Git started in a directory shaped like a bare repository
(HEAD with objects and refs, or a `commondir`) asks, since that directory's
config runs commands; git whose directory is decided at run time stays with
Claude.

A redirect reads or writes a file, and the `Read(...)` and `Edit(...)` rules
judge it as Claude judges its own file tools: `//path` is absolute, `~/path`
is under the home directory, `/path` is beside the settings file, and a bare
path is under the session's working directory. A write needs an Edit allow, a
read a Read allow or a working directory, and a deny or ask decides the
command; a deny or ask is matched ignoring case and, when it names no
directory, at any depth, so it catches every file it could mean. A relative
path is resolved through the `cd`s before it, and a `cd` that may not run, or
runs in a subshell, leaves later relative paths to Claude. A `cd` to a known
directory needs a `cd` allow rule and is allowed anywhere: what runs there is
judged as usual, relative paths against it. Paths are judged as
written and with their symlinks resolved when the hook runs; a file replaced
by a symlink after that is the race every allowed write already has. It leaves to Claude, by
printing nothing, anything whose effect it cannot bound: zsh parameter flags
(`${(e)x}`), indirection, arithmetic, `=cmd` and `~[dir]` expansion,
`print -P` (prompt substitution runs `$(...)`), assignments outside a command,
a loop, `read`, `printf -v` or `print -v` that sets an exported or zsh-special
variable (`path`, `EDITOR`), builtins that change the shell (`eval`, `trap`,
and `setopt` or `export` beyond error handling, tracing and harmless
variables such as `GIT_OPTIONAL_LOCKS=0`), redirects to run-time paths, `tee`,
`find` actions, `fd -x`, `cd` to a run-time directory, function definitions,
dynamic program names, and control or Unicode blank characters.

The analysis assumes the zsh Claude Code runs on macOS: EXTENDED_GLOB,
MAGIC_EQUAL_SUBST, KSH_GLOB, BARE_GLOB_QUAL, GLOB_SUBST, IGNORE_BRACES and
RC_QUOTES off; Claude Code's own shell sets the first and fourth.
`test/oracle.test.ts` holds it to that zsh: it hides each denied command
behind every known obfuscation, runs every case in zsh with recording stubs on
`PATH` and recording wrappers around builtins, and fails when an allowed case
runs a program that matches a deny or ask rule or no allow rule, or when no
run of a denied or asked case meets the rule. Globs stay wildcards on purpose:
the hook could list the files, but a background command can create one named
`--pre=sh` between the hook's check and zsh's expansion.
`SHELL_UNWRAP_AUDIT=1 bun test test/oracle.test.ts` prints each case's
decision and whether what zsh ran broke the rules, and
`shell-unwrap why SETTINGS CWD` reads JSON-quoted commands, one per line, and
prints each one's decision and, when it is not allowed, the first reason.

### Cursor

The hook is a `beforeShellExecution` command in `~/.cursor/hooks.json`, which
both Cursor Desktop and the Cursor CLI load; Desktop can refuse user-local
plugins, so it is not one. The binary sits in `~/.cursor/hooks/`. It reads `Bash(...)` ask and deny rules from the
`permissions` of the `shell-unwrap.json` beside it and judges every simple
command, including those inside functions and after declarations, with the
same peel and matching as the Claude hook. It denies the command when any
spelling of one is denied, and asks when any is asked. It also asks when it
cannot parse the command or read its rules, so the guards fail closed.
Otherwise it prints `{}`: Cursor ignores an `allow` from this hook, so the
terminal allowlist still decides, and the hook only adds prompts and refusals.

### Codex

The hook is a `Bash` `PreToolUse` command in `~/.codex/config.toml`, and the
binary sits in `~/.codex/hooks/` beside a `shell-unwrap.json` that holds the
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
`~/.pi/agent/extensions/shell-unwrap/` beside the binary and its
`shell-unwrap.json`. On every `bash` tool call it runs the binary's Codex host
and blocks the call with the hook's reason when the hook denies, or when the
hook cannot run. It never asks: the permission system Pi runs alongside it,
pi-permission-system, already asks for a command behind a wrapper it does not
know.

## Deny reasons

A denied command can tell the model what to run instead. Each entry point reads
`shell-unwrap.json` from the host's config root (`~/.config/opencode/`,
`~/.claude/`) or, for Codex, Cursor and Pi, from beside the binary:

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

coding-agent-sync installs the binary, the OpenCode plugin, and the Pi
extension with the permissions it compiles, which rely on them; its permission
audit reads `shell-unwrap spellings`. Build them with:

```sh
bun install
bun run check
```

Standalone, copy `dist/hook/shell-unwrap` into `~/.claude/hooks/` and register
it in `settings.json`:

```json
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
  {"type": "command", "command": "~/.claude/hooks/shell-unwrap claude"}
]}]}}
```

For OpenCode, copy `dist/opencode/shell-unwrap.js` into
`~/.config/opencode/plugins/` and `dist/hook/shell-unwrap` into
`~/.config/opencode/`.

## Develop

```sh
bun run check
```

`check` typechecks, vets and tests the Go code, builds the binary with Go 1.26
or later and the two TypeScript entry points with Bun, and runs the black-box
tests through the built binary. Every Claude decision case is one row of
`test/decisions.tsv`, judged under `test/policy.json` both in process
(`internal/unwrap/decisions_test.go`) and through the binary
(`test/claude.test.ts`); add a row for each behaviour. The rest are the peel's golden tables
(`test/spellings.json`, `test/transparent.json`, from `go test`), the OpenCode
review, the Claude, Codex and Cursor hooks' decisions and the Pi extension's,
and the zsh oracle, which needs `/bin/zsh`. The parser is mvdan/sh, pinned in
`go.mod`. The plugin typechecks against OpenCode 2.2.6's `@opencode/schema`;
`bunfig.toml` exempts it from the global minimum release age. The live
OpenCode test lives in coding-agent-sync
(`tests/capabilities/targets/test_opencode_unwrap.py`).
