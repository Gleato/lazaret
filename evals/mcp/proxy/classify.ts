import { loadModule, parse } from "libpg-query";

// Which MCP tool calls are writes. Fails closed: a call is a read only when it can be
// shown to be one, and anything this can't show (an unknown tool, SQL that won't parse,
// a node type it doesn't know) is a write and goes to review.
//
// `execute_sql` is a read only for one plain SELECT (or VALUES, or a WITH whose parts are
// all SELECTs) built from the node types below, calling only allowlisted functions,
// operators and casts to built-in types. SQL is parsed by the real Postgres parser
// (libpg-query, Postgres 17 like the local stack).
//
// Known limit: names in FROM aren't resolved, so a SELECT from a view that calls a
// side-effecting function counts as a read. The seeded app has no such view.

/** Tools the local server marks read-only (README, step 1). Every other name is a write. */
const READ_TOOLS = new Set([
  "list_tables",
  "list_extensions",
  "list_migrations",
  "query_logs",
  "get_advisors",
  "get_project_url",
  "get_publishable_keys",
  "generate_typescript_types",
  "search_docs",
]);

/** Node types a read may contain. Not here (INSERT/UPDATE/DELETE/MERGE, INTO, FOR UPDATE, …): a write. */
const READ_NODES = new Set([
  "SelectStmt",
  "WithClause",
  "CommonTableExpr",
  "ResTarget",
  "ColumnRef",
  "A_Star",
  "A_Const",
  "String",
  "Integer",
  "Float",
  "Boolean",
  "A_Expr",
  "BoolExpr",
  "BooleanTest",
  "NullTest",
  "SubLink",
  "CaseExpr",
  "CaseWhen",
  "CoalesceExpr",
  "NullIfExpr",
  "MinMaxExpr",
  "A_ArrayExpr",
  "A_Indirection",
  "A_Indices",
  "RowExpr",
  "List",
  "RangeVar",
  "RangeSubselect",
  "RangeFunction",
  "JoinExpr",
  "Alias",
  "SortBy",
  "WindowDef",
  "GroupingSet",
  "SQLValueFunction",
  "ParamRef",
  "FuncCall",
  "TypeCast",
  "TypeName",
]);

/** Built-in pure functions (and aggregates) a read may call, unqualified or in pg_catalog. */
const READ_FUNCTIONS = new Set([
  ...["count", "sum", "avg", "min", "max", "bool_and", "bool_or"],
  ...["array_agg", "string_agg", "json_agg", "jsonb_agg", "row_number", "rank"],
  ...["lower", "upper", "length", "trim", "btrim", "substring", "left", "right", "concat"],
  ...["position", "replace", "abs", "round", "floor", "ceil"],
  ...["now", "date_trunc", "extract", "date_part", "age", "to_char"],
]);

const READ_OPERATORS = new Set(
  "= <> != < > <= >= + - * / % || ~~ ~~* !~~ !~~* ~ ~* !~ !~* -> ->> #> #>> @> <@ ? && ".split(" "),
);

const READ_TYPES = new Set(
  "int2 int4 int8 integer bigint smallint numeric float4 float8 text varchar bpchar bool date time timestamp timestamptz interval uuid json jsonb".split(
    " ",
  ),
);

type Node = Record<string, unknown>;

/** `[{String:{sval:"pg_catalog"}},{String:{sval:"count"}}]` → `["pg_catalog","count"]`. */
function names(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const item of list) {
    const sval = (item as { String?: { sval?: unknown } })?.String?.sval;
    if (typeof sval !== "string") return null;
    out.push(sval);
  }
  return out;
}

/** A built-in name from the allowlist: unqualified, or qualified with pg_catalog only. */
function builtin(list: unknown, allowed: Set<string>): boolean {
  const n = names(list);
  if (!n || n.length === 0 || n.length > 2) return false;
  if (n.length === 2 && n[0] !== "pg_catalog") return false;
  return allowed.has(n.at(-1) as string);
}

/**
 * True only if every node under `value` is one a read may contain. Generic node fields
 * come wrapped in their type (`{"FuncCall": {...}}`), but typed fields don't
 * (`"intoClause": {...}`, `"typeName": {...}`), so those are checked by field name.
 */
function readOnly(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(readOnly);
  if (value === null || typeof value !== "object") return true;
  const node = value as Node;
  if ("intoClause" in node || "lockingClause" in node) return false; // SELECT INTO, FOR UPDATE
  if ("typeName" in node && !builtin((node.typeName as Node)?.names, READ_TYPES)) return false;
  for (const op of ["operName", "useOp"])
    if (op in node && !builtin(node[op], READ_OPERATORS)) return false;
  for (const [key, child] of Object.entries(node)) {
    // Node types are the capitalised keys; fields are lower-case.
    if (/^[A-Z]/.test(key)) {
      if (!READ_NODES.has(key)) return false;
      const inner = child as Node;
      if (key === "FuncCall" && !builtin(inner.funcname, READ_FUNCTIONS)) return false;
      if (key === "A_Expr" && !builtin(inner.name, READ_OPERATORS)) return false;
      if (key === "TypeName" && !builtin(inner.names, READ_TYPES)) return false;
    }
    if (!readOnly(child)) return false;
  }
  return true;
}

let loading: Promise<void> | null = null;

/** Optional: hand the parser its WASM (a Worker imports it as a module; Node reads the file). */
export function loadParser(wasm?: WebAssembly.Module): Promise<void> {
  // The wrapper accepts a compiled module, though its types list only bytes.
  loading ??= loadModule(wasm ? { wasm: wasm as unknown as ArrayBuffer } : undefined).catch(
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

/** True when this SQL is provably one plain read. */
export async function isReadSql(sql: unknown): Promise<boolean> {
  if (typeof sql !== "string") return false;
  try {
    await loadParser();
    const { stmts } = await parse(sql);
    if (stmts?.length !== 1) return false;
    const stmt = stmts[0]?.stmt as Node | undefined;
    if (!stmt || Object.keys(stmt).join() !== "SelectStmt") return false;
    return readOnly(stmt);
  } catch {
    return false; // won't parse: a write
  }
}

/** True when this `tools/call` must go through review. */
export async function isWriteCall(name: unknown, args: unknown): Promise<boolean> {
  if (name === "execute_sql")
    return !(await isReadSql((args as { query?: unknown } | null)?.query));
  return typeof name !== "string" || !READ_TOOLS.has(name);
}
