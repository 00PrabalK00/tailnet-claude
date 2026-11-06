import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatMessage, HostReport, RemoteSession } from '../types'

const PANE = 'tailnet-sessions'
const REFRESH_MS = 30_000
const DEFAULT_HOSTS: string[] = []
const CHAT_MESSAGES = 40

const reports = atom({ plugin: 'tailnet-sessions', key: 'hosts' } as const, [], {
  shape: 'hosts-2',
})
// "host/tmux-session" of the session whose chat is shown; '' = the first one found.
const selected = atom({ plugin: 'tailnet-sessions', key: 'selected' } as const, '', {
  shape: 'selected-1',
})

// Runs on the remote host (bash -s): one block per tmux pane that runs Claude Code.
// "@@name|cwd" starts a block, "@url ..." is its Remote Control link, "@msg role\ttext"
// a chat message from the session's transcript (newlines as U+2028), other lines are the
// agent rows, task rows and spinner line from the bottom of the pane.
const REMOTE_SCRIPT = String.raw`
command -v tmux >/dev/null || exit 0
tmux list-panes -a -F '#{pane_id}:#{pane_pid}' 2>/dev/null | while IFS=: read -r p pid; do
  { ps -o args= -p "$pid"; ps -o args= --ppid "$pid"; } 2>/dev/null | grep -q claude || continue
  cwd=$(tmux display -p -t "$p" '#{pane_current_path}')
  echo "@@$(tmux display -p -t "$p" '#{session_name}')|$cwd"
  d="$HOME/.claude/projects/$(printf '%s' "$cwd" | sed 's#[/.]#-#g')"
  f=$(ls -t "$d"/*.jsonl 2>/dev/null | head -1)
  u=$(tmux capture-pane -pJ -t "$p" -S -5000 | grep -o 'https://claude.ai/code/session_[A-Za-z0-9_]*' | tail -1)
  [ -z "$u" ] && [ -n "$f" ] && u=$(tail -c 2000000 "$f" | grep -o 'https://claude.ai/code/session_[A-Za-z0-9_]*' | tail -1)
  [ -n "$u" ] && echo "@url $u"
  tmux capture-pane -p -t "$p" | grep -E '^ *([◯●◉◻◼✔✻✶✳✢✽]|[0-9]+ tasks)|Waiting for' | sed 's/^ *//' | tail -14
  [ -n "$f" ] && command -v python3 >/dev/null && tail -c 3000000 "$f" | python3 -c '
import sys, json
out = []
for raw in sys.stdin:
    try:
        o = json.loads(raw)
    except Exception:
        continue
    if o.get("type") not in ("user", "assistant") or o.get("isMeta") or o.get("isSidechain"):
        continue
    c = (o.get("message") or {}).get("content")
    if isinstance(c, list):
        c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    if not isinstance(c, str):
        continue
    c = c.strip()
    if not c or c.startswith("<"):
        continue
    out.append((o["type"], c[:1500]))
for role, text in out[-'"$N"':]:
    print("@msg " + role + "\t" + text.replace("\r", "").replace("\n", " "))
'
done
`

function parse(stdout: string): RemoteSession[] {
  const out: RemoteSession[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    if (line.startsWith('@@')) {
      const [name, cwd = ''] = line.slice(2).split('|')
      out.push({ name, cwd, lines: [], chat: [] })
      continue
    }
    const cur = out[out.length - 1]
    if (!cur) continue
    if (line.startsWith('@url ')) cur.url = line.slice(5)
    else if (line.startsWith('@msg ')) {
      const tab = line.indexOf('\t')
      const role = line.slice(5, tab) === 'user' ? 'user' : 'assistant'
      const text = line.slice(tab + 1).split('\u2028').join('\n')
      const msg: ChatMessage = { role, text }
      cur.chat.push(msg)
    } else cur.lines.push(line.slice(0, 160))
  }
  return out
}

async function hostsFrom($: EngineInterface): Promise<string[]> {
  const saved = await $.store.get('hosts')
  return Array.isArray(saved) && saved.length > 0 ? (saved as string[]) : DEFAULT_HOSTS
}

let refreshing = false

async function refresh($: EngineInterface) {
  if (refreshing) return
  refreshing = true
  try {
    const hosts = await hostsFrom($)
    const at = await $.clock.now()
    const results: HostReport[] = []
    for (const host of hosts) {
      try {
        const r = await $.process.run(
          ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, `N=${CHAT_MESSAGES} bash -s`],
          { stdin: REMOTE_SCRIPT, timeoutMs: 30_000 },
        )
        if (r.exitCode !== 0 && !r.stdout.trim()) {
          const err = (r.stderr || `exit ${r.exitCode}`).trim().split('\n').pop() ?? ''
          results.push({ host, ok: false, error: err.slice(0, 120), sessions: [], at })
        } else {
          results.push({ host, ok: true, sessions: parse(r.stdout), at })
        }
      } catch (err) {
        results.push({ host, ok: false, error: String(err).slice(0, 120), sessions: [], at })
      }
    }
    await update($, reports, () => results)
  } finally {
    refreshing = false
  }
}

// Splits the current Windows Terminal window and attaches the remote tmux session there,
// so the remote Claude Code TUI is fully interactive beside this one.
async function openSplit($: EngineInterface, host: string, session: string): Promise<string> {
  const r = await $.process.run(
    ['wt', '-w', '0', 'split-pane', '-V', '--title', `${host}:${session}`,
      'ssh', '-t', host, `tmux new -A -s ${session}`],
    { timeoutMs: 15_000 },
  )
  return r.exitCode === 0
    ? `Opened ${host}:${session} in a split pane. Detach with Ctrl+b then d (don't type exit).`
    : `Could not open the split (wt exit ${r.exitCode}): ${r.stderr.trim().slice(0, 200)}`
}

export const register: Register = on => {
  on('command.run', { command: 'remote' }, async ($, e) => {
    const [host, session] = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (host && session) return { text: await openSplit($, host, session) }
    // No args (or a host alone): pick from the sessions the last refresh found.
    const found = (await read($, reports)).flatMap(r =>
      r.sessions.map(s => ({ host: r.host, name: s.name })),
    )
    const match = found.filter(x => !host || x.host === host)
    if (match.length === 1) return { text: await openSplit($, match[0].host, match[0].name) }
    if (match.length === 0) {
      return {
        text: host
          ? `No Claude session found on ${host} yet. Use /remote ${host} <tmux-session>, or refresh with /tailnet-sessions.`
          : 'No remote Claude sessions found yet. Add a host with /tailnet-sessions add <host>, or use /remote <host> <tmux-session>.',
      }
    }
    return {
      text: `Several sessions; pick one: ${match.map(x => `/remote ${x.host} ${x.name}`).join('  ')}`,
    }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'remote',
      description:
        'Open a remote Claude session (tmux) in a split of this terminal. Args: [host] [tmux-session]; none = the only session found',
    })
    await $.command.register({
      name: 'tailnet-sessions',
      description:
        'Claude sessions on your Tailscale/ssh hosts: open the pane. Args: "add <host>", "remove <host>", "hosts"',
    })
    $.clock.every(REFRESH_MS, () => refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'tailnet-sessions' }, async ($, e) => {
    const [verb, host] = (e.args ?? '').trim().split(/\s+/)
    const hosts = await hostsFrom($)
    if (verb === 'add' && host) {
      await $.store.set('hosts', [...new Set([...hosts, host])])
      void refresh($)
      return { text: `Watching ${host}.` }
    }
    if (verb === 'remove' && host) {
      await $.store.set('hosts', hosts.filter(h => h !== host))
      void refresh($)
      return { text: `Stopped watching ${host}.` }
    }
    if (verb === 'hosts') return { text: `Watching: ${hosts.join(', ')}` }
    await $.ui.open({ id: PANE, title: 'Tailnet sessions' })
    void refresh($)
    return { text: 'Tailnet sessions pane opened; refreshing.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, reports)
    const sel = await read($, selected)
    if (list.length === 0) return <Text dimColor>Checking hosts…</Text>

    const all = list.flatMap(r => r.sessions.map(s => ({ host: r.host, s })))
    const shown = all.find(x => `${x.host}/${x.s.name}` === sel) ?? all[0]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" onPress={() => void refresh($)}>Refresh</Button>
          <Button key="top" onPress={() => void $.ui.scroll({ in: PANE, to: 'start' })}>Top</Button>
          <Button key="end" onPress={() => void $.ui.scroll({ in: PANE, to: 'end' })}>End</Button>
        </Box>
        {list.map(r => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={r.ok ? 'green' : 'red'}>
              {r.host} {r.ok ? `· ${r.sessions.length} Claude session(s)` : '· unreachable'}
            </Text>
            {!r.ok && <Text dimColor>{r.error}</Text>}
            {r.ok && r.sessions.length === 0 && <Text dimColor>no Claude sessions in tmux</Text>}
            {r.sessions.map(s => {
              const id = `${r.host}/${s.name}`
              const isShown = shown !== undefined && `${shown.host}/${shown.s.name}` === id
              return (
                <Box flexDirection="column" marginLeft={1}>
                  <Button key={`sel-${id}`} onPress={() => void update($, selected, () => id)}>
                    {isShown ? '▸ ' : '  '}tmux {s.name} <Text dimColor>{s.cwd}</Text>
                  </Button>
                  <Button key={`open-${id}`} onPress={() => void openSplit($, r.host, s.name)}>
                    {'  '}⧉ open here (split terminal)
                  </Button>
                  {s.url && (
                    <Text>
                      {'  '}
                      <Link href={s.url}>open in browser / phone ↗</Link>
                    </Text>
                  )}
                  {s.lines.map(l => (
                    <Text dimColor={!/^[◯●◉✻✶✳✢✽]/.test(l)}>{'  '}{l}</Text>
                  ))}
                </Box>
              )
            })}
          </Box>
        ))}
        {shown && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              ── chat: {shown.host}/{shown.s.name} (last {shown.s.chat.length}) ──
            </Text>
            {shown.s.chat.length === 0 && <Text dimColor>no transcript found</Text>}
            {shown.s.chat.map(m => (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={m.role === 'user' ? 'cyan' : 'magenta'}>
                  {m.role === 'user' ? '❯ you' : '● claude'}
                </Text>
                <Text>{m.text}</Text>
              </Box>
            ))}
          </Box>
        )}
        <Text dimColor>
          refreshes every {REFRESH_MS / 1000}s · click a session to show its chat · /tailnet-sessions add &lt;host&gt;
        </Text>
      </Box>
    )
  })
}
