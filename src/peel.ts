/**
 * Every spelling of a shell command with its launch prefixes peeled away.
 *
 * OpenCode matches a shell rule against a command's raw text, so a deny for
 * `rm *` misses `timeout 5 rm -rf x`, `FOO=1 rm -rf x`, and `/bin/rm -rf x`.
 * Peeling yields the text each of those commands actually runs, sliced from
 * the original so its quoting is exactly what OpenCode would have matched.
 */

interface Word {
  readonly value: string
  readonly start: number
  readonly end: number
}

interface Wrapper {
  /** Options that consume the next word as their value. */
  readonly values?: readonly string[]
  /** Positional words between the options and the command. */
  readonly positionals?: number
  /** Options that make the wrapper report on the command instead of running it. */
  readonly lookups?: readonly string[]
  /** Accepts `NAME=value` words before the command. */
  readonly assignments?: boolean
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
// A redirect before the command: `> out rm`, `2>&1 rm`. An empty target group
// means the target is the next word.
const REDIRECT = /^(?:\d+|&)?(?:>>|>&|>\||<>|<&|>|<)(.*)$/s

// Option tables follow the GNU and BSD manuals; an unlisted option is taken
// as a flag without a value.
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  builtin: {},
  command: { lookups: ["-v", "-V"] },
  doas: { values: ["-a", "-C", "-u"] },
  env: {
    values: ["-a", "-C", "-P", "-S", "-u", "--argv0", "--chdir", "--split-string", "--unset"],
    assignments: true,
  },
  exec: { values: ["-a"] },
  nice: { values: ["-n", "--adjustment"] },
  nocorrect: {},
  noglob: {},
  nohup: {},
  stdbuf: { values: ["-e", "-i", "-o", "--error", "--input", "--output"] },
  sudo: {
    assignments: true,
    values: [
      "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
      "--chdir", "--chroot", "--close-from", "--command-timeout", "--group",
      "--host", "--other-user", "--prompt", "--role", "--type", "--user",
    ],
  },
  time: { values: ["-f", "-o", "--format", "--output"] },
  timeout: {
    values: ["-k", "--kill-after", "-s", "--signal"],
    positionals: 1,
  },
  xargs: {
    values: [
      "-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s",
      "--arg-file", "--delimiter", "--max-args", "--max-chars", "--max-lines",
      "--max-procs", "--process-slot-var",
    ],
  },
}

/** Splits one command into words, honouring quotes and backslashes. */
function words(text: string): Word[] {
  const found: Word[] = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index]!)) index++
    if (index >= text.length) break
    const start = index
    let value = ""
    while (index < text.length && !/\s/.test(text[index]!)) {
      const char = text[index]!
      if (char === "'") {
        const close = text.indexOf("'", index + 1)
        const stop = close === -1 ? text.length : close
        value += text.slice(index + 1, stop)
        index = stop + 1
      } else if (char === '"') {
        index++
        while (index < text.length && text[index] !== '"') {
          if (text[index] === "\\" && index + 1 < text.length) index++
          value += text[index]
          index++
        }
        index++
      } else if (char === "\\" && index + 1 < text.length) {
        value += text[index + 1]
        index += 2
      } else {
        value += char
        index++
      }
    }
    found.push({ value, start, end: Math.min(index, text.length) })
  }
  return found
}

function basename(program: string): string {
  return program.slice(program.lastIndexOf("/") + 1)
}

/** The index of the command a wrapper runs, or undefined when it runs none. */
function wrapped(list: readonly Word[], wrapper: Wrapper): number | undefined {
  let index = 1
  let positionals = wrapper.positionals ?? 0
  while (index < list.length) {
    const value = list[index]!.value
    if (value === "--") return index + 1 < list.length ? index + 1 : undefined
    if (wrapper.lookups?.includes(value)) return undefined
    if (value.startsWith("-") && value !== "-") {
      index += wrapper.values?.includes(value) ? 2 : 1
    } else if (wrapper.assignments && ASSIGNMENT.test(value)) {
      index++
    } else if (positionals > 0) {
      positionals--
      index++
    } else {
      return index
    }
  }
  return undefined
}

/** The spellings one prefix layer below `text`. */
function peelOnce(text: string): string[] {
  const list = words(text)
  const head = list[0]
  if (!head) return []
  const raw = text.slice(head.start, head.end)
  const redirect = REDIRECT.exec(raw)
  if (redirect) {
    const next = list[redirect[1] ? 1 : 2]
    return next ? [text.slice(next.start)] : []
  }
  if (ASSIGNMENT.test(head.value)) return list[1] ? [text.slice(list[1].start)] : []
  const found: string[] = []
  // `/bin/rm`, `\rm`, and `"rm"` all run `rm`.
  const program = basename(head.value)
  if (program && program !== raw) found.push(program + text.slice(head.end))
  const wrapper = WRAPPERS[program]
  if (wrapper) {
    const index = wrapped(list, wrapper)
    if (index !== undefined) found.push(text.slice(list[index]!.start))
    // `env -S 'rm -rf x'` runs its split string as the command.
    if (program === "env") {
      const split = list.findIndex((word) => word.value === "-S" || word.value === "--split-string")
      const payload = split > 0 ? list[split + 1] : undefined
      if (payload) found.push(payload.value + text.slice(payload.end))
    }
  }
  return found.map((spelling) => spelling.trim()).filter(Boolean)
}

/** Every distinct peeled spelling of `command`, excluding the command itself. */
export function spellings(command: string): string[] {
  const original = command.trim()
  const seen = new Set([original])
  const pending = [original]
  while (pending.length > 0) {
    for (const spelling of peelOnce(pending.pop()!)) {
      if (!seen.has(spelling)) {
        seen.add(spelling)
        pending.push(spelling)
      }
    }
  }
  seen.delete(original)
  return [...seen]
}
