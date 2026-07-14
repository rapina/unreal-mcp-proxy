# unreal-mcp-proxy

**Flight recorder for [Epic's Unreal MCP](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor) (UE 5.8+).**
A transparent local proxy that records every MCP call your AI agent makes to the Unreal
Editor, an offline single-file viewer to inspect sessions, and a skill that lets the agent
query its own history. Codename: *Henneth*.

Unreal Engine 5.8 ships an MCP server inside the editor, so agents like Claude Code and
Cursor can drive it. What it doesn't ship is any way to see what actually happened:
the official debugging story is an output-log filter. This fills that gap.

- **Session recording** - every `tools/call` with request/response bodies, timing, and
  errors, appended to plain JSONL. An observation session survives editor *and* proxy
  restarts; it only rolls over when you explicitly clear it.
- **Offline viewer** - one self-contained `viewer.html`. Double-click it, drop a session
  file in, and you get a thread timeline, a tool-flow graph with call-order replay, and
  unwrapped request/response views (no `params.arguments.arguments` archaeology, no
  escaped-JSON-inside-SSE archaeology). The running proxy also serves it live at
  `/sessions/{id}` with shareable `?call=` deep links.
- **Agent skill** - `similar-failures`, `tool-stats`, `call-detail`, `annotate`. When a
  tool call fails, the agent checks whether a past session already diagnosed it, and
  records new diagnoses for future sessions. Record once, recall always.
- **Unreal-aware** - unwraps the `call_tool(toolset_name, tool_name, arguments)` envelope,
  extracts target actors into the flow graph, and normalizes the completion boundary of
  Unreal's SSE responses (the editor keeps the connection open until keep-alive expires;
  without this every call looks ~15s slow).
- Zero runtime dependencies. Secrets in headers/bodies are redacted before anything is
  written to disk.

## Quick start

Start the Unreal Editor with its MCP server (UE 5.8+):

```text
UnrealEditor.exe <project> -ModelContextProtocolStartServer
```

Run the proxy in front of it:

```bash
npx unreal-mcp-proxy
# unreal-mcp-proxy listening: http://127.0.0.1:35100/mcp -> http://127.0.0.1:35000/mcp
# session: http://127.0.0.1:35100/sessions/<session-id>
```

Point your agent at the proxy instead of the editor (`.mcp.json`):

```json
{
  "mcpServers": {
    "unreal-mcp": { "type": "http", "url": "http://127.0.0.1:35100/mcp" }
  }
}
```

That's it. Open the session URL to watch calls live, or open `viewer.html` and drop a
`data/sessions/*.jsonl` file to inspect a recording offline.

## Configuration

Environment variables (or a JSON file via `UNREAL_MCP_PROXY_CONFIG`):

| Variable | Default | |
| --- | --- | --- |
| `UNREAL_MCP_UPSTREAM_URL` | `http://127.0.0.1:35000/mcp` | The editor's MCP endpoint |
| `UNREAL_MCP_PROXY_PORT` | `35100` | Proxy listen port |
| `UNREAL_MCP_PROXY_HOST` | `127.0.0.1` | Bind `0.0.0.0` to share session links on your LAN |
| `UNREAL_MCP_PROXY_DATA_DIR` | `./data` | Where sessions are recorded |

`POST /api/session/clear` starts a new observation session (history is kept).

## Event sinks (central monitoring)

Recording is local-first, but every event can also be forwarded elsewhere - a team
server, a log shipper, a queue - through **sinks**. A sink is an ES module listed in
the config; the proxy loads it at startup and feeds it every recorded event:

```json
{ "sinks": ["./team-sink.mjs"] }
```

```js
// team-sink.mjs - forward events to a central collector, resilient to its downtime
export default function createSink({ config, log }) {
  const queue = [];
  const timer = setInterval(async () => {
    if (!queue.length) return;
    const batch = queue.splice(0, 100);
    try {
      await fetch("https://collector.internal/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch })
      });
    } catch {
      queue.unshift(...batch); // collector down: keep and retry next tick
    }
  }, 5000);
  return {
    onEvent(event) { queue.push(event); },
    close() { clearInterval(timer); }
  };
}
```

Sink contract:

- `onEvent(event)` is awaited inside the recording write chain, so a durable sink can
  persist events in order. A sink that **throws never breaks recording** (errors are
  swallowed per event). A sink that fails to **load** fails startup - misconfigured
  monitoring should be visible.
- `close()` (optional) runs on shutdown.
- Relative sink paths resolve against the config file's directory (or cwd without one).
  `UNREAL_MCP_PROXY_SINKS` (comma-separated) works too.
- Writing one in TypeScript? `import type { SinkFactory } from "unreal-mcp-proxy"` -
  the package ships a library entry with all types.

## Agent skill

Copy (or symlink) `skills/unreal-mcp-observer/` into your agent's skill directory
(for Claude Code: `.claude/skills/`). The skill teaches the agent to:

1. check `similar-failures` before retrying a failed Unreal tool call - past sessions may
   have already recorded the root cause and fix (asset read-only under LFS locking, etc.),
2. compare slow calls against recorded `tool-stats` baselines,
3. `annotate` new diagnoses so they are recalled forever after.

The query CLI also works standalone:

```bash
node skills/unreal-mcp-observer/scripts/query.mjs recent-failures
node skills/unreal-mcp-observer/scripts/query.mjs similar-failures "as it is read only"
```

## API

| Route | |
| --- | --- |
| `POST /mcp` | Transparent MCP forwarding (this is what agents talk to) |
| `GET /health` | Proxy + active session status |
| `GET /api/session` · `POST /api/session/clear` | Active observation session |
| `GET /api/sessions/{id}` | Session model (calls, graph, annotations) |
| `GET /api/sessions/{id}/events` | Raw recorded events |
| `GET /api/sessions/{id}/stream` | SSE change stream |
| `POST /api/sessions/{id}/annotations` | Attach a diagnosis to a call |
| `GET /sessions/{id}` · `GET /viewer` | Viewer (served mode) |

## Development

TypeScript throughout. Node 20+ to run; Node 24+ to develop (tests run `.ts` natively).

```bash
npm install
npm run build       # tsc -> dist, viewer -> dist/viewer.html
npm test
npm run typecheck
```

## License

MIT
