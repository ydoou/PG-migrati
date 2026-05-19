'use strict';

/**
 * inspector.js
 * ------------
 * Extracts metadata (schemas, extensions, enum types, sequences, tables,
 * constraints, indexes) from a PostgreSQL source database and produces DDL
 * statements ready to be executed against the target database.
 *
 * Notes:
 *  - Identifiers are always quoted with quoteIdent() to handle reserved words
 *    and mixed-case names safely.
 *  - For constraints and indexes we rely on pg_get_constraintdef / pg_get_indexdef
 *    so the produced DDL matches PostgreSQL's own representation exactly.
 */

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function quoteLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function qualified(schema, name) {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */
async function getSchemas(client, includeSchemas /* string[] | null */) {
  const sql = `
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND nspname NOT LIKE 'pg_temp_%'
      AND nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY nspname;
  `;
  const { rows } = await client.query(sql);
  let schemas = rows.map(r => r.schema_name);
  if (Array.isArray(includeSchemas) && includeSchemas.length > 0) {
    const set = new Set(includeSchemas);
    schemas = schemas.filter(s => set.has(s));
  }
  return schemas;
}

/* ------------------------------------------------------------------ */
/* Extensions                                                          */
/* ------------------------------------------------------------------ */
async function getExtensions(client) {
  const sql = `
    SELECT e.extname AS name, n.nspname AS schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname <> 'plpgsql'
    ORDER BY e.extname;
  `;
  const { rows } = await client.query(sql);
  return rows.map(r => ({
    name: r.name,
    schema: r.schema,
    ddl: `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(r.name)} WITH SCHEMA ${quoteIdent(r.schema)};`,
  }));
}

/* ------------------------------------------------------------------ */
/* Enum types                                                          */
/* ------------------------------------------------------------------ */
async function getEnumTypes(client, schemas) {
  if (schemas.length === 0) return [];
  const sql = `
    SELECT n.nspname AS schema,
           t.typname  AS name,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = ANY($1::text[])
    GROUP BY n.nspname, t.typname
    ORDER BY n.nspname, t.typname;
  `;
  const { rows } = await client.query(sql, [schemas]);
  return rows.map(r => ({
    schema: r.schema,
    name: r.name,
    labels: r.labels,
    ddl: `CREATE TYPE ${qualified(r.schema, r.name)} AS ENUM (${r.labels.map(quoteLiteral).join(', ')});`,
  }));
}

/* ------------------------------------------------------------------ */
/* Domains (custom types based on existing types with constraints)    */
/* ------------------------------------------------------------------ */
async function getDomains(client, schemas) {
  if (schemas.length === 0) return [];
  const sql = `
    SELECT n.nspname AS schema,
           t.typname AS name,
           pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type,
           t.typnotnull AS not_null,
           pg_get_expr(t.typdefaultbin, 0) AS default_expr
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype = 'd'
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, t.typname;
  `;
  const { rows } = await client.query(sql, [schemas]);
  return rows.map(r => {
    let ddl = `CREATE DOMAIN ${qualified(r.schema, r.name)} AS ${r.base_type}`;
    if (r.default_expr) ddl += ` DEFAULT ${r.default_expr}`;
    if (r.not_null) ddl += ' NOT NULL';
    ddl += ';';
    return { schema: r.schema, name: r.name, ddl };
  });
}

/* ------------------------------------------------------------------ */
/* Sequences                                                           */
/* ------------------------------------------------------------------ */
async function getSequences(client, schemas) {
  if (schemas.length === 0) return [];
  // First, list sequences in the requested schemas.
  const listSql = `
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, c.relname;
  `;
  const { rows: list } = await client.query(listSql, [schemas]);
  const sequences = [];
  for (const row of list) {
    // Check if the sequence is owned by a serial/identity column.
    // If so, we skip emitting CREATE SEQUENCE because the table DDL will
    // create it via SERIAL / GENERATED ... AS IDENTITY.
    const ownedSql = `
      SELECT a.attname AS column_name,
             c2.relname AS table_name,
             n.nspname  AS table_schema
      FROM pg_depend d
      JOIN pg_class c  ON c.oid  = d.objid    AND c.relkind = 'S'
      JOIN pg_class c2 ON c2.oid = d.refobjid AND c2.relkind IN ('r','p')
      JOIN pg_attribute a ON a.attrelid = c2.oid AND a.attnum = d.refobjsubid
      JOIN pg_namespace n  ON n.oid = c2.relnamespace
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE d.classid = 'pg_class'::regclass
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype IN ('a','i')
        AND ns.nspname = $1
        AND c.relname  = $2
      LIMIT 1;
    `;
    const { rows: ownedRows } = await client.query(ownedSql, [row.schema, row.name]);
    const ownedBy = ownedRows[0] || null;

    // Get sequence parameters from pg_sequences (PG 10+).
    const paramSql = `
      SELECT start_value, min_value, max_value, increment_by, cycle, cache_size
      FROM pg_sequences
      WHERE schemaname = $1 AND sequencename = $2;
    `;
    const { rows: paramRows } = await client.query(paramSql, [row.schema, row.name]);
    const p = paramRows[0] || {};

    // Current last value (used for setval after data load).
    let lastValue = null;
    let isCalled = false;
    try {
      const lvSql = `SELECT last_value, is_called FROM ${qualified(row.schema, row.name)};`;
      const { rows: lvRows } = await client.query(lvSql);
      if (lvRows[0]) {
        lastValue = lvRows[0].last_value;
        isCalled = lvRows[0].is_called;
      }
    } catch {
      /* ignore */
    }

    let ddl = `CREATE SEQUENCE IF NOT EXISTS ${qualified(row.schema, row.name)}`;
    if (p.increment_by != null) ddl += ` INCREMENT BY ${p.increment_by}`;
    if (p.min_value     != null) ddl += ` MINVALUE ${p.min_value}`;
    if (p.max_value     != null) ddl += ` MAXVALUE ${p.max_value}`;
    if (p.start_value   != null) ddl += ` START WITH ${p.start_value}`;
    if (p.cache_size    != null) ddl += ` CACHE ${p.cache_size}`;
    ddl += p.cycle ? ' CYCLE' : ' NO CYCLE';
    ddl += ';';

    sequences.push({
      schema: row.schema,
      name: row.name,
      ownedBy,
      lastValue,
      isCalled,
      ddl,
    });
  }
  return sequences;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */
async function getTables(client, schemas) {
  if (schemas.length === 0) return [];

  const tablesSql = `
    SELECT n.nspname AS schema,
           c.relname AS name,
           c.oid     AS oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, c.relname;
  `;
  const { rows: tableRows } = await client.query(tablesSql, [schemas]);

  const colSql = `
    SELECT a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr,
           a.attidentity AS identity,        -- '' | 'a' (always) | 'd' (default)
           a.attgenerated AS generated,      -- '' | 's' (stored)
           a.attnum AS position
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum;
  `;

  const tables = [];
  for (const t of tableRows) {
    const { rows: cols } = await client.query(colSql, [t.oid]);
    const columnDefs = cols.map(c => {
      let def = `${quoteIdent(c.name)} ${c.data_type}`;
      if (c.identity === 'a' || c.identity === 'd') {
        const kind = c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT';
        def += ` GENERATED ${kind} AS IDENTITY`;
      } else if (c.generated === 's' && c.default_expr) {
        def += ` GENERATED ALWAYS AS (${c.default_expr}) STORED`;
      } else if (c.default_expr) {
        def += ` DEFAULT ${c.default_expr}`;
      }
      if (c.not_null) def += ' NOT NULL';
      return def;
    });

    const ddl =
      `CREATE TABLE IF NOT EXISTS ${qualified(t.schema, t.name)} (\n  ` +
      columnDefs.join(',\n  ') +
      '\n);';

    tables.push({
      schema: t.schema,
      name: t.name,
      oid: t.oid,
      columns: cols.map(c => c.name),
      ddl,
    });
  }
  return tables;
}

/* ------------------------------------------------------------------ */
/* Constraints (PK, UNIQUE, CHECK, FK)                                 */
/* ------------------------------------------------------------------ */
async function getConstraints(client, schemas) {
  if (schemas.length === 0) return { primary: [], unique: [], check: [], foreign: [] };
  const sql = `
    SELECT n.nspname AS schema,
           c.relname AS table_name,
           con.conname AS name,
           con.contype AS type,           -- 'p','u','c','f'
           pg_get_constraintdef(con.oid, true) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[])
      AND con.contype IN ('p','u','c','f')
    ORDER BY n.nspname, c.relname,
             CASE con.contype
               WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 WHEN 'f' THEN 4
             END,
             con.conname;
  `;
  const { rows } = await client.query(sql, [schemas]);
  const out = { primary: [], unique: [], check: [], foreign: [] };
  for (const r of rows) {
    const ddl =
      `ALTER TABLE ${qualified(r.schema, r.table_name)} ` +
      `ADD CONSTRAINT ${quoteIdent(r.name)} ${r.def};`;
    const item = { schema: r.schema, table: r.table_name, name: r.name, ddl };
    if      (r.type === 'p') out.primary.push(item);
    else if (r.type === 'u') out.unique.push(item);
    else if (r.type === 'c') out.check.push(item);
    else if (r.type === 'f') out.foreign.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Indexes (excluding those backing PK/UNIQUE constraints)             */
/* ------------------------------------------------------------------ */
async function getIndexes(client, schemas) {
  if (schemas.length === 0) return [];
  const sql = `
    SELECT n.nspname AS schema,
           t.relname AS table_name,
           i.relname AS name,
           pg_get_indexdef(ix.indexrelid) AS def
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid
    WHERE n.nspname = ANY($1::text[])
      AND con.oid IS NULL
      AND t.relkind = 'r'
    ORDER BY n.nspname, t.relname, i.relname;
  `;
  const { rows } = await client.query(sql, [schemas]);
  return rows.map(r => ({
    schema: r.schema,
    table: r.table_name,
    name: r.name,
    ddl: r.def + ';',
  }));
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */
async function getViews(client, schemas) {
  if (schemas.length === 0) return [];
  const sql = `
    SELECT n.nspname AS schema,
           c.relname AS name,
           pg_get_viewdef(c.oid, true) AS def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v'
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, c.relname;
  `;
  const { rows } = await client.query(sql, [schemas]);
  return rows.map(r => ({
    schema: r.schema,
    name: r.name,
    ddl: `CREATE OR REPLACE VIEW ${qualified(r.schema, r.name)} AS\n${r.def};`,
  }));
}

/* ------------------------------------------------------------------ */
/* Row counts (for progress reporting)                                 */
/* ------------------------------------------------------------------ */
async function getApproxRowCount(client, schema, table) {
  const sql = `
    SELECT COALESCE(c.reltuples, 0)::bigint AS approx
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2;
  `;
  const { rows } = await client.query(sql, [schema, table]);
  return rows[0] ? Number(rows[0].approx) : 0;
}

async function getExactRowCount(client, schema, table) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::bigint AS n FROM ${qualified(schema, table)};`
  );
  return Number(rows[0].n);
}

module.exports = {
  SYSTEM_SCHEMAS,
  quoteIdent,
  quoteLiteral,
  qualified,
  getSchemas,
  getExtensions,
  getEnumTypes,
  getDomains,
  getSequences,
  getTables,
  getConstraints,
  getIndexes,
  getViews,
  getApproxRowCount,
  getExactRowCount,
};
