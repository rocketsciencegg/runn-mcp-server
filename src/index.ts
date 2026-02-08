#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DefaultApi, Configuration } from "runn-typescript-sdk";

const server = new McpServer({
  name: "runn-mcp-server",
  version: "1.0.0",
});

const config = new Configuration({
  accessToken: process.env.RUNN_API_KEY,
});
const api = new DefaultApi(config);

// Every Runn API call requires acceptVersion
const V = "1.0.0" as const;

// Paginate through all results
async function paginate<T>(
  fetcher: (cursor?: string) => Promise<{ values: T[]; nextCursor?: string }>
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = await fetcher(cursor);
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

// --- TOOLS ---

server.registerTool(
  "get_team_utilization",
  {
    description:
      "Get current utilization data for people and teams. Returns each person with their active assignments and billable hours. Optionally filter by team name.",
    inputSchema: {
      teamName: z.string().optional().describe("Filter by team name (case-insensitive partial match)"),
      includePlaceholders: z.boolean().optional().describe("Include placeholder people (default: false)"),
    },
  },
  async ({ teamName, includePlaceholders }) => {
    try {
      const people = await paginate(async (cursor) => {
        const resp = await api.listPeople({
          acceptVersion: V, limit: 100, cursor,
          includePlaceholders: includePlaceholders ?? false,
        });
        return resp.data as any;
      });

      const assignments = await paginate(async (cursor) => {
        const resp = await api.listAssignments({ acceptVersion: V, limit: 100, cursor });
        return resp.data as any;
      });

      // Filter by team if requested
      let teamIds: Set<number> | null = null;
      if (teamName) {
        const teamsResp = await api.listTeams({ acceptVersion: V, limit: 100 });
        const teams = (teamsResp.data as any)?.values || [];
        const matching = teams.filter((t: any) =>
          t.name?.toLowerCase().includes(teamName.trim().toLowerCase())
        );
        teamIds = new Set(matching.map((t: any) => t.id));
      }

      const assignmentsByPerson = new Map<number, any[]>();
      for (const a of assignments) {
        const pid = (a as any).personId;
        if (!assignmentsByPerson.has(pid)) assignmentsByPerson.set(pid, []);
        assignmentsByPerson.get(pid)!.push(a);
      }

      let filteredPeople = people;
      if (teamIds) {
        filteredPeople = people.filter((p: any) => {
          const pTeams = p.teamIds || (p.teamId ? [p.teamId] : []);
          return pTeams.some((id: number) => teamIds!.has(id));
        });
      }

      const result = filteredPeople.map((p: any) => ({
        id: p.id,
        name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
        email: p.email,
        role: p.role,
        teamIds: p.teamIds || [],
        activeAssignments: (assignmentsByPerson.get(p.id) || []).length,
        assignments: (assignmentsByPerson.get(p.id) || []).map((a: any) => ({
          projectId: a.projectId,
          roleId: a.roleId,
          startDate: a.startDate,
          endDate: a.endDate,
          minutesPerDay: a.minutesPerDay,
        })),
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ totalPeople: result.length, people: result }, null, 2),
        }],
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
      "Get overview of active projects with assignments, timelines, and client info. Optionally filter by project name.",
    inputSchema: {
      name: z.string().optional().describe("Filter by project name"),
      includeArchived: z.boolean().optional().describe("Include archived projects (default: false)"),
    },
  },
  async ({ name, includeArchived }) => {
    try {
      const projects = await paginate(async (cursor) => {
        const resp = await api.listProjects({
          acceptVersion: V, limit: 100, cursor,
          includeArchived: includeArchived ?? false, name,
        });
        return resp.data as any;
      });

      const clients = await paginate(async (cursor) => {
        const resp = await api.listClients({ acceptVersion: V, sortBy: "createdAt", limit: 100, cursor });
        return resp.data as any;
      });
      const clientMap = new Map(clients.map((c: any) => [c.id, c]));

      const assignments = await paginate(async (cursor) => {
        const resp = await api.listAssignments({ acceptVersion: V, limit: 100, cursor });
        return resp.data as any;
      });
      const assignmentsByProject = new Map<number, any[]>();
      for (const a of assignments) {
        const pid = (a as any).projectId;
        if (!assignmentsByProject.has(pid)) assignmentsByProject.set(pid, []);
        assignmentsByProject.get(pid)!.push(a);
      }

      const result = projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        client: (clientMap.get(p.clientId) as any)?.name || null,
        startDate: p.startDate,
        endDate: p.endDate,
        isConfirmed: p.isConfirmed,
        isTentative: p.isTentative,
        tags: p.tags,
        assignmentCount: (assignmentsByProject.get(p.id) || []).length,
        assignedPeople: [...new Set((assignmentsByProject.get(p.id) || []).map((a: any) => a.personId))],
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ totalProjects: result.length, projects: result }, null, 2),
        }],
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
      "Get capacity forecast showing who is available and when projects end. Identifies staffing gaps and upcoming availability.",
    inputSchema: {
      weeksAhead: z.number().optional().describe("How many weeks ahead to forecast (default: 8)"),
    },
  },
  async ({ weeksAhead }) => {
    try {
      const weeks = weeksAhead ?? 8;

      const people = await paginate(async (cursor) => {
        const resp = await api.listPeople({
          acceptVersion: V, limit: 100, cursor, includePlaceholders: false,
        });
        return resp.data as any;
      });

      const assignments = await paginate(async (cursor) => {
        const resp = await api.listAssignments({ acceptVersion: V, limit: 100, cursor });
        return resp.data as any;
      });

      const projects = await paginate(async (cursor) => {
        const resp = await api.listProjects({
          acceptVersion: V, limit: 100, cursor, includeArchived: false,
        });
        return resp.data as any;
      });
      const projectMap = new Map(projects.map((p: any) => [p.id, p]));

      const now = new Date();
      const forecastEnd = new Date(now);
      forecastEnd.setDate(forecastEnd.getDate() + weeks * 7);

      const forecast = people.map((p: any) => {
        const personAssignments = assignments
          .filter((a: any) => a.personId === p.id)
          .map((a: any) => ({
            projectName: (projectMap.get(a.projectId) as any)?.name || `Project ${a.projectId}`,
            startDate: a.startDate,
            endDate: a.endDate,
            minutesPerDay: a.minutesPerDay,
          }))
          .filter((a: any) => !a.endDate || new Date(a.endDate) >= now);

        const endingSoon = personAssignments.filter(
          (a: any) => a.endDate && new Date(a.endDate) <= forecastEnd
        );

        return {
          name: `${p.firstName || ""} ${p.lastName || ""}`.trim(),
          id: p.id,
          activeAssignments: personAssignments.length,
          endingSoon,
          fullyAvailableAfter: endingSoon.length > 0
            ? endingSoon.reduce((latest: string, a: any) => (a.endDate > latest ? a.endDate : latest), endingSoon[0].endDate)
            : null,
        };
      });

      const unassigned = forecast.filter((p) => p.activeAssignments === 0);
      const ending = forecast.filter((p) => p.endingSoon.length > 0);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            forecastWeeks: weeks,
            totalPeople: forecast.length,
            currentlyUnassigned: unassigned.length,
            withEndingSoonAssignments: ending.length,
            unassignedPeople: unassigned.map((p) => p.name),
            forecast,
          }, null, 2),
        }],
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
      "Get detailed information about a specific person including their assignments and skills.",
    inputSchema: {
      personId: z.number().describe("The Runn person ID"),
    },
  },
  async ({ personId }) => {
    try {
      const personResp = await api.getPerson({ acceptVersion: V, personId });

      const skillsResp = await api.listPersonSkills({
        acceptVersion: V, personId, limit: 50,
      });
      const skills = (skillsResp.data as any)?.values || [];

      const assignments = await paginate(async (cursor) => {
        const resp = await api.listAssignments({
          acceptVersion: V, limit: 100, cursor, personId,
        });
        return resp.data as any;
      });

      const projects = await paginate(async (cursor) => {
        const resp = await api.listProjects({
          acceptVersion: V, limit: 100, cursor, includeArchived: false,
        });
        return resp.data as any;
      });
      const projectMap = new Map(projects.map((p: any) => [p.id, p]));

      const result = {
        ...(personResp.data as any),
        skills: skills.map((s: any) => ({ id: s.skillId, level: s.level })),
        assignments: assignments.map((a: any) => ({
          projectName: (projectMap.get(a.projectId) as any)?.name || `Project ${a.projectId}`,
          projectId: a.projectId,
          startDate: a.startDate,
          endDate: a.endDate,
          minutesPerDay: a.minutesPerDay,
          roleId: a.roleId,
        })),
      };

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
        const people = await paginate(async (cursor) => {
          const resp = await api.listPeople({
            acceptVersion: V, limit: 100, cursor, includePlaceholders: false,
          });
          return resp.data as any;
        });
        results.people = people
          .filter((p: any) => {
            const name = `${p.firstName || ""} ${p.lastName || ""}`.toLowerCase();
            return name.includes(q) || p.email?.toLowerCase().includes(q);
          })
          .map((p: any) => ({ id: p.id, name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), email: p.email }));
      }

      if (type === "all" || type === "projects") {
        const projects = await paginate(async (cursor) => {
          const resp = await api.listProjects({
            acceptVersion: V, limit: 100, cursor, includeArchived: false,
          });
          return resp.data as any;
        });
        results.projects = projects
          .filter((p: any) => p.name?.toLowerCase().includes(q))
          .map((p: any) => ({ id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate }));
      }

      if (type === "all" || type === "clients") {
        const clients = await paginate(async (cursor) => {
          const resp = await api.listClients({ acceptVersion: V, sortBy: "createdAt", limit: 100, cursor });
          return resp.data as any;
        });
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

// --- START ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Runn MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
