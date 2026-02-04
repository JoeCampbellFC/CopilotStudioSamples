import express, { Request, Response } from 'express';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from 'zod';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getPool, sql } from './utils/db.js';
import { timestamp } from './utils/utils.js';

const app = express();
app.use(express.json());

const MATTER_URI_PREFIX = 'matter://';

const buildMatterUri = (clientId: number, id: number) =>
  `${MATTER_URI_PREFIX}${clientId}/${id}`;

const parseMatterUri = (uri: string) => {
  if (!uri.startsWith(MATTER_URI_PREFIX)) {
    return null;
  }

  const parts = uri.slice(MATTER_URI_PREFIX.length).split('/');
  if (parts.length !== 2) {
    return null;
  }

  const clientId = Number(parts[0]);
  const id = Number(parts[1]);

  if (Number.isNaN(clientId) || Number.isNaN(id)) {
    return null;
  }

  return { clientId, id };
};

// Create the MCP server once (reused across requests)
const server = new Server(
  {
    name: "imanage-matter-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: { subscribe: true },
      tools: {},
    },
  }
);

// Tool input schemas
const SearchMattersSchema = z.object({
  searchTerms: z.string().describe("keywords to search for matters by name"),
  limit: z.number().int().min(1).max(25).optional().describe("maximum number of results")
});

const GetMatterByIdSchema = z.object({
  clientId: z.number().int().describe("Matter client ID"),
  id: z.number().int().describe("Matter ID")
});

// Handler: List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "searchMatters",
        description: "Search iManage matters by name. Returns matching matter resource links.",
        inputSchema: zodToJsonSchema(SearchMattersSchema),
      },
      {
        name: "getMatterById",
        description: "Retrieve a single matter by client ID and matter ID.",
        inputSchema: zodToJsonSchema(GetMatterByIdSchema),
      },
    ],
  };
});

const loadMatterSummary = async (searchTerms: string, limit: number) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('pattern', sql.NVarChar, `%${searchTerms}%`)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        ClientId,
        Id,
        Name_En_US,
        Status,
        OpenDate
      FROM imanage.Matter
      WHERE Name_En_US LIKE @pattern
      ORDER BY Name_En_US ASC
    `);

  return result.recordset as Array<{
    ClientId: number;
    Id: number;
    Name_En_US: string | null;
    Status: string | null;
    OpenDate: Date | null;
  }>;
};

const loadMatterById = async (clientId: number, id: number) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clientId', sql.Int, clientId)
    .input('id', sql.Int, id)
    .query(`
      SELECT *
      FROM imanage.Matter
      WHERE ClientId = @clientId
        AND Id = @id
    `);

  return result.recordset[0];
};

// Handler: Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "searchMatters") {
    const validatedArgs = SearchMattersSchema.parse(args);
    const { searchTerms, limit = 5 } = validatedArgs;

    console.log(`${timestamp()} 🔍 Client called tool: searchMatters with terms '${searchTerms}'`);

    const records = await loadMatterSummary(searchTerms, limit);

    if (records.length === 0) {
      console.log(`${timestamp()} ⚠️  No matters found for client search: "${searchTerms}"`);
      return {
        content: [
          {
            type: "text",
            text: `No matters found matching: "${searchTerms}". Try a different matter name keyword.`,
          },
        ],
      };
    }

    console.log(`${timestamp()} ✅ Returning ${records.length} matching matters to client`);

    const content: any[] = [
      {
        type: "text",
        text: `Found ${records.length} matter(s) matching "${searchTerms}":\n\n${records
          .map((record, index) => `${index + 1}. ${record.Name_En_US ?? 'Unnamed Matter'} (Client ${record.ClientId}, Matter ${record.Id})`)
          .join('\n')}`,
      },
    ];

    records.forEach((record) => {
      content.push({
        type: "resource_link",
        uri: buildMatterUri(record.ClientId, record.Id),
        name: record.Name_En_US ?? `Matter ${record.ClientId}/${record.Id}`,
        description: record.Status
          ? `Status: ${record.Status}`
          : "Matter record",
        mimeType: "application/json",
        annotations: {
          audience: ["assistant"],
          priority: 0.8
        }
      });
    });

    return { content };
  }

  if (name === "getMatterById") {
    const validatedArgs = GetMatterByIdSchema.parse(args);
    const { clientId, id } = validatedArgs;

    console.log(`${timestamp()} 📌 Client called tool: getMatterById for ${clientId}/${id}`);

    const record = await loadMatterById(clientId, id);

    if (!record) {
      return {
        content: [
          {
            type: "text",
            text: `No matter found for ClientId ${clientId} and Id ${id}.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(record, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Handler: List resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.log(`${timestamp()} 📋 Client requested resource list; returning empty list for database-backed resources.`);

  return {
    resources: []
  };
});

// Handler: Read resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  console.log(`${timestamp()} 📖 Client reading resource: ${uri}`);

  const parsed = parseMatterUri(uri);
  if (!parsed) {
    throw new Error(`Unknown resource: ${uri}`);
  }

  const record = await loadMatterById(parsed.clientId, parsed.id);

  if (!record) {
    throw new Error(`Matter not found for resource: ${uri}`);
  }

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(record, null, 2),
      },
    ],
  };
});

// Handler: Subscribe to resource updates
server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  const { uri } = request.params;
  console.log(`${timestamp()} 🔔 Client subscribed to: ${uri}`);
  return {};
});

// Handler: Unsubscribe from resource updates
server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  const { uri } = request.params;
  console.log(`${timestamp()} 🔕 Client unsubscribed from: ${uri}`);
  return {};
});

// Handle MCP requests (stateless mode)
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    // Create new transport for each request to prevent request ID collisions
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on('close', () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`${timestamp()} Error handling MCP request:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`${timestamp()} 🚀 Matter MCP Server running on http://localhost:${PORT}/mcp`);
  console.log(`${timestamp()} 📚 Connected to imanage.Matter in the staging-area database`);
}).on('error', error => {
  console.error(`${timestamp()} Server error:`, error);
  process.exit(1);
});
