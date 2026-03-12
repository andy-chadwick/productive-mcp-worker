# productive-mcp (Cloudflare Workers)

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Productive.io](https://productive.io/), deployed on **Cloudflare Workers**. Once deployed, every team member can connect to the same shared URL from their own Claude Desktop, with no local installation required.

## What it does

This MCP server gives Claude five tools to work with your Productive.io tasks:

| Tool | Description |
| :--- | :--- |
| `list_tasks` | List all tasks in a project or template, with optional status filtering |
| `get_task` | Get the full details of a single task (title, description, relationships) |
| `create_task` | Create a new consolidated task with a full description |
| `update_task` | Rewrite a task's title, description, due date, or open/closed status |
| `delete_task` | Permanently delete a redundant task |

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Node.js](https://nodejs.org/) v18 or higher
- [Claude Desktop](https://claude.ai/download)
- A Productive.io account with API access

---

## Deployment (one-time, takes ~5 minutes)

### Step 1 — Clone the repository

```bash
git clone https://github.com/andy-chadwick/productive-mcp-worker.git
cd productive-mcp-worker
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Log in to Cloudflare

```bash
npx wrangler login
```

This will open a browser window. Log in with your Cloudflare account and authorise Wrangler.

### Step 4 — Add your Productive.io credentials as secrets

Run each command below and paste in the value when prompted:

```bash
npx wrangler secret put PRODUCTIVE_API_TOKEN
# Paste your Productive.io API token and press Enter

npx wrangler secret put PRODUCTIVE_ORG_ID
# Paste your Productive.io Organisation ID and press Enter
```

**Where to find these values:**
- **API Token:** Log in to Productive.io and go to **Account Settings > API integrations** to generate a personal token.
- **Organisation ID:** Found in your Productive.io URL when logged in: `https://app.productive.io/YOUR_ORG_ID/...`

### Step 5 — Deploy

```bash
npm run deploy
```

Wrangler will build and deploy the worker. At the end of the output you will see a URL like:

```
https://productive-mcp.YOUR-ACCOUNT.workers.dev
```

Your MCP endpoint is at: `https://productive-mcp.YOUR-ACCOUNT.workers.dev/mcp`

---

## Connecting Claude Desktop (each team member does this once)

Each person on your team needs to add one entry to their Claude Desktop configuration file. No local installation of Node.js or the repo is required.

### Find your config file

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

### Add this configuration

Open the file and add the following (replace the URL with your actual deployed worker URL):

```json
{
  "mcpServers": {
    "productive": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://productive-mcp.YOUR-ACCOUNT.workers.dev/mcp"
      ]
    }
  }
}
```

The `mcp-remote` package acts as a lightweight local proxy that bridges Claude Desktop to your remote Cloudflare Worker. It is fetched automatically by `npx` and requires no separate installation.

### Restart Claude Desktop

Fully close and reopen Claude Desktop. The Productive.io tools will appear in the tools panel.

---

## Usage

Once connected, you can ask Claude things like:

> "List all tasks in project ID 12345 and give me a summary of what is there."

> "Review all tasks in project 12345. Identify any that are redundant or overlapping, consolidate them into single well-described tasks using `create_task`, and delete the originals with `delete_task`."

> "Update the description of task 98765 to include step-by-step instructions for completing an on-page SEO audit."

---

## Updating the server

If you need to add new tools or change behaviour, edit `src/index.ts` and redeploy:

```bash
npm run deploy
```

All team members will automatically get the updated tools the next time they restart Claude Desktop. No changes needed on their end.

---

## Project structure

```
src/
  index.ts            # All MCP tools and the Cloudflare Worker entry point
worker-configuration.d.ts  # TypeScript types for Cloudflare environment bindings
wrangler.jsonc        # Cloudflare Workers deployment configuration
package.json
tsconfig.json
```

## License

MIT
