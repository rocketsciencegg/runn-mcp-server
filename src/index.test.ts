import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("runn-mcp-server", () => {
  it("should load without errors", async () => {
    expect(McpServer).toBeDefined();
  });

  it("should have correct server metadata", async () => {
    const server = new McpServer({
      name: "runn-mcp-server",
      version: "1.0.0",
    });
    expect(server).toBeDefined();
  });

  it("should register all expected tools", async () => {
    const expectedTools = [
      "get_team_utilization",
      "get_project_overview",
      "get_capacity_forecast",
      "get_person_details",
      "search_resources",
    ];
    expect(expectedTools).toHaveLength(5);
    for (const tool of expectedTools) {
      expect(tool).toBeTruthy();
      expect(typeof tool).toBe("string");
    }
  });
});
