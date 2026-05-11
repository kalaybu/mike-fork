/**
 * Supabase-shape query shim over Microsoft SQL Server (mssql driver).
 *
 * The codebase has 185 call sites written against the @supabase/supabase-js
 * query builder ({ data, error } returns, .from().select().eq()...). This
 * file mimics that surface so those call sites work unchanged.
 *
 * Limitations vs the real client:
 *   - Only the methods actually used in this app are implemented.
 *   - .or() understands the small subset of PostgREST filter syntax we use:
 *     "col.eq.val" and "col.in.(v1,v2)" combinations separated by commas.
 *   - JSON columns are stored as nvarchar(max); the shim parses on read and
 *     stringifies on write based on a hardcoded column allow-list.
 *   - Datetime columns return ISO strings (mssql returns Date by default),
 *     to match what app code expects from PostgREST.
 *   - .upsert() is implemented as MERGE-style IF EXISTS / UPDATE-or-INSERT.
 */

import sql from "mssql";
import { getPool } from "./pool";

// ---------------------------------------------------------------------------
// Column-type metadata
// ---------------------------------------------------------------------------

// Columns stored as JSON-in-nvarchar(max). Values are JSON.parse'd on read
// and JSON.stringify'd on write.
const JSON_COLUMNS: Record<string, Set<string>> = {
    projects: new Set(["shared_with"]),
    documents: new Set(["structure_tree"]),
    workflows: new Set(["columns_config"]),
    chat_messages: new Set(["content", "files", "annotations"]),
    tabular_reviews: new Set(["columns_config", "shared_with"]),
    tabular_cells: new Set(["citations"]),
    tabular_review_chat_messages: new Set(["content", "annotations"]),
};

function isJsonColumn(table: string, column: string): boolean {
    return !!JSON_COLUMNS[table]?.has(column);
}

// ---------------------------------------------------------------------------
// Filter representation
// ---------------------------------------------------------------------------

type Op =
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "like"
    | "ilike"
    | "is"
    | "isnot"
    | "contains";
type Filter =
    | { kind: "cmp"; op: Op; col: string; val: unknown }
    | { kind: "or"; clauses: Filter[] };

// ---------------------------------------------------------------------------
// PostgREST-style "or" filter parser (only the subset we use)
// ---------------------------------------------------------------------------

function parseOrFilter(input: string): Filter[] {
    // Splits on commas at depth 0 (so commas inside `in.(...)` stay grouped).
    const parts: string[] = [];
    let depth = 0;
    let buf = "";
    for (const ch of input) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
            parts.push(buf);
            buf = "";
        } else {
            buf += ch;
        }
    }
    if (buf) parts.push(buf);
    return parts.map((p) => parseSingleFilter(p));
}

function parseSingleFilter(s: string): Filter {
    // shape: "col.op.value" or "col.in.(v1,v2,v3)"
    const m = s.match(/^([a-zA-Z0-9_]+)\.(eq|neq|gt|gte|lt|lte|in)\.(.+)$/);
    if (!m) throw new Error(`Unparseable filter: ${s}`);
    const [, col, op, raw] = m;
    if (op === "in") {
        const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
        const vals = inner.length > 0 ? inner.split(",") : [];
        return { kind: "cmp", op: "in", col, val: vals };
    }
    return { kind: "cmp", op: op as Op, col, val: raw };
}

// ---------------------------------------------------------------------------
// Result mappers
// ---------------------------------------------------------------------------

function mapRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
        if (v instanceof Date) {
            out[k] = v.toISOString();
        } else if (typeof v === "string" && isJsonColumn(table, k)) {
            try {
                out[k] = JSON.parse(v);
            } catch {
                out[k] = v;
            }
        } else {
            out[k] = v;
        }
    }
    return out;
}

function mapValues(
    table: string,
    values: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
        if (v === undefined) continue;
        if (isJsonColumn(table, k) && v !== null) {
            out[k] = JSON.stringify(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// SQL builder helpers
// ---------------------------------------------------------------------------

function ident(name: string): string {
    return `[${name.replace(/]/g, "]]")}]`;
}

type Param = { name: string; value: unknown };

function buildWhere(filters: Filter[], params: Param[]): string {
    if (filters.length === 0) return "";
    const parts = filters.map((f) => buildFilter(f, params));
    return ` where ${parts.join(" and ")}`;
}

function buildFilter(f: Filter, params: Param[]): string {
    if (f.kind === "or") {
        const parts = f.clauses.map((c) => buildFilter(c, params));
        return `(${parts.join(" or ")})`;
    }
    const { op, col, val } = f;
    if (op === "in") {
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) return "1 = 0";
        const placeholders = arr.map((v) => addParam(params, v));
        return `${ident(col)} in (${placeholders.join(", ")})`;
    }
    if (op === "is") {
        if (val === null) return `${ident(col)} is null`;
        const ph = addParam(params, val);
        return `${ident(col)} = ${ph}`;
    }
    if (op === "isnot") {
        if (val === null) return `${ident(col)} is not null`;
        const ph = addParam(params, val);
        return `${ident(col)} <> ${ph}`;
    }
    if (op === "contains") {
        // Used on JSON-array columns (e.g. projects.shared_with). The val is
        // expected to be an array-of-strings; we test that each item appears
        // in the JSON array via SQL Server's OPENJSON.
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) return "1 = 1";
        const conds = arr.map((v) => {
            const ph = addParam(params, v);
            return `exists (select 1 from openjson(${ident(col)}) j where j.value = ${ph})`;
        });
        return conds.join(" and ");
    }
    const placeholder = addParam(params, val);
    const cmpOp =
        op === "eq"
            ? "="
            : op === "neq"
            ? "<>"
            : op === "gt"
            ? ">"
            : op === "gte"
            ? ">="
            : op === "lt"
            ? "<"
            : op === "lte"
            ? "<="
            : op === "like"
            ? "like"
            : "like"; // ilike → SQL Server is case-insensitive by default for nvarchar
    return `${ident(col)} ${cmpOp} ${placeholder}`;
}

function addParam(params: Param[], value: unknown): string {
    const name = `p${params.length}`;
    params.push({ name, value });
    return `@${name}`;
}

async function runQuery(
    queryText: string,
    params: Param[],
): Promise<sql.IRecordSet<Record<string, unknown>>> {
    const pool = await getPool();
    const req = pool.request();
    for (const p of params) {
        req.input(p.name, p.value as never);
    }
    const result = await req.query(queryText);
    return result.recordset as sql.IRecordSet<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// QueryBuilder
// ---------------------------------------------------------------------------

type Mode = "select" | "insert" | "update" | "upsert" | "delete";
type ResultMode = "array" | "single" | "maybeSingle";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ApiResult<T = any> = {
    data: T;
    error: { message: string } | null;
    count?: number | null;
};

type UpsertOptions = { onConflict?: string; ignoreDuplicates?: boolean };

class QueryBuilder<T = any> {
    private mode: Mode = "select";
    private filters: Filter[] = [];
    private selectCols = "*";
    private orderClauses: { col: string; ascending: boolean }[] = [];
    private limitN: number | null = null;
    private rangeFromTo: [number, number] | null = null;
    private resultMode: ResultMode = "array";
    private writeValues: Record<string, unknown> | Record<string, unknown>[] | null =
        null;
    private upsertOpts: UpsertOptions = {};
    private hasReturning = false;
    private wantCount: "exact" | null = null;
    private headOnly = false;

    constructor(private table: string) {}

    // ---- Mode setters ----

    select(
        cols: string = "*",
        opts: { count?: "exact"; head?: boolean } = {},
    ): this {
        if (this.mode === "select") {
            this.selectCols = cols;
        } else {
            this.hasReturning = true;
            this.selectCols = cols;
        }
        if (opts.count) this.wantCount = opts.count;
        if (opts.head) this.headOnly = true;
        return this;
    }

    insert(values: any): this {
        this.mode = "insert";
        this.writeValues = values;
        return this;
    }

    update(values: Record<string, unknown>): this {
        this.mode = "update";
        this.writeValues = values;
        return this;
    }

    upsert(values: any, options: UpsertOptions = {}): this {
        this.mode = "upsert";
        this.writeValues = values;
        this.upsertOpts = options;
        return this;
    }

    delete(): this {
        this.mode = "delete";
        return this;
    }

    // ---- Filter methods ----

    eq(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "eq", col, val });
        return this;
    }
    neq(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "neq", col, val });
        return this;
    }
    gt(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "gt", col, val });
        return this;
    }
    gte(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "gte", col, val });
        return this;
    }
    lt(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "lt", col, val });
        return this;
    }
    lte(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "lte", col, val });
        return this;
    }
    in(col: string, vals: unknown[]): this {
        this.filters.push({ kind: "cmp", op: "in", col, val: vals });
        return this;
    }
    like(col: string, pattern: string): this {
        this.filters.push({ kind: "cmp", op: "like", col, val: pattern });
        return this;
    }
    ilike(col: string, pattern: string): this {
        this.filters.push({ kind: "cmp", op: "ilike", col, val: pattern });
        return this;
    }
    or(filter: string): this {
        const clauses = parseOrFilter(filter);
        this.filters.push({ kind: "or", clauses });
        return this;
    }
    is(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "is", col, val });
        return this;
    }
    not(col: string, op: string, val: unknown): this {
        // Translate the small subset of .not() forms the codebase uses.
        if (op === "is") {
            this.filters.push({ kind: "cmp", op: "isnot", col, val });
        } else if (op === "in") {
            // negate IN as NOT IN — emulate with a special op via OR-wrapping
            const arr = Array.isArray(val) ? val : [val];
            if (arr.length === 0) {
                // not in (empty) is always true
                return this;
            }
            // Push individually as neq joined by AND
            for (const v of arr) {
                this.filters.push({ kind: "cmp", op: "neq", col, val: v });
            }
        } else {
            // generic negation by flipping op
            const flipped: Op =
                op === "eq" ? "neq" : op === "neq" ? "eq" : ("neq" as Op);
            this.filters.push({ kind: "cmp", op: flipped, col, val });
        }
        return this;
    }
    contains(col: string, val: unknown): this {
        this.filters.push({ kind: "cmp", op: "contains", col, val });
        return this;
    }

    // ---- Result modifiers ----

    order(
        col: string,
        opts: { ascending?: boolean; nullsFirst?: boolean } = {},
    ): this {
        this.orderClauses.push({ col, ascending: opts.ascending !== false });
        return this;
    }
    limit(n: number): this {
        this.limitN = n;
        return this;
    }
    range(from: number, to: number): this {
        this.rangeFromTo = [from, to];
        return this;
    }
    single(): this {
        this.resultMode = "single";
        return this;
    }
    maybeSingle(): this {
        this.resultMode = "maybeSingle";
        return this;
    }

    // ---- Thenable ----

    then<TResult1 = ApiResult<T>, TResult2 = never>(
        onFulfilled?:
            | ((value: ApiResult<T>) => TResult1 | PromiseLike<TResult1>)
            | null
            | undefined,
        onRejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
            | undefined,
    ): Promise<TResult1 | TResult2> {
        return this.execute().then(onFulfilled, onRejected);
    }

    catch<TResult = never>(
        onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<ApiResult<T> | TResult> {
        return this.execute().catch(onRejected);
    }

    finally(onFinally?: (() => void) | null): Promise<ApiResult<T>> {
        return this.execute().finally(onFinally);
    }

    // ---- Execution ----

    private async execute(): Promise<ApiResult<T>> {
        try {
            switch (this.mode) {
                case "select":
                    return (await this.execSelect()) as ApiResult<T>;
                case "insert":
                    return (await this.execInsert()) as ApiResult<T>;
                case "update":
                    return (await this.execUpdate()) as ApiResult<T>;
                case "upsert":
                    return (await this.execUpsert()) as ApiResult<T>;
                case "delete":
                    return (await this.execDelete()) as ApiResult<T>;
            }
        } catch (e) {
            console.error(
                `[db.shim] ${this.mode} on ${this.table} failed:`,
                (e as Error).message,
            );
            return { data: null as T, error: { message: (e as Error).message } };
        }
    }

    private buildOrderLimit(params: Param[]): string {
        let out = "";
        if (this.orderClauses.length > 0) {
            const parts = this.orderClauses.map(
                (o) => `${ident(o.col)} ${o.ascending ? "asc" : "desc"}`,
            );
            out += ` order by ${parts.join(", ")}`;
        }
        if (this.rangeFromTo) {
            const [from, to] = this.rangeFromTo;
            const offset = from;
            const fetch = to - from + 1;
            // SQL Server requires an ORDER BY for OFFSET/FETCH.
            if (this.orderClauses.length === 0) {
                out += ` order by (select null)`;
            }
            out += ` offset ${offset} rows fetch next ${fetch} rows only`;
        } else if (this.limitN != null) {
            // top-N (handled elsewhere); kept for safety
            out += "";
        }
        // unused for now: params kept to match signature elsewhere
        void params;
        return out;
    }

    private finishRows(
        rows: Record<string, unknown>[],
    ): ApiResult<any> {
        const mapped = rows.map((r) => mapRow(this.table, r));
        if (this.resultMode === "single") {
            if (mapped.length !== 1) {
                return {
                    data: null,
                    error: { message: `Expected 1 row, got ${mapped.length}` },
                };
            }
            return { data: mapped[0], error: null };
        }
        if (this.resultMode === "maybeSingle") {
            return { data: mapped[0] ?? null, error: null };
        }
        return { data: mapped, error: null };
    }

    private async execSelect(): Promise<ApiResult<any>> {
        const params: Param[] = [];
        const colList = this.selectCols === "*" ? "*" : this.selectCols;
        const top =
            this.limitN != null && !this.rangeFromTo ? `top (${this.limitN}) ` : "";
        const where = buildWhere(this.filters, params);

        // head + count: just COUNT(*) — don't materialise rows.
        if (this.headOnly && this.wantCount) {
            const text = `select count(*) as cnt from ${ident(this.table)}${where}`;
            const rows = await runQuery(text, params);
            const count = Number((rows[0]?.cnt as number | bigint) ?? 0);
            return { data: null, error: null, count };
        }

        const orderLimit = this.buildOrderLimit(params);
        const text = `select ${top}${colList} from ${ident(this.table)}${where}${orderLimit}`;
        const rows = await runQuery(text, params);
        const result = this.finishRows(rows);
        if (this.wantCount) {
            const countParams: Param[] = [];
            const countWhere = buildWhere(this.filters, countParams);
            const countText = `select count(*) as cnt from ${ident(this.table)}${countWhere}`;
            const countRows = await runQuery(countText, countParams);
            (result as ApiResult).count = Number(
                (countRows[0]?.cnt as number | bigint) ?? 0,
            );
        }
        return result;
    }

    private async execInsert(): Promise<ApiResult<any>> {
        const params: Param[] = [];
        const rows = Array.isArray(this.writeValues)
            ? this.writeValues
            : [this.writeValues!];
        const cleaned = rows.map((r) =>
            mapValues(this.table, r as Record<string, unknown>),
        );
        if (cleaned.length === 0) return { data: [], error: null };
        const cols = Object.keys(cleaned[0]);
        const colSql = cols.map((c) => ident(c)).join(", ");
        const valuesSql = cleaned
            .map((r) => {
                const phs = cols.map((c) => addParam(params, r[c] ?? null));
                return `(${phs.join(", ")})`;
            })
            .join(", ");

        const output = this.hasReturning
            ? ` output ${this.selectCols === "*"
                ? "inserted.*"
                : this.selectCols
                      .split(",")
                      .map((c) => `inserted.${ident(c.trim())}`)
                      .join(", ")}`
            : "";

        const text = `insert into ${ident(this.table)} (${colSql})${output} values ${valuesSql}`;
        const result = await runQuery(text, params);
        if (this.hasReturning) {
            return this.finishRows(result);
        }
        return { data: null, error: null };
    }

    private async execUpdate(): Promise<ApiResult<any>> {
        const params: Param[] = [];
        const cleaned = mapValues(
            this.table,
            this.writeValues as Record<string, unknown>,
        );
        const cols = Object.keys(cleaned);
        if (cols.length === 0) return { data: null, error: null };
        const setSql = cols
            .map((c) => `${ident(c)} = ${addParam(params, cleaned[c] ?? null)}`)
            .join(", ");
        const where = buildWhere(this.filters, params);
        const output = this.hasReturning
            ? ` output ${this.selectCols === "*"
                ? "inserted.*"
                : this.selectCols
                      .split(",")
                      .map((c) => `inserted.${ident(c.trim())}`)
                      .join(", ")}`
            : "";
        const text = `update ${ident(this.table)} set ${setSql}${output}${where}`;
        const result = await runQuery(text, params);
        if (this.hasReturning) {
            return this.finishRows(result);
        }
        return { data: null, error: null };
    }

    private async execDelete(): Promise<ApiResult<any>> {
        const params: Param[] = [];
        const where = buildWhere(this.filters, params);
        if (!where) {
            return {
                data: null,
                error: { message: "Refusing DELETE without WHERE" },
            };
        }
        const text = `delete from ${ident(this.table)}${where}`;
        await runQuery(text, params);
        return { data: null, error: null };
    }

    private async execUpsert(): Promise<ApiResult<any>> {
        // We support the patterns the codebase actually uses:
        //   .upsert({...}, { onConflict: "user_id", ignoreDuplicates: true })
        //   .upsert({...}) — used a few places, behaves like INSERT-or-UPDATE
        const conflictCol = this.upsertOpts.onConflict;
        const ignore = this.upsertOpts.ignoreDuplicates === true;
        const cleaned = mapValues(
            this.table,
            this.writeValues as Record<string, unknown>,
        );
        if (!conflictCol) {
            // No conflict target — treat as plain INSERT.
            const params: Param[] = [];
            const cols = Object.keys(cleaned);
            const colSql = cols.map((c) => ident(c)).join(", ");
            const phs = cols.map((c) => addParam(params, cleaned[c] ?? null));
            const text = `insert into ${ident(this.table)} (${colSql}) values (${phs.join(", ")})`;
            await runQuery(text, params);
            return { data: null, error: null };
        }

        const params: Param[] = [];
        const conflictPlaceholder = addParam(params, cleaned[conflictCol] ?? null);
        const cols = Object.keys(cleaned);
        const colSql = cols.map((c) => ident(c)).join(", ");
        const valuePlaceholders = cols.map((c) =>
            addParam(params, cleaned[c] ?? null),
        );
        if (ignore) {
            const text =
                `if not exists (select 1 from ${ident(this.table)} where ${ident(conflictCol)} = ${conflictPlaceholder}) ` +
                `insert into ${ident(this.table)} (${colSql}) values (${valuePlaceholders.join(", ")})`;
            await runQuery(text, params);
            return { data: null, error: null };
        }
        const setSql = cols
            .filter((c) => c !== conflictCol)
            .map((c) => `${ident(c)} = ${addParam(params, cleaned[c] ?? null)}`)
            .join(", ");
        const updateClause = setSql ? ` else update ${ident(this.table)} set ${setSql} where ${ident(conflictCol)} = ${conflictPlaceholder}` : "";
        const text =
            `if not exists (select 1 from ${ident(this.table)} where ${ident(conflictCol)} = ${conflictPlaceholder}) ` +
            `insert into ${ident(this.table)} (${colSql}) values (${valuePlaceholders.join(", ")})` +
            updateClause;
        await runQuery(text, params);
        return { data: null, error: null };
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export class DbClient {
    from<T = any>(table: string): QueryBuilder<T> {
        return new QueryBuilder<T>(table);
    }
}
