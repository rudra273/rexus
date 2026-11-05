// Parses pasted .env text into rows: KEY=value, `export KEY=value`, # comments, blank lines,
// "double quotes" (with \n \r \t \" \\ escapes), 'single quotes' and `backticks` (literal),
// quoted values that continue over several lines, and trailing "  # comments" on plain values.
// A later line with the same name wins, like it does in a real .env file.

export interface EnvRow {
  name: string
  value: string
  line: number // 1-based line where it starts
  error?: string // why it can't be added
  note?: string // something worth knowing, not a problem
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$' }

export function parseDotenv(text: string): EnvRow[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const rows: EnvRow[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    const start = i + 1
    line = line.replace(/^export\s+/, '')
    const eq = line.indexOf('=')
    if (eq < 1) {
      rows.push({ name: line.slice(0, 40), value: '', line: start, error: eq === 0 ? 'Missing a name before “=”' : 'Missing “=” — expected NAME=value' })
      continue
    }
    const name = line.slice(0, eq).trim()
    let rest = line.slice(eq + 1).trimStart()
    let value = ''
    let error: string | undefined

    const q = rest[0]
    if (q === '"' || q === "'" || q === '`') {
      // Walk to the closing quote, pulling in following lines if the value spans several.
      let buf = rest.slice(1)
      let closed = false
      let out = ''
      for (;;) {
        for (let k = 0; k < buf.length; k++) {
          const c = buf[k]
          if (q === '"' && c === '\\' && k + 1 < buf.length) {
            const n = buf[k + 1]
            out += n in ESCAPES ? ESCAPES[n] : '\\' + n
            k++
          } else if (c === q) {
            closed = true
            break
          } else {
            out += c
          }
        }
        if (closed || i + 1 >= lines.length) break
        i++
        out += '\n'
        buf = lines[i] // keep the line as written; spaces inside quotes matter
      }
      value = out
      if (!closed) error = 'Unterminated quote'
    } else {
      const hash = rest.search(/\s#/)
      if (hash >= 0) rest = rest.slice(0, hash)
      value = rest.trim()
    }

    if (!error && !NAME_RE.test(name)) error = 'Name can only use letters, numbers, dots, dashes and underscores'
    if (!error && value === '') error = 'Empty value'
    rows.push({ name, value, line: start, error })
  }

  // Same name twice: the last one wins; the earlier ones are dropped from the list.
  const lastIndex = new Map<string, number>()
  rows.forEach((r, idx) => !r.error && lastIndex.set(r.name, idx))
  const out: EnvRow[] = []
  rows.forEach((r, idx) => {
    if (!r.error && lastIndex.get(r.name) !== idx) return
    if (!r.error && rows.some((o, j) => j < idx && !o.error && o.name === r.name)) r.note = 'defined twice — the last one is used'
    out.push(r)
  })
  return out
}
