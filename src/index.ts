import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// ─── Shared API client ────────────────────────────────────────────────────────

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
    } catch { /* ignore */ }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as unknown as T;
  return response.json() as Promise<T>;
}

function paginationParams(limit?: number, page?: number): URLSearchParams {
  const q = new URLSearchParams();
  q.set('page[size]', String(limit ?? 50));
  q.set('page[number]', String(page ?? 1));
  return q;
}

function formatMeta(meta: { total_count?: number }, shown: number): string {
  const total = meta?.total_count ?? shown;
  return `Found ${total} record(s). Showing ${shown}.\n\n`;
}

// ─── MCP Server factory ───────────────────────────────────────────────────────

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'productive-mcp', version: '2.0.0' });

  // ════════════════════════════════════════════════════════════════════════════
  // TASKS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_tasks',
    'List tasks from Productive.io. Filter by project, assignee, status, due date, or free-text search.',
    {
      project_id: z.string().optional().describe('Filter by project ID'),
      task_list_id: z.string().optional().describe('Filter by task list ID'),
      assignee_id: z.string().optional().describe('Filter by assignee person ID'),
      status: z.enum(['open', 'closed']).optional().describe('Filter by open or closed status'),
      overdue: z.boolean().optional().describe('Return only overdue tasks'),
      due_date_before: z.string().optional().describe('Tasks due before this date (YYYY-MM-DD)'),
      due_date_after: z.string().optional().describe('Tasks due after this date (YYYY-MM-DD)'),
      query: z.string().optional().describe('Free-text search across task titles and descriptions'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.project_id) q.set('filter[project_id]', params.project_id);
      if (params.task_list_id) q.set('filter[task_list_id]', params.task_list_id);
      if (params.assignee_id) q.set('filter[assignee_id]', params.assignee_id);
      if (params.status === 'open') q.set('filter[status]', '1');
      if (params.status === 'closed') q.set('filter[status]', '2');
      if (params.overdue) q.set('filter[overdue_status]', '2');
      if (params.due_date_before) q.set('filter[due_date_before]', params.due_date_before);
      if (params.due_date_after) q.set('filter[due_date_after]', params.due_date_after);
      if (params.query) q.set('filter[query]', params.query);

      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `tasks?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No tasks found.' }] };

      const lines = res.data.map((t: Record<string, unknown>) => {
        const a = t.attributes as Record<string, unknown>;
        const r = t.relationships as Record<string, { data?: { id: string } }>;
        const status = a.closed ? '[closed]' : '[open]';
        const assignee = r?.assignee?.data?.id ? ` assignee:${r.assignee.data.id}` : '';
        const due = a.due_date ? ` due:${a.due_date}` : '';
        const desc = a.description ? `\n   ${String(a.description).slice(0, 150)}` : '';
        return `- ${status} [ID:${t.id}]${assignee}${due} ${a.title}${desc}`;
      });

      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  server.tool(
    'get_task',
    'Get full details of a single task by ID.',
    { task_id: z.string().min(1) },
    async ({ task_id }) => {
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, `tasks/${task_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'create_task',
    'Create a new task in Productive.io.',
    {
      title: z.string().min(1),
      description: z.string().optional(),
      project_id: z.string().min(1),
      task_list_id: z.string().min(1),
      assignee_id: z.string().optional().describe('Person ID to assign the task to'),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
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
            ...(params.assignee_id ? { assignee: { data: { type: 'people', id: params.assignee_id } } } : {}),
          },
        },
      };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, 'tasks', { method: 'POST', body: JSON.stringify(body) });
      const a = res.data.attributes as Record<string, unknown>;
      return { content: [{ type: 'text', text: `Task created! ID: ${res.data.id}, Title: ${a.title}` }] };
    }
  );

  server.tool(
    'update_task',
    'Update a task title, description, due date, assignee, or open/closed status.',
    {
      task_id: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
      closed: z.boolean().optional(),
      assignee_id: z.string().optional().describe('Person ID to reassign the task to'),
    },
    async ({ task_id, assignee_id, ...attrs }) => {
      const relationships = assignee_id
        ? { assignee: { data: { type: 'people', id: assignee_id } } }
        : undefined;

      const body = {
        data: {
          type: 'tasks',
          id: task_id,
          attributes: attrs,
          ...(relationships ? { relationships } : {}),
        },
      };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, `tasks/${task_id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const a = res.data.attributes as Record<string, unknown>;
      return { content: [{ type: 'text', text: `Task ${task_id} updated. Title: ${a.title}` }] };
    }
  );

  server.tool(
    'delete_task',
    'Permanently delete a task. This cannot be undone.',
    { task_id: z.string().min(1) },
    async ({ task_id }) => {
      await productiveRequest<void>(env, `tasks/${task_id}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Task ${task_id} deleted.` }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TASK LISTS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_task_lists',
    'List task lists (sections/columns) within a project.',
    {
      project_id: z.string().optional().describe('Filter by project ID'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.project_id) q.set('filter[project_id]', params.project_id);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `task_lists?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No task lists found.' }] };
      const lines = res.data.map((tl: Record<string, unknown>) => {
        const a = tl.attributes as Record<string, unknown>;
        return `- [ID:${tl.id}] ${a.name}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  server.tool(
    'create_task_list',
    'Create a new task list (section) within a project.',
    {
      name: z.string().min(1),
      project_id: z.string().min(1),
    },
    async (params) => {
      const body = {
        data: {
          type: 'task_lists',
          attributes: { name: params.name },
          relationships: { project: { data: { type: 'projects', id: params.project_id } } },
        },
      };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, 'task_lists', { method: 'POST', body: JSON.stringify(body) });
      const a = res.data.attributes as Record<string, unknown>;
      return { content: [{ type: 'text', text: `Task list created! ID: ${res.data.id}, Name: ${a.name}` }] };
    }
  );

  server.tool(
    'update_task_list',
    'Rename a task list.',
    {
      task_list_id: z.string().min(1),
      name: z.string().min(1),
    },
    async ({ task_list_id, name }) => {
      const body = { data: { type: 'task_lists', id: task_list_id, attributes: { name } } };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, `task_lists/${task_list_id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const a = res.data.attributes as Record<string, unknown>;
      return { content: [{ type: 'text', text: `Task list ${task_list_id} renamed to: ${a.name}` }] };
    }
  );

  server.tool(
    'delete_task_list',
    'Delete a task list and all its tasks. Cannot be undone.',
    { task_list_id: z.string().min(1) },
    async ({ task_list_id }) => {
      await productiveRequest<void>(env, `task_lists/${task_list_id}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Task list ${task_list_id} deleted.` }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PROJECTS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_projects',
    'List projects in the organisation. Can filter to show only templates.',
    {
      template: z.boolean().optional().describe('Set to true to list only project templates'),
      company_id: z.string().optional().describe('Filter by client company ID'),
      query: z.string().optional().describe('Search by project name'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.template !== undefined) q.set('filter[template]', params.template ? 'true' : 'false');
      if (params.company_id) q.set('filter[company_id]', params.company_id);
      if (params.query) q.set('filter[name]', params.query);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `projects?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No projects found.' }] };
      const lines = res.data.map((p: Record<string, unknown>) => {
        const a = p.attributes as Record<string, unknown>;
        const tmpl = a.template ? ' [TEMPLATE]' : '';
        return `- [ID:${p.id}]${tmpl} ${a.name}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  server.tool(
    'get_project',
    'Get full details of a single project by ID.',
    { project_id: z.string().min(1) },
    async ({ project_id }) => {
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, `projects/${project_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'update_project',
    'Update a project name, description, or other attributes.',
    {
      project_id: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ project_id, ...attrs }) => {
      const body = { data: { type: 'projects', id: project_id, attributes: attrs } };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, `projects/${project_id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const a = res.data.attributes as Record<string, unknown>;
      return { content: [{ type: 'text', text: `Project ${project_id} updated. Name: ${a.name}` }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PEOPLE / USERS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_people',
    'List people (team members) in the organisation. Use this to find a person\'s ID for filtering tasks by assignee.',
    {
      query: z.string().optional().describe('Search by name or email'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.query) q.set('filter[query]', params.query);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `people?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No people found.' }] };
      const lines = res.data.map((p: Record<string, unknown>) => {
        const a = p.attributes as Record<string, unknown>;
        return `- [ID:${p.id}] ${a.first_name} ${a.last_name} <${a.email}>`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // COMMENTS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_comments',
    'List comments on a task.',
    {
      task_id: z.string().min(1).describe('The task ID to get comments for'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      q.set('filter[task_id]', params.task_id);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `comments?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No comments found.' }] };
      const lines = res.data.map((c: Record<string, unknown>) => {
        const a = c.attributes as Record<string, unknown>;
        return `- [ID:${c.id}] ${a.created_at}: ${a.body}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  server.tool(
    'create_comment',
    'Add a comment to a task.',
    {
      task_id: z.string().min(1),
      body: z.string().min(1).describe('The comment text'),
    },
    async ({ task_id, body }) => {
      const payload = {
        data: {
          type: 'comments',
          attributes: { body },
          relationships: { task: { data: { type: 'tasks', id: task_id } } },
        },
      };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, 'comments', { method: 'POST', body: JSON.stringify(payload) });
      return { content: [{ type: 'text', text: `Comment added. ID: ${res.data.id}` }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TIME ENTRIES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_time_entries',
    'List time entries. Filter by person, project, task, or date range.',
    {
      person_id: z.string().optional().describe('Filter by person ID'),
      project_id: z.string().optional().describe('Filter by project ID'),
      task_id: z.string().optional().describe('Filter by task ID'),
      date_after: z.string().optional().describe('Entries on or after this date (YYYY-MM-DD)'),
      date_before: z.string().optional().describe('Entries on or before this date (YYYY-MM-DD)'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.person_id) q.set('filter[person_id]', params.person_id);
      if (params.project_id) q.set('filter[project_id]', params.project_id);
      if (params.task_id) q.set('filter[task_id]', params.task_id);
      if (params.date_after) q.set('filter[after]', params.date_after);
      if (params.date_before) q.set('filter[before]', params.date_before);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `time_entries?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No time entries found.' }] };
      const lines = res.data.map((e: Record<string, unknown>) => {
        const a = e.attributes as Record<string, unknown>;
        const mins = Number(a.time ?? 0);
        const hours = (mins / 60).toFixed(2);
        return `- [ID:${e.id}] ${a.date} ${hours}h — ${a.note ?? '(no note)'}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  server.tool(
    'create_time_entry',
    'Log a time entry against a task or project.',
    {
      person_id: z.string().min(1).describe('The person ID logging the time'),
      service_id: z.string().min(1).describe('The service/budget line ID'),
      time: z.number().min(1).describe('Time in minutes'),
      date: z.string().min(1).describe('Date in YYYY-MM-DD format'),
      note: z.string().optional().describe('Optional note describing the work done'),
      task_id: z.string().optional().describe('Optional task ID to attach the entry to'),
    },
    async (params) => {
      const body = {
        data: {
          type: 'time_entries',
          attributes: {
            time: params.time,
            date: params.date,
            ...(params.note ? { note: params.note } : {}),
          },
          relationships: {
            person: { data: { type: 'people', id: params.person_id } },
            service: { data: { type: 'services', id: params.service_id } },
            ...(params.task_id ? { task: { data: { type: 'tasks', id: params.task_id } } } : {}),
          },
        },
      };
      const res = await productiveRequest<{ data: Record<string, unknown> }>(env, 'time_entries', { method: 'POST', body: JSON.stringify(body) });
      const a = res.data.attributes as Record<string, unknown>;
      return { content: [{ type: 'text', text: `Time entry logged. ID: ${res.data.id}, Date: ${a.date}, Time: ${Number(a.time) / 60}h` }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // COMPANIES (CLIENTS)
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_companies',
    'List companies (clients) in the organisation.',
    {
      query: z.string().optional().describe('Search by company name'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.query) q.set('filter[name]', params.query);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `companies?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No companies found.' }] };
      const lines = res.data.map((c: Record<string, unknown>) => {
        const a = c.attributes as Record<string, unknown>;
        return `- [ID:${c.id}] ${a.name}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // BOARDS (WORKFLOW STATUSES)
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_boards',
    'List boards (workflow views) in the organisation.',
    {
      project_id: z.string().optional().describe('Filter by project ID'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.project_id) q.set('filter[project_id]', params.project_id);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `boards?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No boards found.' }] };
      const lines = res.data.map((b: Record<string, unknown>) => {
        const a = b.attributes as Record<string, unknown>;
        return `- [ID:${b.id}] ${a.name}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // ACTIVITIES (AUDIT LOG)
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_activities',
    'List recent activity/audit log entries. Useful for seeing what has changed recently.',
    {
      project_id: z.string().optional().describe('Filter by project ID'),
      person_id: z.string().optional().describe('Filter by person who performed the action'),
      limit: z.number().min(1).max(200).default(30).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.project_id) q.set('filter[project_id]', params.project_id);
      if (params.person_id) q.set('filter[person_id]', params.person_id);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `activities?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No activities found.' }] };
      const lines = res.data.map((a: Record<string, unknown>) => {
        const attrs = a.attributes as Record<string, unknown>;
        return `- [ID:${a.id}] ${attrs.created_at}: ${attrs.event} — ${attrs.description ?? ''}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // SERVICES (BUDGET LINES)
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_services',
    'List services (budget lines) for a project. Needed when logging time entries.',
    {
      project_id: z.string().optional().describe('Filter by project ID'),
      limit: z.number().min(1).max(200).default(50).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.project_id) q.set('filter[project_id]', params.project_id);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `services?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No services found.' }] };
      const lines = res.data.map((s: Record<string, unknown>) => {
        const a = s.attributes as Record<string, unknown>;
        return `- [ID:${s.id}] ${a.name}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TAGS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_tags',
    'List all tags available in the organisation.',
    {
      limit: z.number().min(1).max(200).default(100).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `tags?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No tags found.' }] };
      const lines = res.data.map((t: Record<string, unknown>) => {
        const a = t.attributes as Record<string, unknown>;
        return `- [ID:${t.id}] ${a.name}`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // WORKFLOWS & STATUSES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    'list_workflow_statuses',
    'List workflow statuses available in the organisation or for a specific workflow.',
    {
      workflow_id: z.string().optional().describe('Filter by workflow ID'),
      limit: z.number().min(1).max(200).default(100).optional(),
      page: z.number().min(1).default(1).optional(),
    },
    async (params) => {
      const q = paginationParams(params.limit, params.page);
      if (params.workflow_id) q.set('filter[workflow_id]', params.workflow_id);
      const res = await productiveRequest<{ data: Record<string, unknown>[]; meta: { total_count: number } }>(env, `workflow_statuses?${q}`);
      if (!res?.data?.length) return { content: [{ type: 'text', text: 'No workflow statuses found.' }] };
      const lines = res.data.map((w: Record<string, unknown>) => {
        const a = w.attributes as Record<string, unknown>;
        return `- [ID:${w.id}] ${a.name} (category: ${a.category})`;
      });
      return { content: [{ type: 'text', text: formatMeta(res.meta, res.data.length) + lines.join('\n') }] };
    }
  );

  return server;
}

// ─── Cloudflare Worker entry point ───────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({ name: 'productive-mcp', version: '2.0.0', status: 'ok', endpoint: '/mcp' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/mcp') {
      const mcpServer = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
