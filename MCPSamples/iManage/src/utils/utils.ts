// Central export point for all utility functions

export { timestamp } from './datetime.js';
export { formatSpeciesText } from './formatting.js';
export { encodeImage, getImageDataUri } from './imageEncoder.js';

import { Agent } from "undici";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import pdfParse from "pdf-parse";

// -------------------- Config --------------------

export const IMANAGE_SERVER = process.env.IMANAGE_SERVER ?? "fireman.cloudimanage.com";
export const IMANAGE_USERNAME = process.env.IMANAGE_USERNAME ?? "CloudAdmin@sandbox.firemanco.com";
export const IMANAGE_PASSWORD = process.env.IMANAGE_PASSWORD ?? "pxg@zkm.CVU*der3tbd";
export const IMANAGE_CLIENT_ID = process.env.IMANAGE_CLIENT_ID ?? "d8e2d5ef-0c1f-4475-af2c-ad4e2d5bc784";
export const IMANAGE_CLIENT_SECRET = process.env.IMANAGE_CLIENT_SECRET ?? "3f8fa1e6-358d-4d11-9bae-8711c2a70a47";

export const IMANAGE_LIBRARY_ID = process.env.IMANAGE_LIBRARY_ID ?? "ACTIVE_2";

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

// -------------------- Schemas (Copilot Studio safe) --------------------

export const SearchSchema = z.object({
  query: z.string().describe("Search query text"),
  client: z.string().describe("Filter by client number e.g. 12345").optional(),
  matter: z.string().describe("Filter by matter number e.g. 56789").optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
});

// ✅ Copilot Studio hardening: remove $schema keys
export function stripDollarSchema<T>(schema: T): T {
  if (schema && typeof schema === "object") {
    // @ts-ignore
    if ("$schema" in schema) delete (schema as any)["$schema"];
    for (const v of Object.values(schema as any)) {
      if (v && typeof v === "object") stripDollarSchema(v);
    }
  }
  return schema;
}

export function buildSearchInputSchema() {
  const schemaOpts = { $refStrategy: "none" as any };
  return stripDollarSchema(zodToJsonSchema(SearchSchema, schemaOpts));
}

// -------------------- Helpers --------------------

function splitText(text: string, chunkSize: number, overlap: number): string {
  if (!text) return "";
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push(text.slice(start, end));
    start = Math.max(start + chunkSize - overlap, start + 1);
    if (chunks.join("").length >= MAX_DOC_BYTES) break;
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

export function appendQueryParam(url: string, key: string, value: string): string {
  // Handles querystring + fragments safely
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    // Fallback: naive
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

export function extractMcpKeyFromUri(uri: string): string | null {
  // Accept:
  // - https://... ?mcpKey=<key>
  // - imanage://<key>
  if (uri.startsWith("imanage://")) {
    return uri.slice("imanage://".length).split("?")[0];
  }
  try {
    const u = new URL(uri);
    return u.searchParams.get("mcpKey");
  } catch {
    return null;
  }
}

// -------------------- iManage Auth --------------------

async function imanageAuthToken(): Promise<string | null> {
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

  const response = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) return null;

  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function imanageCustomerId(token: string): Promise<string | null> {
  const url = `https://${IMANAGE_SERVER}/api`;
  const response = await fetchWithTimeout(
    url,
    { method: "GET", headers: { "X-Auth-Token": token } },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) return null;

  const data = (await response.json()) as { data?: { user?: { customer_id?: string } } };
  return data.data?.user?.customer_id ?? null;
}

// -------------------- URI helpers --------------------

function imanageDocUri(customerId: string, libraryId: string, docId: string): string {
  return `imanage://${customerId}/${libraryId}/${docId}`;
}

function parseIManageUri(uri: string): { customerId: string; libraryId: string; docId: string } {
  if (!uri.startsWith("imanage://")) throw new Error("Not an iManage URI");
  const rest = uri.slice("imanage://".length);
  const parts = rest.split("/", 3);
  if (parts.length !== 3) throw new Error("Bad iManage URI");
  const [customerId, libraryId, docId] = parts;
  return { customerId, libraryId, docId };
}

// -------------------- Search (iManage Work API) --------------------

type IManageSearchResult = {
  imanageUri: string;
  title: string;
  iwl: string;
  client: string;
  matter: string;
};

export async function imanageSearch(
  query: string,
  client: string | null | undefined,
  matter: string | null | undefined,
  maxResults: number
): Promise<IManageSearchResult[]> {
  const token = await imanageAuthToken();
  if (!token) return [];

  const customerId = await imanageCustomerId(token);
  if (!customerId) return [];

  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${IMANAGE_LIBRARY_ID}/documents/search`;

  // Build filters dynamically so we only include custom1/custom2 when provided
  const filters: Record<string, unknown> = {
    body: query,
    type: "ACROBAT",
  };

  const clientVal = (client ?? "").trim();
  if (clientVal) filters.custom1 = clientVal;

  const matterVal = (matter ?? "").trim();
  if (matterVal) filters.custom2 = matterVal;

  const payload = {
    profile_fields: { document: ["id", "name", "file_edit_date", "iwl"] },
    filters,
    limit: maxResults,
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify(payload),
    },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) return [];

  const data = (await response.json()) as { data?: Array<Record<string, unknown>> };

  return (data.data ?? []).slice(0, maxResults).flatMap((entry) => {
    const docId = String(entry.id ?? "");
    if (!docId) return [];

    const title = String(entry.name ?? docId);
    const iwl = String(entry.iwl ?? "");
    const client = String(entry.custom1 ?? "");
    const matter = String(entry.custom2 ?? "");
    return [
      {
        imanageUri: imanageDocUri(customerId, IMANAGE_LIBRARY_ID, docId),
        title,
        iwl,
        client,
        matter,
      },
    ];
  });
}

// -------------------- Download + parse PDF --------------------

async function readStreamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ buffer: Buffer; bytes: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) break;
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

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  if (!pdfBytes.length) return "";
  const parsed = await pdfParse(pdfBytes, { max: MAX_PAGES });
  let text = parsed.text?.trim() ?? "";
  if (text.length > MAX_DOC_BYTES / 4) {
    text = splitText(text, CHUNK_SIZE, CHUNK_OVERLAP);
  }
  return `${text}`;
}

export async function resolveIManageDocument(imanageUri: string) {
  const { customerId, libraryId, docId } = parseIManageUri(imanageUri);
  const token = await imanageAuthToken();
  if (!token) throw new Error("iManage auth failed (check credentials & scopes)");

  const download = await imanageDownloadPdf(token, customerId, libraryId, docId);
  const text = await extractPdfText(download.bytes);

  const profileUrl = `https://${IMANAGE_SERVER}/work/#/document/${customerId}/${libraryId}/${docId}`;

  const meta: Record<string, unknown> = {
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

export function splitIManageUri(uri: string): {
  documentUri: string;
  query: string | null;
} {
  const queryIndex = uri.indexOf("?");
  if (queryIndex === -1) {
    return { documentUri: uri, query: null };
  }

  const documentUri = uri.substring(0, queryIndex);
  const params = new URLSearchParams(uri.substring(queryIndex + 1));
  const q = params.get("q");

  return {
    documentUri,
    query: q ? decodeURIComponent(q) : null,
  };
}

// -------------------- Lightweight semantic-ish retriever (your existing logic) --------------------

export type RelevantSentence = {
  sentence: string;
  score: number;
  matchTerms: string[];
};

export type FindRelevantSentencesOptions = {
  topN?: number;
  minScore?: number;
  includeContext?: boolean;
  contextWindow?: number;
  minTermLength?: number;

  chunking?: "sentence" | "paragraph" | "auto";
  autoChunkMaxChars?: number;

  useCharNgrams?: boolean;
  charNgramSizes?: number[];

  cosineWeight?: number;
  lexicalBoostWeight?: number;
  phraseBoost?: number;

  useSynonyms?: boolean;
};

const DEFAULT_STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for","from","has","have","he","her","his",
  "i","in","is","it","its","of","on","or","our","she","that","the","their","them","they",
  "this","to","was","we","were","will","with","you","your"
]);

const SYNONYMS: Record<string, string[]> = {
  terminate: ["termination", "end", "cease"],
  termination: ["terminate", "end", "cease"],
  purchase: ["buy", "acquire", "procure"],
  price: ["amount", "consideration", "fee", "cost"],
  notice: ["notify", "notification"],
  agreement: ["contract"],
  party: ["parties", "counterparty"],
  acquired: ["sold", "M&A"],
};

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(text: string, minLen: number, useSynonyms: boolean): string[] {
  const base = normalise(text)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= minLen)
    .filter((t) => !DEFAULT_STOPWORDS.has(t));

  if (!useSynonyms) return base;

  const out: string[] = [];
  const seen = new Set<string>();

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

function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!cleaned) return [];
  return cleaned
    .split(/(?<=[.!?]["')\]]*)\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitParagraphs(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);
}

function autoChunk(text: string, maxChars: number): string[] {
  const paras = splitParagraphs(text);
  const chunks: string[] = [];

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
      } else {
        chunks.push(buf);
        buf = s;
      }
    }
    if (buf) chunks.push(buf);
  }

  return chunks.map((c) => c.trim()).filter(Boolean);
}

function buildCharNgrams(s: string, sizes: number[]): string[] {
  const t = normalise(s).replace(/\s+/g, " ");
  const grams: string[] = [];
  for (const n of sizes) {
    if (n <= 1) continue;
    const compact = t.replace(/ /g, "_");
    for (let i = 0; i + n <= compact.length; i++) {
      grams.push(`~${compact.slice(i, i + n)}`);
    }
  }
  return grams;
}

type SparseVec = Map<string, number>;

function addToVec(vec: SparseVec, key: string, val: number): void {
  vec.set(key, (vec.get(key) ?? 0) + val);
}

function cosineSimilarity(a: SparseVec, b: SparseVec): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const bv = big.get(k);
    if (bv) dot += v * bv;
  }
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function makeTfidfVectors(
  query: string,
  chunks: string[],
  minLen: number,
  useCharNgrams: boolean,
  charNgramSizes: number[],
  useSynonyms: boolean
): { qVec: SparseVec; cVecs: SparseVec[]; queryTerms: string[] } {
  const qTerms = tokenize(query, minLen, useSynonyms);

  const df = new Map<string, number>();
  const chunkFeatures: string[][] = [];

  for (const chunk of chunks) {
    const terms = tokenize(chunk, minLen, useSynonyms);
    const feats = useCharNgrams ? terms.concat(buildCharNgrams(chunk, charNgramSizes)) : terms;
    const uniq = new Set(feats);
    for (const f of uniq) df.set(f, (df.get(f) ?? 0) + 1);
    chunkFeatures.push(feats);
  }

  const qFeats = useCharNgrams ? qTerms.concat(buildCharNgrams(query, charNgramSizes)) : qTerms;
  const N = Math.max(1, chunks.length);

  const idf = (f: string) => {
    const d = df.get(f) ?? 0;
    return Math.log(1 + N / (1 + d));
  };

  const qVec: SparseVec = new Map();
  {
    const tf = new Map<string, number>();
    for (const f of qFeats) tf.set(f, (tf.get(f) ?? 0) + 1);
    for (const [f, c] of tf) addToVec(qVec, f, c * idf(f));
  }

  const cVecs: SparseVec[] = chunkFeatures.map((feats) => {
    const vec: SparseVec = new Map();
    const tf = new Map<string, number>();
    for (const f of feats) tf.set(f, (tf.get(f) ?? 0) + 1);
    for (const [f, c] of tf) addToVec(vec, f, c * idf(f));
    return vec;
  });

  return { qVec, cVecs, queryTerms: qTerms };
}

function lexicalBoost(chunk: string, query: string, queryTerms: string[]) {
  const sNorm = normalise(chunk);
  const qNorm = normalise(query);

  let overlap = 0;
  const matched: string[] = [];

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

export function findRelevantSentences(query: string, text: string, opts: FindRelevantSentencesOptions = {}): RelevantSentence[] {
  const {
    topN = 5,
    minScore = 0.15,
    includeContext = false,
    contextWindow = 1,
    minTermLength = 3,

    chunking = "sentence",
    autoChunkMaxChars = 900,

    useCharNgrams = true,
    charNgramSizes = [3, 4, 5],

    cosineWeight = 1.0,
    lexicalBoostWeight = 0.35,
    phraseBoost = 0.4,

    useSynonyms = false,
  } = opts;

  const chunks =
    chunking === "paragraph"
      ? splitParagraphs(text)
      : chunking === "auto"
        ? autoChunk(text, autoChunkMaxChars)
        : splitSentences(text);

  if (!chunks.length) return [];

  const { qVec, cVecs, queryTerms } = makeTfidfVectors(
    query,
    chunks,
    minTermLength,
    useCharNgrams,
    charNgramSizes,
    useSynonyms
  );

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

  const picked = new Map<number, { sentence: string; score: number; matchTerms: string[] }>();
  for (const item of top) {
    for (let i = item.idx - contextWindow; i <= item.idx + contextWindow; i++) {
      if (i < 0 || i >= chunks.length) continue;
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

export function buildRagContext(
  query: string,
  text: string,
  opts: FindRelevantSentencesOptions = {},
  separator = "\n\n"
): { context: string; sentences: RelevantSentence[] } {
  const sentences = findRelevantSentences(query, text, opts);
  const context = sentences.map((s) => s.sentence.trim()).filter(Boolean).join(separator);
  return { context, sentences };
}
