/**
 * iManage MCP Server (Copilot Studio friendly)
 * - Tool: search
 * - Resources: read (for document text / RAG context)
 * - Clickable citations: resource_link.uri is HTTPS (iwl) with ?mcpKey=<opaqueKey>
 * - Opaque key -> real iManage URI stored in in-memory lookup with TTL
 *
 * Notes:
 * - No "fetch" tool (Copilot tends to send its own GUIDs)
 * - resource_link.mimeType is text/plain to reduce PDF grounding behaviours
 * - resources/read accepts both:
 *    - https://... ?mcpKey=<key>
 *    - imanage://<key>  (fallback, if you ever emit that scheme)
 */
import express from "express";
import { Agent } from "undici";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, ListResourcesRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import pdfParse from "pdf-parse";
import crypto from "crypto";
const app = express();
app.use(express.json());
const server = new Server({ name: "imanage-mcp-server", version: "1.0.0" }, { capabilities: { resources: { subscribe: true }, tools: {} } });
// -------------------- Config --------------------
const IMANAGE_SERVER = process.env.IMANAGE_SERVER ?? "fireman.cloudimanage.com";
const IMANAGE_USERNAME = process.env.IMANAGE_USERNAME ?? "CloudAdmin@sandbox.firemanco.com";
const IMANAGE_PASSWORD = process.env.IMANAGE_PASSWORD ?? "pxg@zkm.CVU*der3tbd";
const IMANAGE_CLIENT_ID = process.env.IMANAGE_CLIENT_ID ?? "d8e2d5ef-0c1f-4475-af2c-ad4e2d5bc784";
const IMANAGE_CLIENT_SECRET = process.env.IMANAGE_CLIENT_SECRET ?? "3f8fa1e6-358d-4d11-9bae-8711c2a70a47";
const IMANAGE_LIBRARY_ID = process.env.IMANAGE_LIBRARY_ID ?? "ACTIVE_2";
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT ?? "30");
const DEFAULT_TIMEOUT_MS = REQUEST_TIMEOUT * 1000;
const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES ?? String(10 * 1024 * 1024));
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "20");
const SKIP_LARGE_FILES = (process.env.SKIP_LARGE_FILES ?? "1") === "1";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? "1200");
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? "100");
// If you run behind corp proxy / self-signed TLS, this keeps local dev happy.
// Consider removing for production.
const insecureAgent = new Agent({
    connect: { rejectUnauthorized: false },
});
const RESOURCE_LOOKUP = new Map();
const LOOKUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
function putLookup(entry) {
    const key = crypto.randomUUID();
    RESOURCE_LOOKUP.set(key, { ...entry, createdAt: Date.now() });
    return key;
}
function getLookup(key) {
    const entry = RESOURCE_LOOKUP.get(key);
    if (!entry)
        return null;
    if (Date.now() - entry.createdAt > LOOKUP_TTL_MS) {
        RESOURCE_LOOKUP.delete(key);
        return null;
    }
    return entry;
}
function cleanupLookup() {
    const now = Date.now();
    for (const [k, v] of RESOURCE_LOOKUP.entries()) {
        if (now - v.createdAt > LOOKUP_TTL_MS)
            RESOURCE_LOOKUP.delete(k);
    }
}
// Do a light cleanup occasionally (non-blocking)
let _cleanupCounter = 0;
function maybeCleanup() {
    _cleanupCounter += 1;
    if (_cleanupCounter % 25 === 0)
        cleanupLookup();
}
// -------------------- Schemas (Copilot Studio safe) --------------------
const SearchSchema = z.object({
    query: z.string().describe("Search query text"),
    client: z.string().describe("Filter by client number e.g. 12345").optional(),
    matter: z.string().describe("Filter by matter number e.g. 56789").optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
});
// ✅ Copilot Studio hardening: remove $schema keys
function stripDollarSchema(schema) {
    if (schema && typeof schema === "object") {
        // @ts-ignore
        if ("$schema" in schema)
            delete schema["$schema"];
        for (const v of Object.values(schema)) {
            if (v && typeof v === "object")
                stripDollarSchema(v);
        }
    }
    return schema;
}
// -------------------- Helpers --------------------
function splitText(text, chunkSize, overlap) {
    if (!text)
        return "";
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(text.length, start + chunkSize);
        chunks.push(text.slice(start, end));
        start = Math.max(start + chunkSize - overlap, start + 1);
        if (chunks.join("").length >= MAX_DOC_BYTES)
            break;
    }
    return chunks.join("\n");
}
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
            dispatcher: insecureAgent,
        });
    }
    finally {
        clearTimeout(timeout);
    }
}
function appendQueryParam(url, key, value) {
    // Handles querystring + fragments safely
    try {
        const u = new URL(url);
        u.searchParams.set(key, value);
        return u.toString();
    }
    catch {
        // Fallback: naive
        const sep = url.includes("?") ? "&" : "?";
        return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
}
function extractMcpKeyFromUri(uri) {
    // Accept:
    // - https://... ?mcpKey=<key>
    // - imanage://<key>
    if (uri.startsWith("imanage://")) {
        return uri.slice("imanage://".length).split("?")[0];
    }
    try {
        const u = new URL(uri);
        return u.searchParams.get("mcpKey");
    }
    catch {
        return null;
    }
}
// -------------------- iManage Auth --------------------
async function imanageAuthToken() {
    if (!IMANAGE_USERNAME || !IMANAGE_PASSWORD || !IMANAGE_CLIENT_ID || !IMANAGE_CLIENT_SECRET) {
        throw new Error("Missing iManage env vars (IMANAGE_USERNAME/PASSWORD/CLIENT_ID/CLIENT_SECRET).");
    }
    const url = `https://${IMANAGE_SERVER}/auth/oauth2/token`;
    const body = new URLSearchParams({
        username: IMANAGE_USERNAME,
        password: IMANAGE_PASSWORD,
        grant_type: "password",
        client_id: IMANAGE_CLIENT_ID,
        client_secret: IMANAGE_CLIENT_SECRET,
        scope: "user",
    });
    const response = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, DEFAULT_TIMEOUT_MS);
    if (!response.ok)
        return null;
    const data = (await response.json());
    return data.access_token ?? null;
}
async function imanageCustomerId(token) {
    const url = `https://${IMANAGE_SERVER}/api`;
    const response = await fetchWithTimeout(url, { method: "GET", headers: { "X-Auth-Token": token } }, DEFAULT_TIMEOUT_MS);
    if (!response.ok)
        return null;
    const data = (await response.json());
    return data.data?.user?.customer_id ?? null;
}
// -------------------- URI helpers --------------------
function imanageDocUri(customerId, libraryId, docId) {
    return `imanage://${customerId}/${libraryId}/${docId}`;
}
function parseIManageUri(uri) {
    if (!uri.startsWith("imanage://"))
        throw new Error("Not an iManage URI");
    const rest = uri.slice("imanage://".length);
    const parts = rest.split("/", 3);
    if (parts.length !== 3)
        throw new Error("Bad iManage URI");
    const [customerId, libraryId, docId] = parts;
    return { customerId, libraryId, docId };
}
// -------------------- Search (iManage Work API) --------------------
async function imanageSearch(query, client, matter, maxResults) {
    const token = await imanageAuthToken();
    if (!token)
        return [];
    const customerId = await imanageCustomerId(token);
    if (!customerId)
        return [];
    const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${IMANAGE_LIBRARY_ID}/documents/search`;
    // Build filters dynamically so we only include custom1/custom2 when provided
    const filters = {
        body: query,
        type: "ACROBAT",
    };
    const clientVal = (client ?? "").trim();
    if (clientVal)
        filters.custom1 = clientVal;
    const matterVal = (matter ?? "").trim();
    if (matterVal)
        filters.custom2 = matterVal;
    const payload = {
        profile_fields: { document: ["id", "name", "file_edit_date", "iwl"] },
        filters,
        limit: maxResults,
    };
    const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth-Token": token },
        body: JSON.stringify(payload),
    }, DEFAULT_TIMEOUT_MS);
    if (!response.ok)
        return [];
    const data = (await response.json());
    return (data.data ?? []).slice(0, maxResults).flatMap((entry) => {
        const docId = String(entry.id ?? "");
        if (!docId)
            return [];
        const title = String(entry.name ?? docId);
        const iwl = String(entry.iwl ?? "");
        return [
            {
                imanageUri: imanageDocUri(customerId, IMANAGE_LIBRARY_ID, docId),
                title,
                iwl,
            },
        ];
    });
}
// -------------------- Download + parse PDF --------------------
async function readStreamToBuffer(stream, maxBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done || !value)
            break;
        chunks.push(value);
        total += value.length;
        if (total > maxBytes)
            break;
    }
    return { buffer: Buffer.concat(chunks), bytes: total };
}
async function imanageDownloadPdf(token, customerId, libraryId, docId) {
    const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${libraryId}/documents/${docId}/download`;
    const headers = { "X-Auth-Token": token };
    if (SKIP_LARGE_FILES) {
        const headResponse = await fetchWithTimeout(url, { method: "HEAD", headers }, DEFAULT_TIMEOUT_MS);
        if (headResponse.ok) {
            const sizeValue = Number(headResponse.headers.get("Content-Length") ?? "0");
            if (sizeValue && sizeValue > MAX_DOC_BYTES) {
                return {
                    bytes: Buffer.from(""),
                    metadata: { skipped: true, reason: `file too large (${sizeValue} > ${MAX_DOC_BYTES} bytes)` },
                };
            }
        }
    }
    const response = await fetchWithTimeout(url, { method: "GET", headers }, DEFAULT_TIMEOUT_MS);
    if (!response.ok || !response.body) {
        return { bytes: Buffer.from(""), metadata: { error: `download failed: ${response.status}` } };
    }
    const { buffer, bytes } = await readStreamToBuffer(response.body, MAX_DOC_BYTES);
    return { bytes: buffer, metadata: { bytes } };
}
async function extractPdfText(pdfBytes) {
    if (!pdfBytes.length)
        return "";
    const parsed = await pdfParse(pdfBytes, { max: MAX_PAGES });
    let text = parsed.text?.trim() ?? "";
    if (text.length > MAX_DOC_BYTES / 4) {
        text = splitText(text, CHUNK_SIZE, CHUNK_OVERLAP);
    }
    return `[PDF parsed via pdf-parse]\n${text}`;
}
async function resolveIManageDocument(imanageUri) {
    const { customerId, libraryId, docId } = parseIManageUri(imanageUri);
    const token = await imanageAuthToken();
    if (!token)
        throw new Error("iManage auth failed (check credentials & scopes)");
    const download = await imanageDownloadPdf(token, customerId, libraryId, docId);
    const text = await extractPdfText(download.bytes);
    const profileUrl = `https://${IMANAGE_SERVER}/work/#/document/${customerId}/${libraryId}/${docId}`;
    const meta = {
        source: "imanage",
        customer_id: customerId,
        library_id: libraryId,
        doc_id: docId,
        url: profileUrl,
        ...download.metadata,
    };
    const skipped = download.metadata.skipped === true;
    const reason = typeof download.metadata.reason === "string" ? download.metadata.reason : "";
    return {
        id: imanageUri,
        title: `iManage Document ${docId}`,
        text: text || (skipped ? `[Skipped: ${reason}]` : ""),
        url: profileUrl,
        meta,
    };
}
const DEFAULT_STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "he", "her", "his",
    "i", "in", "is", "it", "its", "of", "on", "or", "our", "she", "that", "the", "their", "them", "they",
    "this", "to", "was", "we", "were", "will", "with", "you", "your"
]);
const SYNONYMS = {
    terminate: ["termination", "end", "cease"],
    termination: ["terminate", "end", "cease"],
    purchase: ["buy", "acquire", "procure"],
    price: ["amount", "consideration", "fee", "cost"],
    notice: ["notify", "notification"],
    agreement: ["contract"],
    party: ["parties", "counterparty"],
    acquired: ["sold", "M&A"],
};
function normalise(s) {
    return s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tokenize(text, minLen, useSynonyms) {
    const base = normalise(text)
        .split(" ")
        .map((t) => t.trim())
        .filter((t) => t.length >= minLen)
        .filter((t) => !DEFAULT_STOPWORDS.has(t));
    if (!useSynonyms)
        return base;
    const out = [];
    const seen = new Set();
    for (const t of base) {
        if (!seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
        const syns = SYNONYMS[t];
        if (syns) {
            for (const s of syns) {
                const ss = normalise(s);
                if (ss.length >= minLen && !DEFAULT_STOPWORDS.has(ss) && !seen.has(ss)) {
                    seen.add(ss);
                    out.push(ss);
                }
            }
        }
    }
    return out;
}
function splitSentences(text) {
    const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!cleaned)
        return [];
    return cleaned
        .split(/(?<=[.!?]["')\]]*)\s+|\n+/g)
        .map((s) => s.trim())
        .filter(Boolean);
}
function splitParagraphs(text) {
    const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!cleaned)
        return [];
    return cleaned
        .split(/\n{2,}/g)
        .map((p) => p.trim())
        .filter(Boolean);
}
function autoChunk(text, maxChars) {
    const paras = splitParagraphs(text);
    const chunks = [];
    for (const p of paras.length ? paras : [text]) {
        if (p.length <= maxChars) {
            chunks.push(p);
            continue;
        }
        const sents = splitSentences(p);
        let buf = "";
        for (const s of sents) {
            if (!buf) {
                buf = s;
                continue;
            }
            if ((buf + " " + s).length <= maxChars) {
                buf = buf + " " + s;
            }
            else {
                chunks.push(buf);
                buf = s;
            }
        }
        if (buf)
            chunks.push(buf);
    }
    return chunks.map((c) => c.trim()).filter(Boolean);
}
function buildCharNgrams(s, sizes) {
    const t = normalise(s).replace(/\s+/g, " ");
    const grams = [];
    for (const n of sizes) {
        if (n <= 1)
            continue;
        const compact = t.replace(/ /g, "_");
        for (let i = 0; i + n <= compact.length; i++) {
            grams.push(`~${compact.slice(i, i + n)}`);
        }
    }
    return grams;
}
function addToVec(vec, key, val) {
    vec.set(key, (vec.get(key) ?? 0) + val);
}
function cosineSimilarity(a, b) {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [k, v] of small) {
        const bv = big.get(k);
        if (bv)
            dot += v * bv;
    }
    let na = 0;
    for (const v of a.values())
        na += v * v;
    let nb = 0;
    for (const v of b.values())
        nb += v * v;
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function makeTfidfVectors(query, chunks, minLen, useCharNgrams, charNgramSizes, useSynonyms) {
    const qTerms = tokenize(query, minLen, useSynonyms);
    const df = new Map();
    const chunkFeatures = [];
    for (const chunk of chunks) {
        const terms = tokenize(chunk, minLen, useSynonyms);
        const feats = useCharNgrams ? terms.concat(buildCharNgrams(chunk, charNgramSizes)) : terms;
        const uniq = new Set(feats);
        for (const f of uniq)
            df.set(f, (df.get(f) ?? 0) + 1);
        chunkFeatures.push(feats);
    }
    const qFeats = useCharNgrams ? qTerms.concat(buildCharNgrams(query, charNgramSizes)) : qTerms;
    const N = Math.max(1, chunks.length);
    const idf = (f) => {
        const d = df.get(f) ?? 0;
        return Math.log(1 + N / (1 + d));
    };
    const qVec = new Map();
    {
        const tf = new Map();
        for (const f of qFeats)
            tf.set(f, (tf.get(f) ?? 0) + 1);
        for (const [f, c] of tf)
            addToVec(qVec, f, c * idf(f));
    }
    const cVecs = chunkFeatures.map((feats) => {
        const vec = new Map();
        const tf = new Map();
        for (const f of feats)
            tf.set(f, (tf.get(f) ?? 0) + 1);
        for (const [f, c] of tf)
            addToVec(vec, f, c * idf(f));
        return vec;
    });
    return { qVec, cVecs, queryTerms: qTerms };
}
function lexicalBoost(chunk, query, queryTerms) {
    const sNorm = normalise(chunk);
    const qNorm = normalise(query);
    let overlap = 0;
    const matched = [];
    for (const t of queryTerms) {
        const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, "i");
        if (re.test(chunk) || sNorm.includes(t)) {
            overlap += 1;
            matched.push(t);
        }
    }
    const phrase = qNorm.length >= 3 && sNorm.includes(qNorm) ? 1 : 0;
    const boost = Math.min(3, overlap) * 0.25 + phrase * 0.35;
    return { boost, matchTerms: matched };
}
export function findRelevantSentences(query, text, opts = {}) {
    const { topN = 5, minScore = 0.15, includeContext = false, contextWindow = 1, minTermLength = 3, chunking = "sentence", autoChunkMaxChars = 900, useCharNgrams = true, charNgramSizes = [3, 4, 5], cosineWeight = 1.0, lexicalBoostWeight = 0.35, phraseBoost = 0.4, useSynonyms = false, } = opts;
    const chunks = chunking === "paragraph"
        ? splitParagraphs(text)
        : chunking === "auto"
            ? autoChunk(text, autoChunkMaxChars)
            : splitSentences(text);
    if (!chunks.length)
        return [];
    const { qVec, cVecs, queryTerms } = makeTfidfVectors(query, chunks, minTermLength, useCharNgrams, charNgramSizes, useSynonyms);
    const scored = chunks
        .map((chunk, idx) => {
        const cos = cosineSimilarity(qVec, cVecs[idx]);
        const { boost, matchTerms } = lexicalBoost(chunk, query, queryTerms);
        const sNorm = normalise(chunk);
        const qNorm = normalise(query);
        const extraPhrase = qNorm.length >= 3 && sNorm.includes(qNorm) ? phraseBoost : 0;
        const score = cos * cosineWeight + boost * lexicalBoostWeight + extraPhrase;
        return { idx, chunk, score, matchTerms };
    })
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score || a.idx - b.idx);
    const top = scored.slice(0, topN);
    if (!includeContext) {
        return top.map(({ chunk, score, matchTerms }) => ({ sentence: chunk, score, matchTerms }));
    }
    const picked = new Map();
    for (const item of top) {
        for (let i = item.idx - contextWindow; i <= item.idx + contextWindow; i++) {
            if (i < 0 || i >= chunks.length)
                continue;
            if (!picked.has(i)) {
                const isMain = i === item.idx;
                picked.set(i, {
                    sentence: chunks[i],
                    score: isMain ? item.score : Math.max(0.05, item.score * 0.35),
                    matchTerms: isMain ? item.matchTerms : [],
                });
            }
        }
    }
    return [...picked.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);
}
export function buildRagContext(query, text, opts = {}, separator = "\n\n") {
    const sentences = findRelevantSentences(query, text, opts);
    const context = sentences.map((s) => s.sentence.trim()).filter(Boolean).join(separator);
    return { context, sentences };
}
// -------------------- MCP handlers --------------------
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: [] };
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    console.log(`📖 resources/read => ${uri}`);
    const key = extractMcpKeyFromUri(uri);
    if (!key) {
        throw new Error(`Unknown resource: ${uri}`);
    }
    const entry = getLookup(key);
    if (!entry) {
        throw new Error(`Unknown or expired resource id: ${key}. Please run search again (cache TTL ${LOOKUP_TTL_MS / 60000} mins).`);
    }
    console.log(`Resolving iManage document for key ${key} => ${entry.imanageUri}`);
    console.log(`Original query: ${entry.query}`);
    const doc = await resolveIManageDocument(entry.imanageUri);
    const { context } = buildRagContext(entry.query ?? "", doc.text, {
        chunking: "paragraph",
        topN: 3,
        includeContext: true,
        useCharNgrams: true,
        useSynonyms: true,
    });
    // Friendly "Sources" block: keep it human readable.
    // Clickable target: use the stored IWL if present, else fallback to doc.url.
    const sourceTitle = entry.title ?? doc.title ?? "iManage document";
    const clickable = entry.iwl || doc.url || entry.imanageUri;
    const sourcesBlock = `\n\nSources\n` +
        `- [${sourceTitle}](${clickable})\n`;
    console.log(`Built context for ${uri} with sources:\n${sourcesBlock}`);
    return {
        contents: [
            {
                uri,
                mimeType: "text/plain",
                text: context + sourcesBlock,
            },
        ],
    };
});
server.setRequestHandler(ListToolsRequestSchema, async () => {
    const schemaOpts = { $refStrategy: "none" };
    const searchSchema = stripDollarSchema(zodToJsonSchema(SearchSchema, schemaOpts));
    const resp = {
        tools: [
            {
                name: "search",
                description: "Search and filter iManage documents by query.",
                inputSchema: searchSchema,
            },
        ],
    };
    console.log("TOOLS/LIST =>", JSON.stringify(resp, null, 2));
    return resp;
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "search") {
        throw new Error(`Unknown tool: ${name}`);
    }
    const { query, maxResults, client, matter } = SearchSchema.parse(args);
    const q = query.trim();
    if (!q)
        return { content: [] };
    maybeCleanup();
    const results = await imanageSearch(q, client, matter, maxResults ?? 3);
    const content = [
        {
            type: "text",
            text: results.length === 0 ? `No results for "${q}".` : `Found ${results.length} document(s) for "${q}":`,
        },
    ];
    for (const r of results) {
        // Store mapping: opaque key -> real iManage URI (+ friendly title + iwl)
        const key = putLookup({
            imanageUri: r.imanageUri,
            query: q,
            title: r.title,
            iwl: r.iwl || undefined,
        });
        // Clickable citations: prefer HTTPS uri (iwl) with ?mcpKey=<key>
        // Copilot will cite this "source", and the user can click it.
        const baseClickable = r.iwl && r.iwl.startsWith("http") ? r.iwl : `https://${IMANAGE_SERVER}/work/`;
        const clickableWithKey = appendQueryParam(baseClickable, "mcpKey", key);
        content.push({
            type: "resource_link",
            uri: clickableWithKey,
            name: r.title,
            mimeType: "text/plain",
            annotations: { audience: ["user"], priority: 0.8 },
            _meta: {
                mcpKey: key,
                imanageUri: r.imanageUri,
                iwl: r.iwl,
            },
        });
    }
    return { content };
});
// -------------------- Express transport --------------------
app.post("/mcp", async (req, res) => {
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
            });
        }
    }
});
const PORT = Number(process.env.PORT ?? "3000");
app
    .listen(PORT, () => {
    console.log(`🚀 iManage MCP Server running on http://localhost:${PORT}/mcp`);
})
    .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
});
