# productive-mcp

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Productive.io](https://productive.io/), deployed on **Cloudflare Workers** (free tier). Once deployed, every team member connects to the same shared URL from their Claude Desktop — no local installation required.

## What it does

This MCP server gives Claude five tools to work with your Productive.io tasks:

| Tool | Description |
| :--- | :--- |
| `list_tasks` | List all tasks in a project or template, with optional status filtering |
| `get_task` | Get the full details of a single task (title, description, relationships) |
| `create_task` | Create a new consolidated task with a full description |
| `update_task` | Rewrite a task's title, description, due date, or open/closed status |
| `delete_task` | Permanently delete a redundant task |

This server is fully **stateless** — it runs on Cloudflare's free tier and requires no Durable Objects or paid plan.

---

## Deploying via the Cloudflare Dashboard (no terminal needed)

### Step 1 — Connect your GitHub account to Cloudflare

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and log in
2. In the left sidebar, click **Workers & Pages**
3. Click the blue **Create application** button
4. Click **Connect GitHub**
5. Authorise Cloudflare to access your GitHub account
6. Select the `productive-mcp-worker` repository
7. Click **Save and Deploy**

Cloudflare will build and deploy the Worker automatically. When it finishes, you will see a URL like:
```
https://productive-mcp.YOUR-ACCOUNT.workers.dev
```

### Step 2 — Add your Productive.io credentials

After deployment, you need to add two secret environment variables:

1. In your Cloudflare dashboard, click on the `productive-mcp` Worker
2. Go to **Settings > Variables and Secrets**
3. Click **Add variable**, set the type to **Secret**, and add:
   - Name: `PRODUCTIVE_API_TOKEN` — Value: your Productive.io API token
   - Name: `PRODUCTIVE_ORG_ID` — Value: your Productive.io organisation ID
4. Click **Deploy** to apply the secrets

**Where to find these values:**
- **API Token:** In Productive.io, go to your profile picture > **Account Settings > API integrations** and generate a personal token
- **Organisation ID:** Look at the URL when logged in to Productive.io: `https://app.productive.io/YOUR_ORG_ID/...`

### Step 3 — Done

Your MCP endpoint is live at:
```
https://productive-mcp.YOUR-ACCOUNT.workers.dev/mcp
```

---

## Connecting Claude Desktop (each team member does this once)

1. Open **Claude Desktop**
2. Go to **Settings > Connectors**
3. Click **Add custom connector**
4. Paste in: `https://productive-mcp.YOUR-ACCOUNT.workers.dev/mcp`
5. Restart Claude Desktop

The Productive.io tools will now appear in Claude. No installation, no config files, no terminal.

> **Note:** The Connectors UI requires a Claude Pro, Max, Team, or Enterprise plan.

---

## Using it

Once connected, just tell Claude what you want:

> *"List all tasks in project ID 12345 and summarise what is there."*

> *"Review all tasks in project 12345. Identify anything redundant or overlapping, consolidate them into single well-described tasks, and delete the duplicates."*

> *"Update the description of task 98765 with step-by-step instructions for completing an on-page SEO audit."*

---

## Updating the server

To add new tools or change behaviour, edit `src/index.ts` and push to GitHub. Cloudflare will automatically redeploy. All team members get the update immediately with no action required on their end.

---

## Project structure

```
src/
  index.ts                   # All MCP tools and the Worker entry point
worker-configuration.d.ts    # TypeScript types for Cloudflare environment bindings
wrangler.jsonc               # Cloudflare Workers deployment configuration
package.json
tsconfig.json
```

## License

MIT
