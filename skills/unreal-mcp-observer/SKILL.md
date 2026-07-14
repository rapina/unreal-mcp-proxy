---
name: unreal-mcp-observer
description: Query and operate the Unreal MCP session recorder (unreal-mcp-proxy). Use when an Unreal MCP tool call fails (check for past similar failures and their fixes first), when a call seems unusually slow, when the user asks what happened in an Unreal editor automation session, or when you need to share a deep link to a specific call, check recorder status, or start a fresh observation session. After diagnosing a failure, record the conclusion as an annotation so future sessions can recall it.
---

# Unreal MCP Observer

Your Unreal MCP traffic is being recorded by [unreal-mcp-proxy](https://github.com/rapina/unreal-mcp-proxy).
This skill lets you query that history: past failures and how they were resolved, per-tool
latency baselines, and full request/response bodies of any call.

All commands print JSON. Run them with node (no dependencies):

```bash
node <skill-dir>/scripts/query.mjs <command> [args]
```

Set `UNREAL_MCP_PROXY_DATA_DIR` if the proxy's data directory is not `./data`
(it is printed at proxy startup). `UNREAL_MCP_PROXY_URL` defaults to `http://127.0.0.1:35100`.

## Workflow

1. **An Unreal MCP tool call failed?** Before retrying or guessing, check history:

   ```bash
   node scripts/query.mjs similar-failures "Cannot remove file as it is read only"
   ```

   Matches include any annotations left by previous sessions - a past agent may have
   already recorded the root cause and the fix (e.g. Unreal + Git LFS file locking
   makes assets read-only until `git lfs lock`).

2. **A call seems slow?** Compare against the recorded baseline:

   ```bash
   node scripts/query.mjs tool-stats save_assets
   ```

3. **Need the exact request/response of a call?**

   ```bash
   node scripts/query.mjs call-detail <callId-prefix>
   ```

4. **Diagnosed something non-obvious?** Record it for future sessions (yours and others'):

   ```bash
   node scripts/query.mjs annotate <callId> --severity error \
     --title "Asset save fails under LFS locking" \
     --summary "save_assets fails because .uasset files are checked out read-only" \
     --suggestion "run git lfs lock <path> before saving, unlock after push"
   ```

   Annotations appear in the session viewer next to the call, and are returned by
   `similar-failures` forever after. This is the memory loop: record once, recall always.

5. **Reporting a finding to the user?** Hand them a deep link instead of describing the
   call - they will see the exact request/response and your annotation in the viewer:

   ```bash
   node scripts/query.mjs link <callId>
   ```

6. **Starting a distinct piece of work** (and the user asked for a fresh recording)?

   ```bash
   node scripts/query.mjs clear
   ```

## Commands

| Command | Purpose |
| --- | --- |
| `status` | Proxy health, active session + URL, and how many sessions/calls/failures are recorded |
| `sessions [--limit N]` | Recorded sessions with call/failure counts and viewer URLs, newest first |
| `link <callId>` | Deep link for one call - share it with a human (callId prefix is enough) |
| `clear` | Roll over to a new observation session (history is kept; requires the proxy running) |
| `recent-failures [--limit N]` | Latest failed calls with error text, across all recorded sessions |
| `similar-failures <text> [--limit N]` | Past failures matching an error message (paths/ids/numbers are masked before matching) + their annotations |
| `call-detail <callId>` | One call with full request/response bodies (callId prefix is enough) |
| `tool-stats [tool]` | Per-tool call count, failure rate, p50/p95 duration |
| `annotate <callId> --title --summary [...]` | Attach a diagnosis to a call (requires the proxy to be running) |

Notes:
- Query results are advisory context. If a query fails (proxy not running, no data dir),
  continue your task without it.
- Session viewer for humans: open a session at `http://127.0.0.1:35100/sessions/<id>`,
  or open the standalone `viewer.html` and drop a `data/sessions/*.jsonl` file into it.
