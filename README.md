# agent-chat

A local chat page wired to the **Claude Agent SDK** — the same agent loop and
built-in tools as the Claude Code CLI, in a browser tab, with live model and
effort selection.

```bash
cd ~/projects/agent-chat
node server.mjs --cwd ~/projects/some-project
# → http://127.0.0.1:8787
```

| flag | default | meaning |
|---|---|---|
| `--port` | `8787` | listen port (loopback only) |
| `--cwd` | shell cwd | the directory the agent reads and writes |
| `--model` | CLI default | starting model; changeable in the page |
| `--effort` | CLI default | starting effort; changeable in the page |

## ⚠️ It runs in bypass-permissions mode

As requested, the session runs with `permissionMode: 'bypassPermissions'`
(plus the `allowDangerouslySkipPermissions` flag the SDK requires alongside it).
**Every tool call executes with no prompt** — Bash, Write, Edit, WebFetch — under
your account, with your credentials, against `--cwd`.

Anyone who can reach the port gets an unprompted shell. The server binds to
`127.0.0.1` only; keep it that way, and don't put it behind a tunnel or reverse
proxy. To get approval prompts back, drop both permission lines in
`startSession()` — `'default'` is the SDK's prompting mode.

## How it works

- **One long-lived session, streaming input mode.** `query()` is handed a
  pushable async iterable rather than a string, so the CLI subprocess stays up
  across turns and keeps its context. This is also what makes the live controls
  possible: `setModel()` and `applyFlagSettings({effortLevel})` exist *only* in
  streaming input mode, so a query-per-message design could not change model or
  effort without dropping the conversation.
- **SSE out, POST in.** The browser holds one `GET /api/events` stream and POSTs
  turns to `/api/send`. Agent output is continuous and not request-shaped.
- **The model list is real.** `/api/models` returns the SDK's `supportedModels()`,
  so the dropdown carries whatever this CLI build actually offers, and the effort
  dropdown is populated per model from `supportedEffortLevels` — a model without
  effort support disables the control instead of offering levels that silently
  do nothing.
- **Rendering split.** Text and thinking stream live from `stream_event` deltas;
  tool calls and results come from the finalized `assistant`/`user` messages,
  where a tool's input is complete rather than partial JSON. Nothing is rendered
  twice, and model output is written with `textContent` — never `innerHTML`.

## Endpoints

| method | path | purpose |
|---|---|---|
| GET | `/api/events` | SSE: session, deltas, tool calls, results |
| GET | `/api/models` | live model list + per-model effort levels |
| POST | `/api/send` | `{text}` — queue a user turn |
| POST | `/api/model` | `{model}` — switch model mid-session |
| POST | `/api/effort` | `{effort}` — `low`…`max`, session-scoped |
| POST | `/api/interrupt` | stop the current turn |

## Scope

Single session per server process, held in memory — one browser, one
conversation, gone on restart. Sessions are persisted by the SDK, so
`resume`/`forkSession` in `startSession()` is the hook if history should
survive a restart. No auth on the endpoints, by the same reasoning as the
loopback bind.
