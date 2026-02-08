# runn-mcp-server

MCP server for Runn — resource planning and utilization tracking.

## Tools

| Tool | Description |
|------|-------------|
| `get_team_utilization` | Get current utilization data for people and teams, with optional team name filter |
| `get_project_overview` | Get overview of active projects with assignments, timelines, and client info |
| `get_capacity_forecast` | Get capacity forecast showing who is available and when projects end |
| `get_person_details` | Get detailed information about a specific person including assignments and skills |
| `search_resources` | Search for people, projects, or clients by name |

## Installation

```bash
npm install -g github:rocketsciencegg/runn-mcp-server
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "runn": {
      "command": "runn-mcp-server",
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
      "command": "runn-mcp-server",
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
