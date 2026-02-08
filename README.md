# runn-mcp-server

[![CI](https://github.com/rocketsciencegg/runn-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/rocketsciencegg/runn-mcp-server/actions/workflows/ci.yml)
![Coverage](https://raw.githubusercontent.com/rocketsciencegg/runn-mcp-server/badges/coverage.svg)

MCP server for Runn — resource planning and utilization tracking.

## Tools

| Tool | Description |
|------|-------------|
| `get_team_utilization` | Actual utilization % from timesheet data, resolved team/role names, team-level summaries (avg utilization, headcount) |
| `get_project_overview` | Projects with budget vs actual spend, resolved client/team/people names, pricing model labels |
| `get_capacity_forecast` | Weekly capacity buckets with leave integration, resolved team names, availability windows |
| `get_person_details` | Full profile with resolved skill names, role names, team name, current assignments |
| `search_resources` | Search people/projects/clients by name |

## Installation

No install needed — runs directly via `npx`:

```bash
npx -y github:rocketsciencegg/runn-mcp-server
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "runn": {
      "command": "npx",
      "args": ["-y", "github:rocketsciencegg/runn-mcp-server"],
      "env": {
        "RUNN_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "runn": {
      "command": "npx",
      "args": ["-y", "github:rocketsciencegg/runn-mcp-server"],
      "env": {
        "RUNN_API_KEY": "${RUNN_API_KEY}"
      }
    }
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RUNN_API_KEY` | Your Runn API key |

## Development

```bash
git clone https://github.com/rocketsciencegg/runn-mcp-server.git
cd runn-mcp-server
npm install
npm run build
```

## License

MIT
