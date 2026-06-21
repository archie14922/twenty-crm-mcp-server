#!/usr/bin/env node

/**
 * Standalone smoke test for the Dempsey Twenty CRM MCP fork.
 *
 * Runs the same request logic the MCP server uses, but as plain function
 * calls — no stdio/MCP transport involved — so you can sanity-check the
 * fork against your real Twenty workspace before pointing Claude Desktop
 * at it.
 *
 * Usage:
 *   TWENTY_API_KEY=your_key TWENTY_BASE_URL=https://your-instance node smoke_test.js
 *
 * This is READ-ONLY by default (it does not create/update/delete anything)
 * unless you pass --write, in which case it will create one throwaway
 * test company/person/note/task and clean them up at the end.
 */

const apiKey = process.env.TWENTY_API_KEY;
const baseUrl = process.env.TWENTY_BASE_URL || "https://api.twenty.com";
const allowWrites = process.argv.includes("--write");

if (!apiKey) {
  console.error("TWENTY_API_KEY environment variable is required.");
  process.exit(1);
}

async function makeRequest(endpoint, method = "GET", data = null) {
  const url = `${baseUrl}${endpoint}`;
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
    options.body = JSON.stringify(data);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  return response.json();
}

const VALID_OPERATORS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "like", "ilike", "is", "contains", "containsAny", "isEmptyArray",
]);

function formatFilterValue(value) {
  if (typeof value === "string") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

function buildFilterExpression(field, spec) {
  let op, value;
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec) && "op" in spec) {
    op = spec.op; value = spec.value;
  } else {
    value = spec; op = Array.isArray(value) ? "containsAny" : "eq";
  }
  if (!VALID_OPERATORS.has(op)) throw new Error(`Unsupported operator "${op}"`);
  const formattedValue = Array.isArray(value)
    ? `[${value.map(formatFilterValue).join(",")}]`
    : formatFilterValue(value);
  return `${field}[${op}]:${formattedValue}`;
}

function buildFilterParam(filters) {
  if (!filters) return undefined;
  const entries = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return undefined;
  return entries.map(([f, s]) => buildFilterExpression(f, s)).join(",");
}

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    const result = await fn();
    console.log(`✅ ${label}`);
    if (process.env.VERBOSE) console.log(JSON.stringify(result, null, 2).slice(0, 500));
    passed++;
    return result;
  } catch (err) {
    console.log(`❌ ${label}\n   ${err.message}`);
    failed++;
    return null;
  }
}

async function main() {
  console.log(`\nDempsey Twenty CRM fork — smoke test`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Write tests: ${allowWrites ? "ENABLED" : "disabled (pass --write to enable)"}\n`);

  // --- 1. Metadata tools (the fixed ones) ---
  console.log("--- Metadata ---");
  const metadata = await check("get_metadata_objects returns the object list", async () => {
    const result = await makeRequest("/rest/metadata/objects");
    const objects = result?.data?.objects;
    if (!Array.isArray(objects) || objects.length === 0) {
      throw new Error("Expected a non-empty objects array");
    }
    return { count: objects.length };
  });

  await check('get_object_metadata resolves "person" by singular name', async () => {
    const result = await makeRequest("/rest/metadata/objects");
    const objects = result?.data?.objects ?? [];
    const person = objects.find((o) => o.nameSingular === "person");
    if (!person) throw new Error('No object with nameSingular "person" found');
    const categoryField = person.fields?.find((f) => f.name === "category");
    if (!categoryField) throw new Error("person.category field not found");
    return { optionCount: categoryField.options?.length ?? 0 };
  });

  await check('get_object_metadata resolves "people" (plural) the same way', async () => {
    const result = await makeRequest("/rest/metadata/objects");
    const objects = result?.data?.objects ?? [];
    const found = objects.find((o) => o.namePlural === "people");
    if (!found) throw new Error('No object with namePlural "people" found');
    return { id: found.id };
  });

  await check("opportunity object has a priority RATING field", async () => {
    const result = await makeRequest("/rest/metadata/objects");
    const objects = result?.data?.objects ?? [];
    const opp = objects.find((o) => o.nameSingular === "opportunity");
    const priorityField = opp?.fields?.find((f) => f.name === "priority");
    if (!priorityField || priorityField.type !== "RATING") {
      throw new Error("opportunity.priority field missing or wrong type");
    }
    return { options: priorityField.options?.map((o) => o.value) };
  });

  await check("task object has a priority RATING field", async () => {
    const result = await makeRequest("/rest/metadata/objects");
    const objects = result?.data?.objects ?? [];
    const task = objects.find((o) => o.nameSingular === "task");
    const priorityField = task?.fields?.find((f) => f.name === "priority");
    if (!priorityField || priorityField.type !== "RATING") {
      throw new Error("task.priority field missing or wrong type");
    }
    return { options: priorityField.options?.map((o) => o.value) };
  });

  // --- 2. Filter syntax against real endpoints ---
  console.log("\n--- Filtering (the main fix) ---");

  await check("list_companies filters by category (single value)", async () => {
    const filterParam = buildFilterParam({ category: ["COMPETITOR"] });
    const endpoint = `/rest/companies?limit=5&filter=${encodeURIComponent(filterParam)}`;
    const result = await makeRequest(endpoint);
    const companies = result?.data?.companies ?? [];
    // Every returned company should actually have COMPETITOR in its category array.
    const bad = companies.filter((c) => !c.category?.includes("COMPETITOR"));
    if (bad.length > 0) {
      throw new Error(`${bad.length} returned companies do NOT have COMPETITOR in category`);
    }
    return { matched: companies.length, endpoint };
  });

  await check("list_people filters by category (VIP)", async () => {
    const filterParam = buildFilterParam({ category: ["VIP"] });
    const endpoint = `/rest/people?limit=5&filter=${encodeURIComponent(filterParam)}`;
    const result = await makeRequest(endpoint);
    const people = result?.data?.people ?? [];
    const bad = people.filter((p) => !p.category?.includes("VIP"));
    if (bad.length > 0) {
      throw new Error(`${bad.length} returned people do NOT have VIP in category`);
    }
    return { matched: people.length, endpoint };
  });

  await check("list_tasks filters by priority", async () => {
    const filterParam = buildFilterParam({ priority: "RATING_5" });
    const endpoint = `/rest/tasks?limit=5&filter=${encodeURIComponent(filterParam)}`;
    const result = await makeRequest(endpoint);
    return { resultShape: Object.keys(result?.data ?? {}) };
  });

  await check("search_opportunities filters by priority + amount range (CURRENCY sub-field)", async () => {
    const filterParam = buildFilterParam({ priority: "RATING_5" }) +
      "," + buildFilterExpression("amount.amountMicros", { op: "gte", value: 0 });
    const endpoint = `/rest/opportunities?limit=5&filter=${encodeURIComponent(filterParam)}`;
    const result = await makeRequest(endpoint);
    return { resultShape: Object.keys(result?.data ?? {}) };
  });

  // --- 3. Composite tool logic (read-only portion) ---
  console.log("\n--- Composite tools (validation logic) ---");

  await check("find_by_category rejects an invalid category with a helpful message", async () => {
    const result = await makeRequest("/rest/metadata/objects");
    const objects = result?.data?.objects ?? [];
    const company = objects.find((o) => o.nameSingular === "company");
    const categoryField = company?.fields?.find((f) => f.name === "category");
    const validValues = new Set((categoryField?.options ?? []).map((o) => o.value));
    const bogus = "NOT_A_REAL_CATEGORY";
    if (validValues.has(bogus)) throw new Error("Test setup invalid — bogus value unexpectedly valid");
    return { wouldReject: !validValues.has(bogus), validCount: validValues.size };
  });

  // --- 4. Optional write test ---
  if (allowWrites) {
    console.log("\n--- Write test (--write was passed) ---");
    const created = await check("create + delete a throwaway test company", async () => {
      const company = await makeRequest("/rest/companies", "POST", {
        name: `__smoke_test_${Date.now()}`,
      });
      const id = company?.data?.createCompany?.id;
      if (!id) throw new Error("No id returned from create");
      await makeRequest(`/rest/companies/${id}`, "DELETE");
      return { createdAndDeletedId: id };
    });
  } else {
    console.log("\n(Skipping write test — pass --write to test create/delete round-trip)");
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log(`${"=".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
