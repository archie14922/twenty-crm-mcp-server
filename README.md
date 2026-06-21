# Dempsey Twenty CRM MCP Server (fork)

Forked from [mhenry3164/twenty-crm-mcp-server](https://github.com/mhenry3164/twenty-crm-mcp-server)
to close gaps found during a live audit against Eric's Twenty workspace.

## What changed vs. upstream

1. **Field filtering.** `list_companies`, `list_people`, `list_tasks`, and
   `search_opportunities` now accept a `filter` object (plus a couple of
   dedicated convenience params like `priority`) that maps to Twenty's real
   REST filter syntax: `filter=field[operator]:value`. This is what makes
   "list every company tagged COMPETITOR" or "every task at priority 5"
   actually possible — neither was reachable before.

2. **Fixed metadata tools.** `get_field_metadata` and `get_object_schema`
   from the connector you were using were broken (`Unknown type
   "ObjectFilterInput"` — they were written against a GraphQL type that
   no longer exists). They're removed. `get_metadata_objects` and
   `get_object_metadata` are the only schema tools now, and
   `get_object_metadata` accepts a singular name (`person`), plural name
   (`people`), or raw UUID — previously it silently required a UUID despite
   its own description saying otherwise.

3. **Live enum descriptions.** Tool descriptions no longer hardcode option
   lists (the old `update_person` description listed 7 category values;
   the real, live list has 28, including `VIP`). Every tool that touches a
   SELECT/MULTI_SELECT field now tells the model to check
   `get_object_metadata` first.

4. **Composite tools** for the multi-step workflows that came up most:
   - `intake_new_client` — company + contact + link + note, one call
   - `find_by_category` — foolproof category lookup with input validation
   - `log_proposal_sent` — opportunity + note, logged right after sending a proposal

## Setup

```bash
npm install
```

Then point Claude Desktop's config at this folder instead of the old one:

```json
{
  "mcpServers": {
    "twenty-crm": {
      "command": "node",
      "args": ["/path/to/dempsey-twenty-mcp/index.js"],
      "env": {
        "TWENTY_API_KEY": "your_api_key_here",
        "TWENTY_BASE_URL": "https://api.twenty.com"
      }
    }
  }
}
```

(Same env vars as before — nothing changes there.)

## Validate before switching over

A standalone smoke test is included. It hits your real Twenty workspace
read-only by default:

```bash
TWENTY_API_KEY=your_key TWENTY_BASE_URL=https://api.twenty.com node smoke_test.js
```

It checks, against live data:
- metadata tools resolve `person`/`people`/`opportunity`/`task` correctly
- `priority` fields exist where expected on Task and Opportunity
- the new filter syntax actually returns only matching records (e.g. every
  company returned by a `category: COMPETITOR` filter genuinely has
  COMPETITOR in its category array — not just that the call didn't error)
- the category-validation logic in `find_by_category` would correctly
  reject a bogus value

Pass `--write` to additionally test a create+delete round-trip (creates one
throwaway company and deletes it immediately):

```bash
TWENTY_API_KEY=your_key node smoke_test.js --write
```

Run `VERBOSE=1` alongside either of the above if you want to see the raw
response bodies for each check.

## Filter syntax reference (for writing new tool calls)

```js
// Exact match
{ filter: { category: "VIP" } }

// Any of (array on a MULTI_SELECT field defaults to "containsAny")
{ filter: { category: ["COMPETITOR", "ARCHITECTURE"] } }

// Explicit operator
{ filter: { employees: { op: "gte", value: 50 } } }
{ filter: { city: { op: "ilike", value: "palm" } } }

// Multiple filters (combined with AND)
{ filter: { category: ["VIP"], city: { op: "ilike", value: "west palm" } } }
```

Valid operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
`is`, `contains`, `containsAny`, `isEmptyArray`.

**Important — operators are type-specific in Twenty, confirmed by live testing:**
- `in` / `not_in` **do not exist** in Twenty's grammar (an early draft of
  this fork assumed they did; the live smoke test caught it). Don't use them.
- MULTI_SELECT fields (e.g. `category`) only accept `containsAny`, `is`,
  `isEmptyArray`. An array value defaults to `containsAny` automatically.
- CURRENCY fields (e.g. Opportunity `amount`) are composite —
  `{ amountMicros, currencyCode }` under the hood — and can't be filtered
  on the parent field name. Use `searchOpportunities`'s `minAmount`/
  `maxAmount` params (handled for you), or if filtering a CURRENCY field
  directly, target the sub-field: `amount.amountMicros[gte]:50000000`
  (micros, i.e. dollars × 1,000,000).
- If you hit a 400 with a message like `Operator "X" is not valid for
  field "Y" of type Z — Allowed operators: ...`, that message is
  authoritative. Trust the live error over this document or over the tool
  description — schemas and allowed-operator lists can change as Twenty
  evolves.

## Known limitations / next steps

- `get_metadata_objects` is cached in-memory for 5 minutes per server
  process. If you change the schema in the Twenty UI and need it reflected
  immediately, pass `forceRefresh: true` to either metadata tool.
- Only a few composite tools exist so far (`intake_new_client`,
  `find_by_category`, `log_proposal_sent`). If another multi-step pattern
  comes up often, it's a small addition — same shape as the existing ones.
- **Round one of live testing (this session) found and fixed two real bugs**
  that static testing alone couldn't catch, because they depend on Twenty's
  actual per-field-type validation rules rather than general REST
  conventions:
  - The original filter operator set included `in`/`not_in`, which don't
    exist in Twenty's grammar at all.
  - MULTI_SELECT fields only accept `containsAny`/`is`/`isEmptyArray` — not
    a generic equality/membership operator.
  - CURRENCY fields are composite and need the `.amountMicros` sub-field
    targeted directly; filtering the parent field name 400s.
  Both are fixed in this version and `smoke_test.js` now asserts the correct
  behavior. **Re-run the smoke test after pulling this update** to confirm
  the fixes hold against your live workspace before relying on it.
