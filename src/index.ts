#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { z } from "zod";
import axios from "axios";
import { DefaultApi, Configuration } from "runn-typescript-sdk";

axios.defaults.adapter = "fetch";
import {
  computeUtilization,
  enrichProjectOverview,
  computeCapacityForecast,
  enrichPersonDetails,
  buildSkillMap,
  buildRoleMap,
  buildTeamMap,
} from "./helpers.js";

const config = new Configuration({
  accessToken: process.env.RUNN_API_KEY,
});
const api = new DefaultApi(config);

// Every Runn API call requires acceptVersion
const V = "1.0.0" as const;

// Retry wrapper for 429 / 5xx responses
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= maxRetries) throw err;

      const retryAfter = err?.response?.headers?.["retry-after"];
      const delaySec = retryAfter ? parseFloat(retryAfter) : Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
}

// Paginate through all results
async function paginate<T>(
  fetcher: (cursor?: string) => Promise<{ values: T[]; nextCursor?: string }>
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = await withRetry(() => fetcher(cursor));
    all.push(...(result.values || []));
    cursor = result.nextCursor;
    pages++;
    if (pages >= 10) break;
  } while (cursor);
  return all;
}

function errorResult(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error in ${toolName}: ${message}` }],
    isError: true,
  };
}

// --- Shared data fetchers ---

async function fetchPeople(includePlaceholders = false) {
  return paginate(async (cursor) => {
    const resp = await api.listPeople({ acceptVersion: V, limit: 100, cursor, includePlaceholders });
    return resp.data as any;
  });
}

async function fetchAssignments(personId?: number) {
  return paginate(async (cursor) => {
    const resp = await api.listAssignments({ acceptVersion: V, limit: 100, cursor, ...(personId ? { personId } : {}) });
    return resp.data as any;
  });
}

async function fetchProjects(includeArchived = false, name?: string) {
  return paginate(async (cursor) => {
    const resp = await api.listProjects({ acceptVersion: V, limit: 100, cursor, includeArchived, ...(name ? { name } : {}) });
    return resp.data as any;
  });
}

async function fetchClients() {
  return paginate(async (cursor) => {
    const resp = await api.listClients({ acceptVersion: V, sortBy: "createdAt", limit: 100, cursor });
    return resp.data as any;
  });
}

async function fetchTeams() {
  const resp = await api.listTeams({ acceptVersion: V, limit: 100 });
  return (resp.data as any)?.values || [];
}

async function fetchRoles() {
  const resp = await api.listRoles({ acceptVersion: V, limit: 100 });
  return (resp.data as any)?.values || [];
}

async function fetchSkills() {
  const resp = await api.listSkills({ acceptVersion: V, sortBy: "id", limit: 100 });
  return (resp.data as any)?.values || [];
}

async function fetchActuals(minDate?: string, maxDate?: string) {
  return paginate(async (cursor) => {
    const resp = await api.listActuals({
      acceptVersion: V, limit: 100, cursor,
      ...(minDate ? { minDate } : {}),
      ...(maxDate ? { maxDate } : {}),
    });
    return resp.data as any;
  });
}

async function fetchLeave() {
  return paginate(async (cursor) => {
    const resp = await api.listLeaveTimeOffs({ acceptVersion: V, sortBy: "createdAt", limit: 100, cursor });
    return resp.data as any;
  });
}

// --- TOOLS ---

function createServer() {
const server = new McpServer({
  name: "runn-mcp-server",
  version: "2.1.0",
});

server.registerTool(
  "get_team_utilization",
  {
    description:
      "Get utilization data with actual billable vs available hours. Resolves team and role names. Includes team-level summaries with avg utilization and headcount. Optionally filter by team name.",
    inputSchema: {
      teamName: z.string().optional().describe("Filter by team name (case-insensitive partial match)"),
      includePlaceholders: z.boolean().optional().describe("Include placeholder people (default: false)"),
    },
  },
  async ({ teamName, includePlaceholders }) => {
    try {
      // Fetch actuals for the last ~20 working days
      const now = new Date();
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 30);
      const minDate = monthAgo.toISOString().slice(0, 10);
      const maxDate = now.toISOString().slice(0, 10);

      const [people, assignments, actuals, teams, roles] = await Promise.all([
        fetchPeople(includePlaceholders ?? false),
        fetchAssignments(),
        fetchActuals(minDate, maxDate),
        fetchTeams(),
        fetchRoles(),
      ]);

      const result = computeUtilization({
        people, assignments, actuals, teams, roles,
        teamNameFilter: teamName,
        dateRangeDays: 20,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult("get_team_utilization", err);
    }
  }
);

server.registerTool(
  "get_project_overview",
  {
    description:
      "Get overview of projects with resolved client/team names, assigned people with roles, pricing model labels, and budget vs actual spend. Defaults to active (confirmed) projects. Optionally filter by project name or status.",
    inputSchema: {
      name: z.string().optional().describe("Filter by project name"),
      status: z.enum(["active", "tentative", "archived", "all"]).optional()
        .describe("Filter by project status (default: active). 'active' = confirmed, 'tentative' = unconfirmed, 'all' = everything"),
    },
  },
  async ({ name, status }) => {
    try {
      const statusFilter = status ?? "active";
      const includeArchived = statusFilter === "archived" || statusFilter === "all";

      const now = new Date();
      const threeMonthsAgo = new Date(now);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const [allProjects, assignments, actuals, clients, teams, people, roles] = await Promise.all([
        fetchProjects(includeArchived, name),
        fetchAssignments(),
        fetchActuals(threeMonthsAgo.toISOString().slice(0, 10), now.toISOString().slice(0, 10)),
        fetchClients(),
        fetchTeams(),
        fetchPeople(),
        fetchRoles(),
      ]);

      let projects = allProjects;
      if (statusFilter === "active") {
        projects = allProjects.filter((p: any) => p.isConfirmed === true);
      } else if (statusFilter === "tentative") {
        projects = allProjects.filter((p: any) => p.isConfirmed !== true);
      } else if (statusFilter === "archived") {
        projects = allProjects.filter((p: any) => p.isArchived === true);
      }

      const result = enrichProjectOverview({
        projects, assignments, actuals, clients, teams, people, roles,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult("get_project_overview", err);
    }
  }
);

server.registerTool(
  "get_capacity_forecast",
  {
    description:
      "Get capacity forecast with weekly utilization buckets, leave data, team names resolved. Shows who is available when and upcoming staffing gaps.",
    inputSchema: {
      weeksAhead: z.number().optional().describe("How many weeks ahead to forecast (default: 8)"),
    },
  },
  async ({ weeksAhead }) => {
    try {
      const [people, assignments, projects, leave, teams] = await Promise.all([
        fetchPeople(),
        fetchAssignments(),
        fetchProjects(),
        fetchLeave(),
        fetchTeams(),
      ]);

      const result = computeCapacityForecast({
        people, assignments, projects, leave, teams,
        weeksAhead: weeksAhead ?? 8,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult("get_capacity_forecast", err);
    }
  }
);

server.registerTool(
  "get_person_details",
  {
    description:
      "Get detailed information about a person with resolved skill names, role names on assignments, and team name.",
    inputSchema: {
      personId: z.number().describe("The Runn person ID"),
    },
  },
  async ({ personId }) => {
    try {
      const [personResp, skillsResp, assignments, projects, allSkills, roles, teams] = await Promise.all([
        withRetry(() => api.getPerson({ acceptVersion: V, personId })),
        withRetry(() => api.listPersonSkills({ acceptVersion: V, personId, limit: 50 })),
        fetchAssignments(personId),
        fetchProjects(),
        fetchSkills(),
        fetchRoles(),
        fetchTeams(),
      ]);

      const person = personResp.data;
      const personSkills = (skillsResp.data as any)?.values || [];

      const result = enrichPersonDetails({
        person,
        personSkills,
        assignments,
        projects,
        skillMap: buildSkillMap(allSkills),
        roleMap: buildRoleMap(roles),
        teamMap: buildTeamMap(teams),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult("get_person_details", err);
    }
  }
);

server.registerTool(
  "search_resources",
  {
    description:
      "Search for people, projects, or clients by name. Returns matching results across resource types.",
    inputSchema: {
      query: z.string().describe("Search query (matches against names)"),
      resourceType: z.enum(["people", "projects", "clients", "all"]).optional()
        .describe("Type of resource to search (default: all)"),
    },
  },
  async ({ query, resourceType }) => {
    try {
      const type = resourceType ?? "all";
      const q = query.trim().toLowerCase();
      const results: Record<string, any[]> = {};

      if (type === "all" || type === "people") {
        const people = await fetchPeople();
        results.people = people
          .filter((p: any) => {
            const name = `${p.firstName || ""} ${p.lastName || ""}`.toLowerCase();
            return name.includes(q) || p.email?.toLowerCase().includes(q);
          })
          .map((p: any) => ({ id: p.id, name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), email: p.email }));
      }

      if (type === "all" || type === "projects") {
        const projects = await fetchProjects();
        results.projects = projects
          .filter((p: any) => p.name?.toLowerCase().includes(q))
          .map((p: any) => ({ id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate }));
      }

      if (type === "all" || type === "clients") {
        const clients = await fetchClients();
        results.clients = clients
          .filter((c: any) => c.name?.toLowerCase().includes(q))
          .map((c: any) => ({ id: c.id, name: c.name }));
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      return errorResult("search_resources", err);
    }
  }
);

return server;
}

// --- START ---

async function main() {
  const port = process.env.PORT;

  if (port) {
    const app = createMcpExpressApp({ host: "0.0.0.0" });
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.all("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport; },
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };
        await createServer().connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });

    app.listen(parseInt(port), "0.0.0.0", () => {
      console.error(`Runn MCP Server listening on http://0.0.0.0:${port}/mcp`);
    });

    process.on("SIGINT", async () => {
      for (const sid in transports) {
        try { await transports[sid].close(); } catch {}
      }
      process.exit(0);
    });
  } else {
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error("Runn MCP Server running on stdio");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
