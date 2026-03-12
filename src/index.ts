import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// ─── Types ────────────────────────────────────────────────────────────────────

type TaskAttributes = {
  title: string;
  description?: string | null;
  closed?: boolean;
  due_date?: string | null;
  task_number?: string;
};

type TaskRelationships = {
  project?: { data?: { id: string } };
  task_list?: { data?: { id: string } };
  assignee?: { data?: { id: string } };
};

type Task = {
  id: string;
  attributes: TaskAttributes;
  relationships?: TaskRelationships;
};

// ─── Productive.io API client ─────────────────────────────────────────────────

const BASE_URL = 'https://api.productive.io/api/v2';

async function productiveRequest<T>(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${BASE_URL}/${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'X-Auth-Token': env.PRODUCTIVE_API_TOKEN,
      'X-Organization-Id': env.PRODUCTIVE_ORG_ID,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Productive API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = (await response.json()) as { errors?: Array<{ detail?: string }> };
      if (errorData.errors?.[0]?.detail) message = errorData.errors[0].detail;
    } catch {
      // ignore JSON parse errors on error responses
    }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as unknown as T;
  return response.json() as Promise<T>;
}

function formatTask(task: Task): string {
  const projectId = task.relationships?.project?.data?.id;
  const taskListId = task.relationships?.task_list?.data?.id;
  const assigneeId = task.relationships?.assignee?.data?.id;
  const status = task.attributes.closed ? 'closed' : 'open';

  let text = `Title: ${task.attributes.title}\n`;
  text += `ID: ${task.id}\n`;
  text += `Status: ${status}\n`;
  if (task.attributes.task_number) text += `Task Number: ${task.attributes.task_number}\n`;
  if (task.attributes.description) text += `Description: ${task.attributes.description}\n`;
  if (task.attributes.due_date) text += `Due Date: ${task.attributes.due_date}\n`;
  if (projectId) text += `Project ID: ${projectId}\n`;
  if (taskListId) text += `Task List ID: ${taskListId}\n`;
  if (assigneeId) text += `Assignee ID: ${assigneeId}\n`;
  return text;
}

// ─── MCP Server factory ───────────────────────────────────────────────────────
// A new server instance is created per request (stateless mode).

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'productive-mcp',
    version: '1.0.0',
  });

  // ── 1. list_tasks ──────────────────────────────────────────────────────────
  server.tool(
    'list_tasks',
    'List tasks from Productive.io. Supports filtering by assignee, project, task list, status, due date, overdue status, and free-text search. Returns task IDs, titles, descriptions, assignee IDs, and status.',
    {
      project_id: z.string().optional().describe('Filter tasks by project ID (can be comma-separated list of IDs)'),
      task_list_id: z.string().optional().describe('Filter tasks by task list ID'),
      assignee_id: z.string().optional().describe('Filter tasks by assignee person ID. Use this to find tasks assigned to a specific person.'),
      status: z.enum(['open', 'closed']).optional().describe('Filter by open or closed status'),
      overdue: z.boolean().optional().describe('Set to true to return only overdue tasks'),
      due_date_before: z.string().optional().describe('Return tasks due before this date (YYYY-MM-DD)'),
      due_date_after: z.string().optional().describe('Return tasks due after this date (YYYY-MM-DD)'),
      query: z.string().optional().describe('Free-text search across task titles and descriptions'),
      limit: z.number().min(1).max(200).default(50).optional().describe('Number of tasks to return (max 200, default 50)'),
      page: z.number().min(1).default(1).optional().describe('Page number for pagination'),
    },
    async (params) => {
      const query = new URLSearchParams();
      if (params.project_id) query.set('filter[project_id]', params.project_id);
      if (params.task_list_id) query.set('filter[task_list_id]', params.task_list_id);
      if (params.assignee_id) query.set('filter[assignee_id]', params.assignee_id);
      if (params.status === 'open') query.set('filter[status]', '1');
      if (params.status === 'closed') query.set('filter[status]', '2');
      if (params.overdue) query.set('filter[overdue_status]', '2');
      if (params.due_date_before) query.set('filter[due_date_before]', params.due_date_before);
      if (params.due_date_after) query.set('filter[due_date_after]', params.due_date_after);
      if (params.query) query.set('filter[query]', params.query);
      query.set('page[size]', String(params.limit ?? 50));
      query.set('page[number]', String(params.page ?? 1));

      const response = await productiveRequest<{ data: Task[]; meta: { total_count: number } }>(
        env,
        `tasks?${query.toString()}`
      );

      if (!response?.data?.length) {
        return { content: [{ type: 'text', text: 'No tasks found matching the criteria.' }] };
      }

      const lines = response.data.map((task) => {
        const status = task.attributes.closed ? '[closed]' : '[open]';
        const desc = task.attributes.description
          ? `\n   Description: ${task.attributes.description.slice(0, 120)}${task.attributes.description.length > 120 ? '...' : ''}`
          : '';
        return `- ${status} [ID: ${task.id}] ${task.attributes.title}${desc}`;
      });

      const total = response.meta?.total_count ?? response.data.length;
      const summary = `Found ${total} task(s). Showing ${response.data.length}:\n\n`;
      return { content: [{ type: 'text', text: summary + lines.join('\n') }] };
    }
  );

  // ── 2. get_task ────────────────────────────────────────────────────────────
  server.tool(
    'get_task',
    'Get the full details of a single task by its ID, including title, description, status, and relationships.',
    {
      task_id: z.string().min(1).describe('The Productive.io task ID'),
    },
    async ({ task_id }) => {
      const response = await productiveRequest<{ data: Task }>(
        env,
        `tasks/${task_id}?include=task_list`
      );
      return { content: [{ type: 'text', text: `Task Details:\n\n${formatTask(response.data)}` }] };
    }
  );

  // ── 3. create_task ─────────────────────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a new task in Productive.io. Use this to create a consolidated, streamlined task that replaces multiple redundant tasks.',
    {
      title: z.string().min(1).describe('Task title'),
      description: z.string().optional().describe('Full task description (markdown supported)'),
      project_id: z.string().min(1).describe('The project ID to create the task in'),
      task_list_id: z.string().min(1).describe('The task list ID to place the task in'),
      due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
    },
    async (params) => {
      const body = {
        data: {
          type: 'tasks',
          attributes: {
            title: params.title,
            ...(params.description ? { description: params.description } : {}),
            ...(params.due_date ? { due_date: params.due_date } : {}),
          },
          relationships: {
            project: { data: { type: 'projects', id: params.project_id } },
            task_list: { data: { type: 'task_lists', id: params.task_list_id } },
          },
        },
      };

      const response = await productiveRequest<{ data: Task }>(env, 'tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return { content: [{ type: 'text', text: `Task created successfully!\n\n${formatTask(response.data)}` }] };
    }
  );

  // ── 4. update_task ─────────────────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update an existing task in Productive.io. Can update the title, description, due date, and open/closed status. Use this to rewrite and improve task titles and descriptions as part of template streamlining.',
    {
      task_id: z.string().min(1).describe('The Productive.io task ID to update'),
      title: z.string().optional().describe('New task title'),
      description: z.string().optional().describe('New task description (markdown supported)'),
      due_date: z.string().optional().describe('New due date in YYYY-MM-DD format'),
      closed: z.boolean().optional().describe('Set to true to close the task, false to reopen it'),
    },
    async ({ task_id, ...payload }) => {
      if (Object.keys(payload).length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No fields to update were provided. Please supply at least one of: title, description, due_date, closed.',
          }],
        };
      }

      const body = {
        data: {
          type: 'tasks',
          id: task_id,
          attributes: payload,
        },
      };

      const response = await productiveRequest<{ data: Task }>(env, `tasks/${task_id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      return { content: [{ type: 'text', text: `Task updated successfully!\n\n${formatTask(response.data)}` }] };
    }
  );

  // ── 5. delete_task ─────────────────────────────────────────────────────────
  server.tool(
    'delete_task',
    'Permanently delete a task from Productive.io. Use this to remove redundant or duplicate tasks after their content has been merged into a consolidated task. This action cannot be undone.',
    {
      task_id: z.string().min(1).describe('The Productive.io task ID to delete'),
    },
    async ({ task_id }) => {
      await productiveRequest<void>(env, `tasks/${task_id}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Task ${task_id} has been permanently deleted.` }] };
    }
  );

  return server;
}

// ─── Cloudflare Worker entry point ───────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({ name: 'productive-mcp', status: 'ok', endpoint: '/mcp' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/mcp') {
      // Create a fresh server and stateless transport per request
      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode — no session tracking needed
      });

      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
