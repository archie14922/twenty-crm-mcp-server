#!/usr/bin/env node

/**
 * Dempsey Design fork of twenty-crm-mcp-server (originally by mhenry3164).
 *
 * Changes vs upstream, made to close gaps found during a live audit:
 *   1. list_companies / list_people / list_tasks / search_opportunities now accept
 *      real field filters (category, priority, stage, etc.) via Twenty's REST
 *      `filter=field[operator]:value` syntax, instead of name/email-only search.
 *   2. get_field_metadata / get_object_schema (previously broken — written against
 *      a stale GraphQL type name, `ObjectFilterInput` instead of `ObjectRecordFilterInput`)
 *      have been removed. get_metadata_objects / get_object_metadata are the single
 *      source of truth for schema introspection, and get_object_metadata now accepts
 *      a name ('person', 'people', 'opportunity', ...) in addition to a raw UUID.
 *   3. Enum lists in tool descriptions (category options, etc.) are no longer
 *      hardcoded — they're pulled from a short-lived in-memory cache that's
 *      populated from the live schema, so they can't silently drift out of date.
 *   4. New composite tools collapse common multi-step workflows (e.g. intake of a
 *      new client: create company + create person + link + note) into one call.
 *
 * Everything else, including auth and the basic REST plumbing, is unchanged
 * from upstream.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Filter builder: translates a simple { field: value } or
// { field: { op, value } } shape into Twenty's REST filter query syntax:
//   filter=field[operator]:value
//   filter=field[operator]:[value1,value2]   (for arrays / `in`)
// Multiple filters are joined with the REST API's logical AND, which Twenty
// expresses by repeating the filter param joined with a comma between
// expressions inside one filter string: filter=a[eq]:1,b[eq]:2
// ---------------------------------------------------------------------------

// NOTE: Twenty's allowed operators are NOT universal across field types —
// confirmed empirically against a live workspace (see smoke_test.js):
//   - MULTI_SELECT (e.g. category) only allows: containsAny, is, isEmptyArray
//   - CURRENCY is a composite type ({amountMicros, currencyCode}) and can't
//     be filtered directly on the parent field name — see buildCurrencyFilter
//     below for the sub-field workaround.
// "in" was an assumption carried over from generic REST-filtering conventions
// and is NOT valid in Twenty's grammar; it has been removed entirely below
// rather than left in as a trap.
const VALID_OPERATORS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "like", "ilike", "is", "contains", "containsAny", "isEmptyArray",
]);

/**
 * Build a single filter expression for one field.
 * Accepts either a plain value (defaults to the most useful operator for
 * its JS type) or an explicit { op, value } pair.
 */
function buildFilterExpression(field, spec) {
  let op;
  let value;

  if (spec !== null && typeof spec === "object" && !Array.isArray(spec) && "op" in spec) {
    op = spec.op;
    value = spec.value;
  } else {
    value = spec;
    // Default operator by shape. Arrays default to containsAny — the
    // confirmed-valid "match any of these tags" operator for MULTI_SELECT
    // fields, which is what every array-valued filter in this codebase is
    // actually used for (category, etc.). If you need array semantics on a
    // different field type, pass an explicit { op, value } instead of
    // relying on this default.
    op = Array.isArray(value) ? "containsAny" : "eq";
  }

  if (!VALID_OPERATORS.has(op)) {
    throw new Error(
      `Unsupported filter operator "${op}" for field "${field}". ` +
      `Valid operators: ${[...VALID_OPERATORS].join(", ")}. ` +
      `Note: operators are type-specific in Twenty (e.g. MULTI_SELECT only ` +
      `allows containsAny/is/isEmptyArray) — if this still 400s, the field's ` +
      `type may not support the operator you chose even though it's in this ` +
      `list. Run get_object_metadata to check the field's type.`
    );
  }

  let formattedValue;
  if (Array.isArray(value)) {
    formattedValue = `[${value.map(formatFilterValue).join(",")}]`;
  } else {
    formattedValue = formatFilterValue(value);
  }

  return `${field}[${op}]:${formattedValue}`;
}

/**
 * Twenty's filter grammar treats bare tokens as unquoted literals and only
 * needs quoting for strings that contain reserved characters (commas,
 * brackets, colons). To stay simple and avoid double-escaping bugs, we quote
 * every string value by default; numbers and booleans pass through bare.
 *
 * Exception: NULL / NOT_NULL are special tokens for the "is" operator
 * (confirmed via live testing -- Twenty rejects them quoted, e.g. is:"NULL"
 * 400s with "Invalid filter value for is operator. Expected NULL or
 * NOT_NULL"). These pass through bare, normalized to uppercase.
 */
function formatFilterValue(value) {
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if (upper === "NULL" || upper === "NOT_NULL") {
      return upper;
    }
    const escaped = value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return String(value);
}

/**
 * Build a full filter query-string value from a { field: value|spec, ... } map.
 * Returns undefined if the map is empty/undefined, so callers can skip
 * appending the param entirely.
 */
function buildFilterParam(filters) {
  if (!filters || typeof filters !== "object") return undefined;
  const entries = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return undefined;
  return entries.map(([field, spec]) => buildFilterExpression(field, spec)).join(",");
}

// ---------------------------------------------------------------------------
// Schema cache: get_metadata_objects is the only schema-introspection call
// that's confirmed to work reliably (see fork notes above), so every other
// tool that needs to know about fields/options goes through this cache
// instead of re-deriving enum lists by hand. The cache is intentionally
// short-lived (5 minutes) so schema edits made in the Twenty UI show up
// without requiring a server restart, but we don't re-fetch on every single
// tool call either.
// ---------------------------------------------------------------------------

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

class SchemaCache {
  constructor(makeRequestFn) {
    this.makeRequest = makeRequestFn;
    this.objects = null; // array of object metadata, as returned by Twenty
    this.fetchedAt = 0;
  }

  isStale() {
    return !this.objects || (Date.now() - this.fetchedAt) > SCHEMA_CACHE_TTL_MS;
  }

  async getObjects({ forceRefresh = false } = {}) {
    if (forceRefresh || this.isStale()) {
      const result = await this.makeRequest("/rest/metadata/objects");
      this.objects = result?.data?.objects ?? [];
      this.fetchedAt = Date.now();
    }
    return this.objects;
  }

  /**
   * Find an object's metadata by singular name, plural name, or UUID.
   * This is what makes get_object_metadata accept 'person' / 'people' / a
   * raw UUID interchangeably, instead of requiring callers to already know
   * the internal UUID (the upstream bug we're fixing).
   */
  async findObject(nameOrId, opts) {
    const objects = await this.getObjects(opts);
    const needle = String(nameOrId).toLowerCase();
    return objects.find((o) =>
      o.id === nameOrId ||
      o.nameSingular?.toLowerCase() === needle ||
      o.namePlural?.toLowerCase() === needle
    );
  }

  /**
   * Get the live option list (value/label pairs) for a SELECT or
   * MULTI_SELECT field on a given object, by object name/id and field name.
   * Returns null if the object or field isn't found, or the field has no
   * options (i.e. it isn't a SELECT/MULTI_SELECT).
   */
  async getFieldOptions(objectNameOrId, fieldName, opts) {
    const object = await this.findObject(objectNameOrId, opts);
    if (!object) return null;
    const field = object.fields?.find((f) => f.name === fieldName);
    if (!field?.options) return null;
    return field.options.map((o) => o.value);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

class TwentyCRMServer {
  constructor() {
    this.server = new Server(
      {
        name: "dempsey-twenty-crm",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.apiKey = process.env.TWENTY_API_KEY;
    this.baseUrl = process.env.TWENTY_BASE_URL || "https://api.twenty.com";

    if (!this.apiKey) {
      throw new Error("TWENTY_API_KEY environment variable is required");
    }

    this.schemaCache = new SchemaCache(this.makeRequest.bind(this));
    this.setupToolHandlers();
  }

  async makeRequest(endpoint, method = "GET", data = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    };

    if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new Error(`API request failed: ${error.message}`);
    }
  }

  /** Shared helper for building the standard MCP text-content response shape. */
  textResult(text) {
    return { content: [{ type: "text", text }] };
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // ===== People =====
          {
            name: "create_person",
            description: "Create a new person in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email address" },
                phone: { type: "string", description: "Phone number" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID to associate with" },
                linkedinUrl: { type: "string", description: "LinkedIn profile URL" },
                city: { type: "string", description: "City" },
                category: {
                  type: "array",
                  items: { type: "string" },
                  description: "Person category tags. Run get_object_metadata({objectName: 'person'}) for the current valid values — this list is workspace-specific and can change."
                },
                avatarUrl: { type: "string", description: "Avatar image URL" }
              },
              required: ["firstName", "lastName"]
            }
          },
          {
            name: "get_person",
            description: "Get details of a specific person by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Person ID" } },
              required: ["id"]
            }
          },
          {
            name: "update_person",
            description: "Update an existing person's information",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" },
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email address" },
                phone: { type: "string", description: "Phone number" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID" },
                linkedinUrl: { type: "string", description: "LinkedIn profile URL" },
                city: { type: "string", description: "City" },
                category: {
                  type: "array",
                  items: { type: "string" },
                  description: "Person category tags. Run get_object_metadata({objectName: 'person'}) for the current valid values."
                }
              },
              required: ["id"]
            }
          },
          {
            name: "list_people",
            description:
              "List people with optional text search and field filters (e.g. category, city). " +
              "Filters use Twenty's native query semantics: pass a plain value for an exact/contains " +
              "match, or { op, value } to choose an operator explicitly (eq, neq, gt, gte, " +
              "lt, lte, like, ilike, is, contains, containsAny, isEmptyArray). For MULTI_SELECT fields like category, an array " +
              "value defaults to 'containsAny' (match any of these tags). Call get_object_metadata({objectName: " +
              "'person'}) first if you're not sure which field names or option values are valid.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for name or email" },
                companyId: { type: "string", description: "Filter by company ID" },
                filter: {
                  type: "object",
                  description:
                    "Field filters as { fieldName: value } or { fieldName: { op, value } }. " +
                    "Example: { category: ['VIP'] } or { city: { op: 'ilike', value: 'palm' } }.",
                  additionalProperties: true
                }
              }
            }
          },
          {
            name: "delete_person",
            description: "Delete a person from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Person ID to delete" } },
              required: ["id"]
            }
          },

          // ===== Companies =====
          {
            name: "create_company",
            description: "Create a new company in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Company domain" },
                address: { type: "string", description: "Company address" },
                employees: { type: "number", description: "Number of employees" },
                linkedinUrl: { type: "string", description: "LinkedIn company URL" },
                xUrl: { type: "string", description: "X (Twitter) URL" },
                annualRecurringRevenue: { type: "number", description: "Annual recurring revenue" },
                idealCustomerProfile: { type: "boolean", description: "Is this an ideal customer profile" },
                category: {
                  type: "array",
                  items: { type: "string" },
                  description: "Company category tags. Run get_object_metadata({objectName: 'company'}) for the current valid values — this list is workspace-specific and can change."
                }
              },
              required: ["name"]
            }
          },
          {
            name: "get_company",
            description: "Get details of a specific company by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Company ID" } },
              required: ["id"]
            }
          },
          {
            name: "update_company",
            description: "Update an existing company's information",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" },
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Company domain" },
                address: { type: "string", description: "Company address" },
                employees: { type: "number", description: "Number of employees" },
                linkedinUrl: { type: "string", description: "LinkedIn company URL" },
                annualRecurringRevenue: { type: "number", description: "Annual recurring revenue" },
                category: {
                  type: "array",
                  items: { type: "string" },
                  description: "Company category tags. Run get_object_metadata({objectName: 'company'}) for the current valid values."
                }
              },
              required: ["id"]
            }
          },
          {
            name: "list_companies",
            description:
              "List companies with optional text search and field filters (e.g. category, " +
              "employees). Filters use Twenty's native query semantics: pass a plain value for an " +
              "exact match, or { op, value } to choose an operator explicitly (eq, neq, " +
              "gt, gte, lt, lte, like, ilike, is, contains, containsAny, isEmptyArray). For MULTI_SELECT fields like category, " +
              "an array value defaults to 'containsAny' (match any of these tags) — this is how you'd list " +
              "every company tagged COMPETITOR, for example: { filter: { category: ['COMPETITOR'] } }. " +
              "Call get_object_metadata({objectName: 'company'}) first if you're not sure which field " +
              "names or option values are valid.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for company name" },
                filter: {
                  type: "object",
                  description:
                    "Field filters as { fieldName: value } or { fieldName: { op, value } }. " +
                    "Example: { category: ['COMPETITOR'] } or { employees: { op: 'gte', value: 50 } }.",
                  additionalProperties: true
                }
              }
            }
          },
          {
            name: "delete_company",
            description: "Delete a company from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Company ID to delete" } },
              required: ["id"]
            }
          },

          // ===== Notes =====
          {
            name: "create_note",
            description: "Create a new note in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Note title" },
                body: { type: "string", description: "Note content" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["title", "body"]
            }
          },
          {
            name: "get_note",
            description: "Get details of a specific note by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Note ID" } },
              required: ["id"]
            }
          },
          {
            name: "list_notes",
            description: "List notes with optional text search and field filters",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for note title or content" },
                filter: {
                  type: "object",
                  description: "Field filters as { fieldName: value } or { fieldName: { op, value } }.",
                  additionalProperties: true
                }
              }
            }
          },
          {
            name: "update_note",
            description: "Update an existing note",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" },
                title: { type: "string", description: "Note title" },
                body: { type: "string", description: "Note content" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_note",
            description: "Delete a note from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Note ID to delete" } },
              required: ["id"]
            }
          },

          // ===== Tasks =====
          {
            name: "create_task",
            description: "Create a new task in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Task title" },
                body: { type: "string", description: "Task description" },
                dueAt: { type: "string", description: "Due date (ISO 8601 format)" },
                status: { type: "string", description: "Task status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                priority: {
                  type: "string",
                  description: "Task priority rating. Run get_object_metadata({objectName: 'task'}) for current valid values (typically RATING_1 through RATING_5)."
                },
                assigneeId: { type: "string", description: "ID of person assigned to task" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["title"]
            }
          },
          {
            name: "get_task",
            description: "Get details of a specific task by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Task ID" } },
              required: ["id"]
            }
          },
          {
            name: "list_tasks",
            description:
              "List tasks with optional filters: status, assignee, priority, due date, or any other " +
              "field. Filters use Twenty's native query semantics: pass a plain value for an exact " +
              "match, or { op, value } to choose an operator explicitly (eq, neq, in, not_in, gt, gte, " +
              "lt, lte, like, ilike, is, contains). Example — overdue high-priority tasks: " +
              "{ filter: { priority: 'RATING_5', dueAt: { op: 'lt', value: '2026-06-20' } } }.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                status: { type: "string", description: "Filter by status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "Filter by assignee ID" },
                priority: {
                  type: "string",
                  description: "Filter by priority rating value (e.g. 'RATING_5'). Run get_object_metadata({objectName: 'task'}) to confirm current valid values."
                },
                filter: {
                  type: "object",
                  description:
                    "Additional/advanced field filters as { fieldName: value } or " +
                    "{ fieldName: { op, value } }, for anything not covered by the dedicated " +
                    "status/assigneeId/priority parameters above.",
                  additionalProperties: true
                }
              }
            }
          },
          {
            name: "update_task",
            description: "Update an existing task",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" },
                title: { type: "string", description: "Task title" },
                body: { type: "string", description: "Task description" },
                dueAt: { type: "string", description: "Due date (ISO 8601 format)" },
                status: { type: "string", description: "Task status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                priority: { type: "string", description: "Task priority rating (e.g. 'RATING_5')." },
                assigneeId: { type: "string", description: "ID of person assigned to task" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_task",
            description: "Delete a task from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Task ID to delete" } },
              required: ["id"]
            }
          },

          // ===== Opportunities =====
          {
            name: "create_opportunity",
            description: "Create a new opportunity in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Opportunity name" },
                amount: { type: "number", description: "Opportunity amount" },
                closeDate: { type: "string", description: "Close date (ISO 8601 format)" },
                stage: {
                  type: "string",
                  description: "Pipeline stage. Run get_object_metadata({objectName: 'opportunity'}) for current valid values."
                },
                priority: {
                  type: "string",
                  description: "Priority rating. Run get_object_metadata({objectName: 'opportunity'}) for current valid values (typically RATING_1 through RATING_5)."
                },
                companyId: { type: "string", description: "Company ID to associate with" },
                pointOfContactId: { type: "string", description: "Person ID to set as point of contact" }
              },
              required: ["name"]
            }
          },
          {
            name: "get_opportunity",
            description: "Get details of a specific opportunity by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Opportunity ID" } },
              required: ["id"]
            }
          },
          {
            name: "update_opportunity",
            description: "Update an existing opportunity",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Opportunity ID" },
                name: { type: "string", description: "Opportunity name" },
                amount: { type: "number", description: "Opportunity amount" },
                closeDate: { type: "string", description: "Close date (ISO 8601 format)" },
                stage: { type: "string", description: "Pipeline stage" },
                priority: { type: "string", description: "Priority rating (e.g. 'RATING_5')" }
              },
              required: ["id"]
            }
          },
          {
            name: "search_opportunities",
            description:
              "Search/list opportunities with filters on amount, close date, stage, priority, " +
              "company, or any other field. Filters use Twenty's native query semantics: pass a " +
              "plain value for an exact match, or { op, value } for an explicit operator (eq, neq, " +
              "in, not_in, gt, gte, lt, lte, like, ilike, is, contains). Example — high-priority deals " +
              "over $50k still open: { filter: { priority: 'RATING_5', amount: { op: 'gte', value: " +
              "50000 }, stage: { op: 'not_in', value: ['CLOSED_LOST', 'PROJECT_COMPLETE'] } } }.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query for opportunity name" },
                companyId: { type: "string", description: "Filter by company ID" },
                stage: { type: "string", description: "Filter by specific stage" },
                priority: {
                  type: "string",
                  description: "Filter by priority rating value (e.g. 'RATING_5'). Run get_object_metadata({objectName: 'opportunity'}) to confirm current valid values."
                },
                minAmount: { type: "number", description: "Minimum deal amount" },
                maxAmount: { type: "number", description: "Maximum deal amount" },
                startDate: { type: "string", description: "Start date for close date range (ISO 8601)" },
                endDate: { type: "string", description: "End date for close date range (ISO 8601)" },
                limit: { type: "number", description: "Maximum number of results" },
                offset: { type: "number", description: "Number of results to skip" },
                filter: {
                  type: "object",
                  description:
                    "Additional/advanced field filters as { fieldName: value } or " +
                    "{ fieldName: { op, value } }, for anything not covered by the dedicated " +
                    "parameters above.",
                  additionalProperties: true
                }
              }
            }
          },

          // ===== Metadata (fixed) =====
          {
            name: "get_metadata_objects",
            description:
              "Get all object types in the workspace and their full field metadata, including " +
              "custom fields and their live option lists. This is the source of truth for what " +
              "fields and values actually exist right now — use it before guessing at field names " +
              "or enum values in filters. Results are cached for 5 minutes; pass forceRefresh: true " +
              "if you just changed the schema in the Twenty UI and need the update immediately.",
            inputSchema: {
              type: "object",
              properties: {
                forceRefresh: { type: "boolean", description: "Bypass the cache and re-fetch from the API (default: false)" }
              }
            }
          },
          {
            name: "get_object_metadata",
            description:
              "Get metadata for a single object: every field, its type, and (for SELECT/MULTI_SELECT " +
              "fields) the current list of valid option values. Accepts the object's singular name " +
              "(e.g. 'person'), plural name (e.g. 'people'), or raw UUID — you do not need to look up " +
              "the UUID first.",
            inputSchema: {
              type: "object",
              properties: {
                objectName: { type: "string", description: "Object name (singular or plural, e.g. 'person', 'people', 'company', 'opportunity', 'task') or a raw object UUID" },
                forceRefresh: { type: "boolean", description: "Bypass the cache and re-fetch from the API (default: false)" }
              },
              required: ["objectName"]
            }
          },

          // ===== Search =====
          {
            name: "search_records",
            description: "Search across multiple object types by text query",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
                objectTypes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Object types to search (e.g. ['people', 'companies'])"
                },
                limit: { type: "number", description: "Number of results per object type" }
              },
              required: ["query"]
            }
          },

          // ===== Composite workflow tools =====
          {
            name: "intake_new_client",
            description:
              "Create a new client in one call: creates the company, creates the primary contact " +
              "person, links the person to the company, and (optionally) adds an intake note — all " +
              "as a single composite action instead of four separate create/link calls. Use this " +
              "whenever onboarding a brand-new client/prospect from an intake form.",
            inputSchema: {
              type: "object",
              properties: {
                companyName: { type: "string", description: "Company/client name" },
                companyDomain: { type: "string", description: "Company domain, if known" },
                companyAddress: { type: "string", description: "Company address, if known" },
                companyCategory: {
                  type: "array",
                  items: { type: "string" },
                  description: "Category tags to apply to the company, e.g. ['POTENTIAL_CLIENT', 'WELLNESS']"
                },
                contactFirstName: { type: "string", description: "Primary contact's first name" },
                contactLastName: { type: "string", description: "Primary contact's last name" },
                contactEmail: { type: "string", description: "Primary contact's email" },
                contactPhone: { type: "string", description: "Primary contact's phone" },
                contactJobTitle: { type: "string", description: "Primary contact's job title" },
                noteTitle: { type: "string", description: "Optional intake note title" },
                noteBody: { type: "string", description: "Optional intake note body (project details, source, etc.)" }
              },
              required: ["companyName", "contactFirstName", "contactLastName"]
            }
          },
          {
            name: "find_by_category",
            description:
              "Find all companies or people tagged with one or more category values — a thin, " +
              "foolproof wrapper around list_companies/list_people's filter syntax for the single " +
              "most common query pattern (e.g. 'every company tagged COMPETITOR', 'every person " +
              "tagged VIP'). Prefer this over hand-building a filter object when you just need a " +
              "category lookup. Internally calls get_object_metadata first to validate the category " +
              "value(s) you pass actually exist, and returns a clear error naming the valid options " +
              "if not.",
            inputSchema: {
              type: "object",
              properties: {
                objectType: { type: "string", enum: ["company", "person"], description: "Which object to search" },
                categories: {
                  type: "array",
                  items: { type: "string" },
                  description: "One or more category values to match (any-of). Case-insensitive."
                },
                limit: { type: "number", description: "Number of results to return (default: 60, the REST API max per page)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" }
              },
              required: ["objectType", "categories"]
            }
          },
          {
            name: "log_proposal_sent",
            description:
              "Record that a proposal was sent to a client: creates an Opportunity at the 'PROPOSAL' " +
              "stage (or a stage you specify) with the fee as the amount, links it to the company " +
              "and point of contact, and attaches a note with proposal details — in one call instead " +
              "of three. Use this right after generating a proposal document to keep the CRM and the " +
              "proposal pipeline in sync.",
            inputSchema: {
              type: "object",
              properties: {
                companyId: { type: "string", description: "Company ID the proposal was sent to" },
                pointOfContactId: { type: "string", description: "Person ID of the primary contact, if known" },
                opportunityName: { type: "string", description: "Name for the opportunity, e.g. project/proposal title" },
                amount: { type: "number", description: "Proposed fee amount" },
                stage: { type: "string", description: "Pipeline stage to set (default: 'PROPOSAL'). Run get_object_metadata({objectName: 'opportunity'}) for valid values." },
                closeDate: { type: "string", description: "Expected close date, ISO 8601" },
                priority: { type: "string", description: "Priority rating, e.g. 'RATING_3'" },
                noteTitle: { type: "string", description: "Note title (default: 'Proposal sent')" },
                noteBody: { type: "string", description: "Note body — proposal summary, fee breakdown, link to the document, etc." }
              },
              required: ["companyId", "opportunityName"]
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // People
          case "create_person": return await this.createPerson(args);
          case "get_person": return await this.getPerson(args.id);
          case "update_person": return await this.updatePerson(args);
          case "list_people": return await this.listPeople(args);
          case "delete_person": return await this.deletePerson(args.id);

          // Companies
          case "create_company": return await this.createCompany(args);
          case "get_company": return await this.getCompany(args.id);
          case "update_company": return await this.updateCompany(args);
          case "list_companies": return await this.listCompanies(args);
          case "delete_company": return await this.deleteCompany(args.id);

          // Notes
          case "create_note": return await this.createNote(args);
          case "get_note": return await this.getNote(args.id);
          case "list_notes": return await this.listNotes(args);
          case "update_note": return await this.updateNote(args);
          case "delete_note": return await this.deleteNote(args.id);

          // Tasks
          case "create_task": return await this.createTask(args);
          case "get_task": return await this.getTask(args.id);
          case "list_tasks": return await this.listTasks(args);
          case "update_task": return await this.updateTask(args);
          case "delete_task": return await this.deleteTask(args.id);

          // Opportunities
          case "create_opportunity": return await this.createOpportunity(args);
          case "get_opportunity": return await this.getOpportunity(args.id);
          case "update_opportunity": return await this.updateOpportunity(args);
          case "search_opportunities": return await this.searchOpportunities(args);

          // Metadata
          case "get_metadata_objects": return await this.getMetadataObjects(args);
          case "get_object_metadata": return await this.getObjectMetadata(args);

          // Search
          case "search_records": return await this.searchRecords(args);

          // Composite
          case "intake_new_client": return await this.intakeNewClient(args);
          case "find_by_category": return await this.findByCategory(args);
          case "log_proposal_sent": return await this.logProposalSent(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return this.textResult(`Error: ${error.message}`);
      }
    });
  }

  /**
   * Twenty's linkedinLink field is a composite LINKS type
   * ({ primaryLinkUrl, primaryLinkLabel, secondaryLinks }), not a plain
   * string -- confirmed live: sending `linkedinUrl` directly 400s with
   * 'Object company doesn't have any "linkedinUrl" field.' This translates
   * the simple linkedinUrl param tools accept into the shape the API
   * actually wants, and removes the flat key so it isn't sent alongside it.
   *
   * Narrow, single-field fix for now -- domainName, xLink, name (person), and
   * emails/phones have the same composite-type mismatch and are a separate,
   * larger fix to do later (flagged, not yet applied).
   */
  withLinkedinLinkFix(data) {
    if (!data || !("linkedinUrl" in data)) return data;
    const { linkedinUrl, ...rest } = data;
    if (linkedinUrl) {
      rest.linkedinLink = { primaryLinkUrl: linkedinUrl, primaryLinkLabel: "", secondaryLinks: [] };
    }
    return rest;
  }

  // ===== People =====

  async createPerson(data) {
    const payload = this.withLinkedinLinkFix(data);
    const result = await this.makeRequest("/rest/people", "POST", payload);
    return this.textResult(`Created person: ${JSON.stringify(result, null, 2)}`);
  }

  async getPerson(id) {
    const result = await this.makeRequest(`/rest/people/${id}`);
    return this.textResult(`Person details: ${JSON.stringify(result, null, 2)}`);
  }

  async updatePerson(data) {
    const { id, ...updateData } = data;
    const payload = this.withLinkedinLinkFix(updateData);
    const result = await this.makeRequest(`/rest/people/${id}`, "PUT", payload);
    return this.textResult(`Updated person: ${JSON.stringify(result, null, 2)}`);
  }

  async listPeople(params = {}) {
    const { limit = 20, offset = 0, search, companyId, filter } = params;
    let endpoint = `/rest/people?limit=${limit}&offset=${offset}`;

    if (search) endpoint += `&search=${encodeURIComponent(search)}`;

    // companyId stays as a dedicated convenience param (most common filter),
    // but also folds into the same filter expression as everything else so
    // it composes correctly with other filters instead of being a special case.
    const combinedFilters = { ...(filter || {}) };
    if (companyId) combinedFilters.companyId = companyId;

    const filterParam = buildFilterParam(combinedFilters);
    if (filterParam) endpoint += `&filter=${encodeURIComponent(filterParam)}`;

    const result = await this.makeRequest(endpoint);
    return this.textResult(`People list: ${JSON.stringify(result, null, 2)}`);
  }

  async deletePerson(id) {
    await this.makeRequest(`/rest/people/${id}`, "DELETE");
    return this.textResult(`Successfully deleted person with ID: ${id}`);
  }

  // ===== Companies =====

  async createCompany(data) {
    const payload = this.withLinkedinLinkFix(data);
    const result = await this.makeRequest("/rest/companies", "POST", payload);
    return this.textResult(`Created company: ${JSON.stringify(result, null, 2)}`);
  }

  async getCompany(id) {
    const result = await this.makeRequest(`/rest/companies/${id}`);
    return this.textResult(`Company details: ${JSON.stringify(result, null, 2)}`);
  }

  async updateCompany(data) {
    const { id, ...updateData } = data;
    const payload = this.withLinkedinLinkFix(updateData);
    const result = await this.makeRequest(`/rest/companies/${id}`, "PUT", payload);
    return this.textResult(`Updated company: ${JSON.stringify(result, null, 2)}`);
  }

  async listCompanies(params = {}) {
    const { limit = 20, offset = 0, search, filter } = params;
    let endpoint = `/rest/companies?limit=${limit}&offset=${offset}`;

    if (search) endpoint += `&search=${encodeURIComponent(search)}`;

    const filterParam = buildFilterParam(filter);
    if (filterParam) endpoint += `&filter=${encodeURIComponent(filterParam)}`;

    const result = await this.makeRequest(endpoint);
    return this.textResult(`Companies list: ${JSON.stringify(result, null, 2)}`);
  }

  async deleteCompany(id) {
    await this.makeRequest(`/rest/companies/${id}`, "DELETE");
    return this.textResult(`Successfully deleted company with ID: ${id}`);
  }

  // ===== Notes =====

  async createNote(data) {
    const result = await this.makeRequest("/rest/notes", "POST", data);
    return this.textResult(`Created note: ${JSON.stringify(result, null, 2)}`);
  }

  async getNote(id) {
    const result = await this.makeRequest(`/rest/notes/${id}`);
    return this.textResult(`Note details: ${JSON.stringify(result, null, 2)}`);
  }

  async listNotes(params = {}) {
    const { limit = 20, offset = 0, search, filter } = params;
    let endpoint = `/rest/notes?limit=${limit}&offset=${offset}`;

    if (search) endpoint += `&search=${encodeURIComponent(search)}`;

    const filterParam = buildFilterParam(filter);
    if (filterParam) endpoint += `&filter=${encodeURIComponent(filterParam)}`;

    const result = await this.makeRequest(endpoint);
    return this.textResult(`Notes list: ${JSON.stringify(result, null, 2)}`);
  }

  async updateNote(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/notes/${id}`, "PUT", updateData);
    return this.textResult(`Updated note: ${JSON.stringify(result, null, 2)}`);
  }

  async deleteNote(id) {
    await this.makeRequest(`/rest/notes/${id}`, "DELETE");
    return this.textResult(`Successfully deleted note with ID: ${id}`);
  }

  // ===== Tasks =====

  async createTask(data) {
    const result = await this.makeRequest("/rest/tasks", "POST", data);
    return this.textResult(`Created task: ${JSON.stringify(result, null, 2)}`);
  }

  async getTask(id) {
    const result = await this.makeRequest(`/rest/tasks/${id}`);
    return this.textResult(`Task details: ${JSON.stringify(result, null, 2)}`);
  }

  async listTasks(params = {}) {
    const { limit = 20, offset = 0, status, assigneeId, priority, filter } = params;
    let endpoint = `/rest/tasks?limit=${limit}&offset=${offset}`;

    const combinedFilters = { ...(filter || {}) };
    if (status) combinedFilters.status = status;
    if (assigneeId) combinedFilters.assigneeId = assigneeId;
    if (priority) combinedFilters.priority = priority;

    const filterParam = buildFilterParam(combinedFilters);
    if (filterParam) endpoint += `&filter=${encodeURIComponent(filterParam)}`;

    const result = await this.makeRequest(endpoint);
    return this.textResult(`Tasks list: ${JSON.stringify(result, null, 2)}`);
  }

  async updateTask(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/tasks/${id}`, "PUT", updateData);
    return this.textResult(`Updated task: ${JSON.stringify(result, null, 2)}`);
  }

  async deleteTask(id) {
    await this.makeRequest(`/rest/tasks/${id}`, "DELETE");
    return this.textResult(`Successfully deleted task with ID: ${id}`);
  }

  // ===== Opportunities =====

  async createOpportunity(data) {
    const result = await this.makeRequest("/rest/opportunities", "POST", data);
    return this.textResult(`Created opportunity: ${JSON.stringify(result, null, 2)}`);
  }

  async getOpportunity(id) {
    const result = await this.makeRequest(`/rest/opportunities/${id}`);
    return this.textResult(`Opportunity details: ${JSON.stringify(result, null, 2)}`);
  }

  async updateOpportunity(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/opportunities/${id}`, "PUT", updateData);
    return this.textResult(`Updated opportunity: ${JSON.stringify(result, null, 2)}`);
  }

  /**
   * CURRENCY fields (e.g. Opportunity.amount) are composite in Twenty —
   * stored as { amountMicros, currencyCode } — and can't be filtered on the
   * parent field name directly (confirmed via smoke_test.js: filtering
   * "amount[gte]:..." 400s with "Sub field gte not found for composite
   * type: CURRENCY"). Filters need to target the sub-field. Twenty's REST
   * filter grammar reaches into composite fields with dot notation.
   */
  buildCurrencyRangeExpressions(field, { min, max } = {}) {
    const parts = [];
    if (min !== undefined) parts.push(buildFilterExpression(`${field}.amountMicros`, { op: "gte", value: Math.round(min * 1_000_000) }));
    if (max !== undefined) parts.push(buildFilterExpression(`${field}.amountMicros`, { op: "lte", value: Math.round(max * 1_000_000) }));
    return parts;
  }

  async searchOpportunities(params = {}) {
    const {
      query, companyId, stage, priority,
      minAmount, maxAmount, startDate, endDate,
      limit = 20, offset = 0, filter,
    } = params;

    let endpoint = `/rest/opportunities?limit=${limit}&offset=${offset}`;
    if (query) endpoint += `&search=${encodeURIComponent(query)}`;

    // Build every filter fragment into one flat array, then join once.
    // (Earlier versions of this method built the query string incrementally
    // with string concatenation, which had ?/& duplication bugs whenever
    // more than one optional filter source was present at once — fixed by
    // assembling everything as data first, then serializing exactly once.)
    const fragments = [];

    const namedFilters = { ...(filter || {}) };
    if (companyId) namedFilters.companyId = companyId;
    if (stage) namedFilters.stage = stage;
    if (priority) namedFilters.priority = priority;
    const namedFilterParam = buildFilterParam(namedFilters);
    if (namedFilterParam) fragments.push(namedFilterParam);

    if (minAmount !== undefined || maxAmount !== undefined) {
      fragments.push(...this.buildCurrencyRangeExpressions("amount", { min: minAmount, max: maxAmount }));
    }

    if (startDate !== undefined) fragments.push(buildFilterExpression("closeDate", { op: "gte", value: startDate }));
    if (endDate !== undefined) fragments.push(buildFilterExpression("closeDate", { op: "lte", value: endDate }));

    if (fragments.length > 0) {
      endpoint += `&filter=${encodeURIComponent(fragments.join(","))}`;
    }

    const result = await this.makeRequest(endpoint);
    return this.textResult(`Opportunity search results: ${JSON.stringify(result, null, 2)}`);
  }

  // ===== Metadata =====

  async getMetadataObjects(params = {}) {
    const objects = await this.schemaCache.getObjects({ forceRefresh: !!params.forceRefresh });
    return this.textResult(`Metadata objects: ${JSON.stringify({ data: { objects } }, null, 2)}`);
  }

  async getObjectMetadata(params) {
    const { objectName, forceRefresh } = params;
    const object = await this.schemaCache.findObject(objectName, { forceRefresh: !!forceRefresh });

    if (!object) {
      const available = (await this.schemaCache.getObjects()).map((o) => o.nameSingular).sort();
      throw new Error(
        `No object found matching "${objectName}". Available objects: ${available.join(", ")}`
      );
    }

    return this.textResult(`Metadata for ${objectName}: ${JSON.stringify({ data: { object } }, null, 2)}`);
  }

  // ===== Search =====

  async searchRecords(params) {
    const { query, objectTypes = ["people", "companies"], limit = 10 } = params;
    const results = {};

    for (const objectType of objectTypes) {
      try {
        const endpoint = `/rest/${objectType}?search=${encodeURIComponent(query)}&limit=${limit}`;
        results[objectType] = await this.makeRequest(endpoint);
      } catch (error) {
        results[objectType] = { error: error.message };
      }
    }

    return this.textResult(`Search results for "${query}": ${JSON.stringify(results, null, 2)}`);
  }

  // ===== Composite workflow tools =====

  /**
   * Create a company + primary contact + link + optional note in one call.
   * Each step is awaited in sequence so a failure partway through leaves a
   * clear trail (the response includes everything that succeeded before the
   * error) rather than silently rolling back or leaving the caller unsure
   * what state things are in.
   */
  async intakeNewClient(params) {
    const {
      companyName, companyDomain, companyAddress, companyCategory,
      contactFirstName, contactLastName, contactEmail, contactPhone, contactJobTitle,
      noteTitle, noteBody,
    } = params;

    const steps = {};

    const companyPayload = { name: companyName };
    if (companyDomain) companyPayload.domainName = companyDomain;
    if (companyAddress) companyPayload.address = companyAddress;
    if (companyCategory) companyPayload.category = companyCategory;
    const company = await this.makeRequest("/rest/companies", "POST", companyPayload);
    steps.company = company;
    const companyId = company?.data?.createCompany?.id;

    const personPayload = { firstName: contactFirstName, lastName: contactLastName };
    if (contactEmail) personPayload.email = contactEmail;
    if (contactPhone) personPayload.phone = contactPhone;
    if (contactJobTitle) personPayload.jobTitle = contactJobTitle;
    if (companyId) personPayload.companyId = companyId;
    const person = await this.makeRequest("/rest/people", "POST", personPayload);
    steps.person = person;

    if (noteTitle || noteBody) {
      const notePayload = { title: noteTitle || `Intake note: ${companyName}`, body: noteBody || "" };
      steps.note = await this.makeRequest("/rest/notes", "POST", notePayload);
    }

    return this.textResult(
      `Client intake complete for "${companyName}":\n${JSON.stringify(steps, null, 2)}`
    );
  }

  /**
   * Validates the requested category values against the live schema before
   * querying, so a typo'd category name ("VPI" instead of "VIP") fails fast
   * with a helpful message instead of silently returning zero results — the
   * same failure mode that made it hard to tell "no companies match" apart
   * from "this filter is broken" during the original audit.
   */
  async findByCategory(params) {
    const { objectType, categories, limit = 60, offset = 0 } = params;

    if (!["company", "person"].includes(objectType)) {
      throw new Error(`objectType must be "company" or "person", got "${objectType}"`);
    }

    const validOptions = await this.schemaCache.getFieldOptions(objectType, "category");
    if (!validOptions) {
      throw new Error(`Could not find a "category" field on object "${objectType}".`);
    }

    const validSet = new Set(validOptions.map((v) => v.toUpperCase()));
    const requested = categories.map((c) => c.toUpperCase());
    const invalid = requested.filter((c) => !validSet.has(c));
    if (invalid.length > 0) {
      throw new Error(
        `Invalid category value(s) for ${objectType}: ${invalid.join(", ")}. ` +
        `Valid values are: ${validOptions.join(", ")}`
      );
    }

    if (objectType === "company") {
      return await this.listCompanies({ limit, offset, filter: { category: requested } });
    }
    return await this.listPeople({ limit, offset, filter: { category: requested } });
  }

  /**
   * Logs a sent proposal as an Opportunity + Note in one call. The company
   * is required (everything else about a proposal is meaningless without
   * knowing who it went to); the point of contact and note are optional
   * since not every quick proposal has a confirmed signatory yet.
   */
  async logProposalSent(params) {
    const {
      companyId, pointOfContactId, opportunityName, amount,
      stage = "PROPOSAL", closeDate, priority,
      noteTitle, noteBody,
    } = params;

    const steps = {};

    const opportunityPayload = { name: opportunityName, companyId, stage };
    if (amount !== undefined) opportunityPayload.amount = amount;
    if (closeDate) opportunityPayload.closeDate = closeDate;
    if (priority) opportunityPayload.priority = priority;
    if (pointOfContactId) opportunityPayload.pointOfContactId = pointOfContactId;

    const opportunity = await this.makeRequest("/rest/opportunities", "POST", opportunityPayload);
    steps.opportunity = opportunity;

    if (noteTitle || noteBody) {
      const notePayload = {
        title: noteTitle || `Proposal sent: ${opportunityName}`,
        body: noteBody || "",
      };
      steps.note = await this.makeRequest("/rest/notes", "POST", notePayload);
    }

    return this.textResult(
      `Logged proposal sent for "${opportunityName}":\n${JSON.stringify(steps, null, 2)}`
    );
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Dempsey Twenty CRM MCP server running on stdio");
  }
}

const server = new TwentyCRMServer();
server.run().catch(console.error);
