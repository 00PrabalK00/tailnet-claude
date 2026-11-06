# tailnet-claude

**Every Claude Code session on your Tailscale machines, one keystroke away.**

A Claude Code mod (plugin `tailnet-sessions`) for people who run Claude Code sessions on other
machines (a home server, a Jetson, a cloud box on Tailscale, anything you can `ssh` to) inside `tmux`.

- **A pane beside the chat** lists, for every watched host, each Claude Code session running in tmux:
  its tmux name and working directory, its Remote Control link (clickable), the running subagents
  and task list from the bottom of its screen, and the session's recent chat (click a session to
  show its chat; the pane scrolls). It refreshes every 30 seconds.
- **`/remote`** splits your current Windows Terminal window and attaches the remote tmux session in
  the new pane, so you get the full, interactive Claude Code TUI of the other machine beside this one.
  Each session in the pane also has an "open here" button that does the same.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install tailnet-sessions --marketplace 00PrabalK00/tailnet-claude
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install tailnet-sessions --marketplace 00PrabalK00/tailnet-claude
```

## Setup

1. Each host must be reachable with `ssh <host>` without a password prompt (key auth; an alias in
   `~/.ssh/config` works). Tailscale SSH or plain OpenSSH both work.
2. Run your remote Claude Code sessions inside tmux (`tmux new -s mywork`, then `claude`).
3. `python3` on the host is used to read the session's recent chat from its transcript; without it
   the pane still shows the sessions and agents.
4. `/remote` uses Windows Terminal (`wt split-pane`). On other terminals, run
   `ssh -t <host> tmux new -A -s <session>` in a split yourself.

## Commands

- `/tailnet-sessions` opens the pane and refreshes it.
- `/tailnet-sessions add <host>` / `remove <host>` changes the watched ssh hosts; `hosts` lists them.
- `/remote` opens the only session found; `/remote <host> <tmux-session>` opens a specific one
  (it creates the tmux session if missing). Leave the split with `Ctrl+b` then `d` (detach) so the
  remote Claude keeps running.

## How it works

Every refresh runs one `ssh <host> bash -s` per host. The script lists tmux panes whose process
tree contains `claude`, captures the bottom of each pane, and reads the newest transcript under
`~/.claude/projects/<cwd>/` for the recent chat and the Remote Control link. Nothing is installed
on the remote machine and nothing leaves your ssh connection.

## License

MIT
