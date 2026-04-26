# Canvas MCP

MCP server that exposes Canvas LMS as tools — courses, modules, files, pages,
assignments, submissions/grades, announcements, upcoming deadlines, and syllabus.

Designed to be consumed by Ada (chat tool loop / edge functions) and any other
MCP client (Claude Desktop, Cursor, etc.).

## Setup

```bash
cd mcps/canvas
npm install
npm run build
```

Create `.env` (or pass through your MCP client config):

```env
CANVAS_BASE_URL=https://canvas.asu.edu/api/v1
CANVAS_TOKEN=your_canvas_personal_access_token
```

Generate the token in Canvas: **Account → Settings → New Access Token**.

## Run

Stdio transport (default for MCP clients):

```bash
CANVAS_BASE_URL=... CANVAS_TOKEN=... node dist/index.js
```

## Tools

| Tool | Purpose |
|------|---------|
| `list_courses` | Active enrollments with term + dates |
| `get_course` | Single course incl. syllabus body |
| `list_modules` | Modules with items inlined |
| `list_module_items` | Items in one module |
| `get_file_metadata` | File info + download URL |
| `get_file_text` | Download file body as UTF-8 text (truncated) |
| `list_pages` / `get_page` | Wiki pages |
| `list_assignments` / `get_assignment` | Assignments by due date |
| `list_my_submissions` | Current student's grades + late/missing |
| `list_announcements` | Announcements across courses |
| `list_upcoming` | Upcoming events for the user |
| `get_syllabus` | Syllabus HTML |

## Claude Desktop config

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["/absolute/path/to/ada/mcps/canvas/dist/index.js"],
      "env": {
        "CANVAS_BASE_URL": "https://canvas.asu.edu/api/v1",
        "CANVAS_TOKEN": "..."
      }
    }
  }
}
```

## Cloudflare Workers (HTTP transport)

`src/worker.ts` exposes the same toolset over HTTP for hosting on Cloudflare
Workers. Deploy with:

```bash
npx wrangler deploy
```

Set the secrets once via `wrangler secret put`:

```bash
echo "https://canvas.asu.edu/api/v1" | npx wrangler secret put CANVAS_BASE_URL
echo "your_canvas_token"            | npx wrangler secret put CANVAS_TOKEN
```

The Worker accepts JSON-RPC `tools/list` and `tools/call` POSTs. Per-request
token override is supported via the `Authorization: Bearer <token>` header,
falling back to the `CANVAS_TOKEN` secret when absent — useful for
multi-tenant deployments.

## Notes

- Canvas pagination is followed automatically via the `Link` header up to per-call caps.
- `get_file_text` decodes as UTF-8; binary formats (PDF, DOCX) need upstream extraction.
- Single-tenant by env var. For multi-user (Ada), spawn one process per user
  *or* swap stdio for an HTTP transport that accepts a per-request token.
