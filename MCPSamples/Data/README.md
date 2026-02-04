# iManage Matter MCP Server

An MCP server demonstrating how Copilot Studio can discover and read database-backed resources through tools. This sample connects to an Azure SQL Database and queries the `imanage.Matter` table.

## Architecture

**How Copilot Studio accesses MCP resources:**
- Copilot Studio uses tools to discover resources (never enumerates all resources directly)
- Tools return filtered resource references (matter resource links)
- Agent evaluates references and selectively reads chosen resources
- Design enables scalability for enterprise systems with large-scale catalogs

**Note:** The MCP protocol supports direct resource enumeration, but Copilot Studio's architecture always uses tool-based discovery.

## How It Works

**1. Configure Database Connection**

The server reads the JDBC connection string from `DATABASE_JDBC_URL` (or `DATABASE_URL`). The default value is:

```
jdbc:sqlserver://insightplus.database.windows.net:1433;database=staging-area;user={your_username_here};password={your_password_here};encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;authentication=ActiveDirectoryPassword
```

**2. Implement Search Tool**

The `searchMatters` tool queries `imanage.Matter` by `Name_En_US` and returns `resource_link` references:

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "searchMatters") {
    const results = await loadMatterSummary(searchTerms, limit);

    return {
      content: results.map(record => ({
        type: "resource_link",
        uri: `matter://${record.ClientId}/${record.Id}`,
        name: record.Name_En_US ?? `Matter ${record.ClientId}/${record.Id}`
      }))
    };
  }
});
```

**3. Handle Resource Reads**

When the agent sends `resources/read` requests, the server fetches the row for the matter:

```typescript
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { clientId, id } = parseMatterUri(request.params.uri);
  const record = await loadMatterById(clientId, id);

  return {
    contents: [{
      uri: request.params.uri,
      mimeType: "application/json",
      text: JSON.stringify(record, null, 2)
    }]
  };
});
```

## Sample Structure

```
src/
├── index.ts              # Server entry point (Matter tools + resource reads)
└── utils/
    └── db.ts             # JDBC parsing + SQL connection pool
```

## Quick Start

### Prerequisites

- Node.js 18+
- [Dev Tunnels CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
- Copilot Studio access

### 1. Install and Build

```bash
npm install
npm run build
```

### 2. Configure Environment

Set the JDBC connection string:

```bash
export DATABASE_JDBC_URL="jdbc:sqlserver://insightplus.database.windows.net:1433;database=staging-area;user=<username>;password=<password>;encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;authentication=ActiveDirectoryPassword"
```

### 3. Start Server

```bash
npm start
# or
npm run dev
```

Server runs on `http://localhost:3000/mcp`

### 4. Create Dev Tunnel

**VS Code:**
1. Ports panel → Forward Port → 3000
2. Right-click → Port Visibility → Public
3. Copy HTTPS URL

**CLI:**
```bash
devtunnel host -p 3000 --allow-anonymous
```

**Important:** URL format is `https://abc123-3000.devtunnels.ms/mcp` (port in hostname with hyphen, not colon)

### 5. Configure Copilot Studio

1. Navigate to Tools → Add tool → Model Context Protocol
2. Configure:
   - **Server URL:** `https://your-tunnel-3000.devtunnels.ms/mcp`
   - **Authentication:** None
3. Click Create

## Example Queries

```
Search for Jaxon matters
→ Calls searchMatters("Jaxon") → Returns matter resource links

Get matter details for client 10234 and matter 4579
→ Calls getMatterById(10234, 4579)
```

## Resources

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp)
- [Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview)
