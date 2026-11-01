import { authorizeMcpRequest } from "./oidc.js";
import {
  getConnectionStatus,
  getListings,
  getListing,
  getOrders,
  createDigitalDraft,
  uploadListingAsset,
  publishDigitalListing,
} from "./api.js";
import { createAssetUploadSession, listStagedAssets } from "./assets.js";

const SERVER_INFO = { name: "colorcity999-etsy-bridge", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-03-26";

export async function handleMcp(request, env) {
  const body = await readJsonRpcBody(request);
  const method = body.method;
  const id = body.id;
  if (typeof method !== "string" || body.jsonrpc !== "2.0") throw httpError(400, "Invalid JSON-RPC request.");

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  const requiredScope = method === "tools/call" ? requiredToolScope(body.params?.name) : "etsy:read";
  await authorizeMcpRequest(request, env, requiredScope);

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: toolDefinitions() });
  if (method === "tools/call") return rpcResult(id, await callTool(body.params || {}, env, new URL(request.url).origin));
  throw rpcError(id, -32601, "Method not found.");
}

export function getMcpMethodNotAllowed() {
  return new Response("MCP uses POST requests.", {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

async function callTool(params, env, origin) {
  if (typeof params.name !== "string") throw rpcError(null, -32602, "Tool name is required.");
  const args = params.arguments || {};
  try {
    let data;
    switch (params.name) {
      case "etsy_connection_status":
        data = await getConnectionStatus(env);
        break;
      case "list_etsy_listings":
        data = await getListings(env, {
          state: enumValue(args.state, ["active", "inactive", "sold_out", "draft", "expired"], "active"),
          limit: integerValue(args.limit, 1, 100, 25),
          offset: integerValue(args.offset, 0, 12000, 0),
        });
        break;
      case "get_etsy_listing":
        data = await getListing(env, args.listing_id);
        break;
      case "get_etsy_orders":
        data = await getOrders(env, {
          minCreated: args.min_created,
          maxCreated: args.max_created,
          limit: String(integerValue(args.limit, 1, 100, 100)),
          offset: String(integerValue(args.offset, 0, 12000, 0)),
        });
        break;
      case "create_digital_draft":
        data = await createDigitalDraft(env, {
          title: args.title,
          description: args.description,
          price: args.price,
          taxonomyId: args.taxonomy_id,
          tags: args.tags,
          quantity: args.quantity,
        });
        break;
      case "create_asset_upload_session":
        data = await createAssetUploadSession(env, origin);
        break;
      case "list_staged_assets":
        data = await listStagedAssets(env);
        break;
      case "upload_listing_asset":
        data = await uploadListingAsset(env, args.listing_id, args.asset_id, args.purpose, {
          altText: args.alt_text || "",
        });
        break;
      case "publish_digital_listing": {
        const expected = "PUBLISH " + String(args.listing_id || "");
        if (args.confirmation !== expected) throw httpError(400, 'To publish, set confirmation exactly to "' + expected + '".');
        data = await publishDigitalListing(env, args.listing_id);
        break;
      }
      default:
        throw httpError(404, "Unknown ColorCity999 bridge tool.");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
      isError: false,
    };
  } catch (error) {
    const message = error?.status >= 500 ? "The bridge could not complete the Etsy request." : error?.message || "Tool request failed.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function requiredToolScope(name) {
  if (name === "publish_digital_listing") return "etsy:publish";
  if (["create_digital_draft", "create_asset_upload_session", "upload_listing_asset"].includes(name)) return "etsy:write";
  if (["etsy_connection_status", "list_etsy_listings", "get_etsy_listing", "get_etsy_orders", "list_staged_assets"].includes(name)) return "etsy:read";
  return "etsy:read";
}

function toolDefinitions() {
  return [
    {
      name: "etsy_connection_status",
      description: "Check whether the ColorCity999 Etsy OAuth connection and shop API are responding. Does not expose tokens.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_etsy_listings",
      description: "Read listings from the connected ColorCity999 Etsy shop. Includes drafts when state is draft.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["active", "inactive", "sold_out", "draft", "expired"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          offset: { type: "integer", minimum: 0, maximum: 12000 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_etsy_listing",
      description: "Read a single Etsy listing by ID.",
      inputSchema: { type: "object", properties: { listing_id: { type: "integer", minimum: 1 } }, required: ["listing_id"], additionalProperties: false },
    },
    {
      name: "get_etsy_orders",
      description: "Read Etsy receipts in an exact UTC Unix-seconds window. Buyer names, addresses, email, and message text are omitted.",
      inputSchema: {
        type: "object",
        properties: {
          min_created: { type: "string", description: "Inclusive start timestamp in Unix seconds." },
          max_created: { type: "string", description: "Exclusive end timestamp in Unix seconds." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          offset: { type: "integer", minimum: 0, maximum: 12000 },
        },
        required: ["min_created", "max_created"],
        additionalProperties: false,
      },
    },
    {
      name: "create_digital_draft",
      description: "Create a digital Etsy listing as a draft only. Provide an Etsy taxonomy_id and up to 13 tags. This does not publish or charge a listing fee.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 140 },
          description: { type: "string", minLength: 1, maxLength: 5000 },
          price: { type: "number", exclusiveMinimum: 0 },
          taxonomy_id: { type: "integer", minimum: 1, description: "Use an Etsy digital product taxonomy ID." },
          tags: { type: "array", maxItems: 13, items: { type: "string", maxLength: 20 } },
          quantity: { type: "integer", minimum: 1, description: "Defaults to 999 for digital downloads." },
        },
        required: ["title", "description", "price", "taxonomy_id"],
        additionalProperties: false,
      },
    },
    {
      name: "create_asset_upload_session",
      description: "Create a private, one-time upload code to stage preview images and PDF/ZIP digital files from the user's browser. Code expires in 30 minutes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_staged_assets",
      description: "List staged image and digital download assets that have not yet been sent to Etsy.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "upload_listing_asset",
      description: "Upload one staged preview image or digital PDF/ZIP file to a bridge-created Etsy draft. Use purpose image or digital_file. The staged asset is deleted after a successful Etsy upload.",
      inputSchema: {
        type: "object",
        properties: {
          listing_id: { type: "integer", minimum: 1 },
          asset_id: { type: "string", pattern: "^[a-fA-F0-9]{32}$" },
          purpose: { type: "string", enum: ["image", "digital_file"] },
          alt_text: { type: "string", maxLength: 500 },
        },
        required: ["listing_id", "asset_id", "purpose"],
        additionalProperties: false,
      },
    },
    {
      name: "publish_digital_listing",
      description: "Publish a bridge-created digital draft only after its preview image and downloadable file are attached. This is a separate Etsy write action. Invoke only when the user explicitly asks to publish and the user confirms by providing confirmation exactly as PUBLISH <listing_id>.",
      inputSchema: {
        type: "object",
        properties: {
          listing_id: { type: "integer", minimum: 1 },
          confirmation: { type: "string", description: "Must exactly equal PUBLISH followed by the listing ID." },
        },
        required: ["listing_id", "confirmation"],
        additionalProperties: false,
      },
    },
  ];
}

async function readJsonRpcBody(request) {
  if (request.method !== "POST") throw httpError(405, "MCP uses POST requests.");
  let body;
  try { body = await request.json(); } catch { throw httpError(400, "Request body must be JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Invalid JSON-RPC request.");
  return body;
}

function rpcResult(id, result) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function rpcError(id, code, message) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function integerValue(value, min, max, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
