import express, { Request, Response } from "express";
import { Agent } from "undici";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pdfParse from "pdf-parse";

const app = express();
app.use(express.json());

const server = new Server(
  {
    name: "imanage-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const SearchSchema = z.object({
  query: z.string().describe("Search query text"),
  maxResults: z.number().int().min(1).max(20).optional(),
});

const FetchSchema = z.object({
  id: z.string().describe("iManage document URI or URL"),
  timeoutSeconds: z.number().positive().optional(),
  followRedirects: z.boolean().optional(),
  headers: z.record(z.string()).optional(),
});

const IMANAGE_SERVER = process.env.IMANAGE_SERVER ?? "fireman.cloudimanage.com";
const IMANAGE_USERNAME = process.env.IMANAGE_USERNAME ?? "";
const IMANAGE_PASSWORD = process.env.IMANAGE_PASSWORD ?? "";
const IMANAGE_CLIENT_ID = process.env.IMANAGE_CLIENT_ID ?? "";
const IMANAGE_CLIENT_SECRET = process.env.IMANAGE_CLIENT_SECRET ?? "";
const IMANAGE_LIBRARY_ID = process.env.IMANAGE_LIBRARY_ID ?? "ACTIVE_2";

const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT ?? "30");
const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES ?? String(10 * 1024 * 1024));
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "20");
const SKIP_LARGE_FILES = (process.env.SKIP_LARGE_FILES ?? "1") === "1";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? "1200");
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? "100");

const insecureAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

const DEFAULT_TIMEOUT_MS = REQUEST_TIMEOUT * 1000;

function splitText(text: string, chunkSize: number, overlap: number): string {
  if (!text) {
    return "";
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push(text.slice(start, end));
    start = Math.max(start + chunkSize - overlap, start + 1);
    if (chunks.join("").length >= MAX_DOC_BYTES) {
      break;
    }
  }
  return chunks.join("\n");
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: insecureAgent,
    } as RequestInit);
  } finally {
    clearTimeout(timeout);
  }
}

async function imanageAuthToken(): Promise<string | null> {
  const url = `https://${IMANAGE_SERVER}/auth/oauth2/token`;
  const body = new URLSearchParams({
    username: IMANAGE_USERNAME,
    password: IMANAGE_PASSWORD,
    grant_type: "password",
    client_id: IMANAGE_CLIENT_ID,
    client_secret: IMANAGE_CLIENT_SECRET,
    scope: "user",
  });

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function imanageCustomerId(token: string): Promise<string | null> {
  const url = `https://${IMANAGE_SERVER}/api`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "X-Auth-Token": token,
      },
    },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as {
    data?: { user?: { customer_id?: string } };
  };
  return data.data?.user?.customer_id ?? null;
}

function imanageDocUri(customerId: string, libraryId: string, docId: string): string {
  return `imanage://${customerId}/${libraryId}/${docId}`;
}

function parseIManageUri(uri: string): { customerId: string; libraryId: string; docId: string } {
  if (!uri.startsWith("imanage://")) {
    throw new Error("Not an iManage URI");
  }
  const rest = uri.slice("imanage://".length);
  const parts = rest.split("/", 3);
  if (parts.length !== 3) {
    throw new Error("Bad iManage URI");
  }
  const [customerId, libraryId, docId] = parts;
  return { customerId, libraryId, docId };
}

async function imanageSearch(query: string, maxResults: number) {
  const token = await imanageAuthToken();
  if (!token) {
    return [];
  }
  const customerId = await imanageCustomerId(token);
  if (!customerId) {
    return [];
  }

  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${IMANAGE_LIBRARY_ID}/documents/search`;
  const payload = {
    profile_fields: { document: ["id", "name", "file_edit_date", "iwl"] },
    filters: { body: query, type: "ACROBAT" },
    limit: maxResults,
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
      },
      body: JSON.stringify(payload),
    },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const results: Array<{ id: string; title: string; url: string }> = [];

  for (const entry of (data.data ?? []).slice(0, maxResults)) {
    const docId = String(entry.id ?? "");
    const title = String(entry.name ?? docId);
    const urlValue = String(entry.iwl ?? "");
    if (!docId) {
      continue;
    }
    results.push({
      id: imanageDocUri(customerId, IMANAGE_LIBRARY_ID, docId),
      title,
      url: urlValue,
    });
  }

  return results;
}

async function imanageHistoryViews(
  token: string,
  customerId: string,
  libraryId: string,
  docId: string,
  granularity: "daily" | "weekly" | "monthly" = "weekly"
): Promise<number | null> {
  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${libraryId}/documents/${docId}/history/plot-points/${granularity}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "X-Auth-Token": token,
        Accept: "application/json",
      },
    },
    DEFAULT_TIMEOUT_MS
  );

  if (response.status === 204 || response.status === 404) {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as unknown;
  const points = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown }).data;

  if (!Array.isArray(points)) {
    return null;
  }

  let total = 0;
  for (const point of points) {
    if (typeof point === "object" && point && "y" in point) {
      const value = Number((point as { y?: unknown }).y);
      if (!Number.isNaN(value)) {
        total += value;
      }
    }
  }
  return total;
}

async function readStreamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ buffer: Buffer; bytes: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) {
      break;
    }
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      break;
    }
  }

  return { buffer: Buffer.concat(chunks), bytes: total };
}

async function imanageDownloadPdf(
  token: string,
  customerId: string,
  libraryId: string,
  docId: string
): Promise<{ bytes: Buffer; metadata: Record<string, unknown> }> {
  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${libraryId}/documents/${docId}/download`;
  const headers = { "X-Auth-Token": token };

  if (SKIP_LARGE_FILES) {
    const headResponse = await fetchWithTimeout(
      url,
      {
        method: "HEAD",
        headers,
      },
      DEFAULT_TIMEOUT_MS
    );
    if (headResponse.ok) {
      const sizeValue = Number(headResponse.headers.get("Content-Length") ?? "0");
      if (sizeValue && sizeValue > MAX_DOC_BYTES) {
        return {
          bytes: Buffer.from(""),
          metadata: {
            skipped: true,
            reason: `file too large (${sizeValue} > ${MAX_DOC_BYTES} bytes)`,
          },
        };
      }
    }
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers,
    },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok || !response.body) {
    return {
      bytes: Buffer.from(""),
      metadata: { error: `download failed: ${response.status}` },
    };
  }

  const { buffer, bytes } = await readStreamToBuffer(response.body, MAX_DOC_BYTES);
  return {
    bytes: buffer,
    metadata: { bytes },
  };
}

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  if (!pdfBytes.length) {
    return "";
  }

  const parsed = await pdfParse(pdfBytes, { max: MAX_PAGES });
  let text = parsed.text?.trim() ?? "";
  if (text.length > MAX_DOC_BYTES / 4) {
    text = splitText(text, CHUNK_SIZE, CHUNK_OVERLAP);
  }
  return `[PDF parsed via pdf-parse]\n${text}`;
}

async function resolveIManageDocument(imanageUri: string) {
  const { customerId, libraryId, docId } = parseIManageUri(imanageUri);
  const token = await imanageAuthToken();
  if (!token) {
    throw new Error("iManage auth failed (check credentials & scopes)");
  }

  const download = await imanageDownloadPdf(token, customerId, libraryId, docId);
  const text = await extractPdfText(download.bytes);
  const profileUrl = `https://${IMANAGE_SERVER}/work/#/document/${customerId}/${libraryId}/${docId}`;
  const history = await imanageHistoryViews(token, customerId, libraryId, docId, "weekly");

  const metadata: Record<string, unknown> = {
    source: "imanage",
    customer_id: customerId,
    library_id: libraryId,
    doc_id: docId,
    ...download.metadata,
  };

  if (history !== null) {
    metadata.Views = history;
  }

  const skipped = download.metadata.skipped === true;
  const reason =
    typeof download.metadata.reason === "string" ? download.metadata.reason : "";

  return {
    id: imanageUri,
    title: `iManage Document ${docId}`,
    text: text || (skipped ? `[Skipped: ${reason}]` : ""),
    url: profileUrl,
    metadata,
  };
}

async function fetchUrlContent(
  url: string,
  timeoutSeconds: number,
  followRedirects: boolean,
  headers?: Record<string, string>
) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": "mcp-imanage/1.0",
        ...(headers ?? {}),
      },
      redirect: followRedirects ? "follow" : "manual",
    },
    timeoutSeconds * 1000
  );

  if (!response.ok) {
    throw new Error(`URL fetch failed: ${response.status}`);
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  const text = await response.text();

  return {
    id: url,
    title: url,
    text: contentType.includes("text/html") ? text.replace(/<[^>]+>/g, " ") : text,
    url,
    metadata: {
      source: "url",
      content_type: contentType,
    },
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search iManage documents by query.",
        inputSchema: zodToJsonSchema(SearchSchema),
      },
      {
        name: "fetch",
        description: "Fetch an iManage document by URI or fetch URL content.",
        inputSchema: zodToJsonSchema(FetchSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "search") {
    const { query, maxResults } = SearchSchema.parse(args);
    console.debug(`🔎 [debug] search tool called`, { query, maxResults });
    if (!query.trim()) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ results: [] }),
          },
        ],
      };
    }

    const results = await imanageSearch(query, maxResults ?? 5);
    const summaryLines = results.map((result, index) => `${index + 1}. ${result.title}`);
    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} resource(s) matching "${query}":\n\n${summaryLines.join("\n")}`,
        },
        ...results.map((result) => ({
          type: "resource_link",
          name: result.title,
          uri: result.id,
          description: result.url || "iManage document",
          mimeType: "application/pdf",
          annotations: {
            audience: ["assistant"],
            priority: 0.8,
          },
          metadata: {
            id: result.id,
            url: result.url,
          },
        })),
      ],
    };
  }

  if (name === "fetch") {
    const { id, timeoutSeconds, followRedirects, headers } = FetchSchema.parse(args);
    console.debug(`📥 [debug] fetch tool called`, { id, timeoutSeconds, followRedirects });
    const timeout = timeoutSeconds ?? 15;
    const redirects = followRedirects ?? true;

    let isUrl = false;
    try {
      const url = new URL(id);
      isUrl = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      isUrl = false;
    }

    const doc = isUrl
      ? await fetchUrlContent(id, timeout, redirects, headers)
      : await resolveIManageDocument(id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(doc),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

const PORT = Number(process.env.PORT ?? "3000");
app.listen(PORT, () => {
  console.log(`🚀 iManage MCP Server running on http://localhost:${PORT}/mcp`);
}).on("error", (error) => {
  console.error("Server error:", error);
  process.exit(1);
});
