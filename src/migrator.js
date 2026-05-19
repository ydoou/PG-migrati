'use strict';

/**
 * migrator.js
 * -----------
 * Orchestrates a full PostgreSQL → PostgreSQL migration.
 *
 * Phases:
 *   1. Connect to source and target.
 *   2. Inspect source: schemas, extensions, types, sequences, tables, etc.
 *   3. Apply structural DDL on target (no constraints / indexes yet).
 *   4. Copy data per-table using binary COPY (fast, type-safe).
 *   5. Restore sequence values (setval).
 *   6. Apply post-data DDL: PK / UNIQUE / CHECK / FK / indexes / views.
 *
 * Progress and log events are emitted through an EventEmitter so the HTTP
 * layer can stream them to the UI via Server-Sent Events.
 */

const { Client } = require('pg');
const { from: copyFrom, to: copyTo } = require('pg-copy-streams');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');

const inspector = require('./inspector');
const { quoteIdent, qualified } = inspector;

function buildClientConfig(conn) {
  if (conn && typeof conn === 'object' && conn.connectionString) {
    return {
      connectionString: conn.connectionString,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
      statement_timeout: 0,
      query_timeout: 0,
    };
  }
  return {
    host: conn.host,
    port: conn.port ? Number(conn.port) : 5432,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 0,
    query_timeout: 0,
  };
}

async function testConnection(conn) {
  const client = new Client(buildClientConfig(conn));
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT current_database() AS db, current_user AS usr, version() AS version;'
    );
    return { ok: true, ...rows[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

async function inspectSource(conn, includeSchemas) {
  const client = new Client(buildClientConfig(conn));
  await client.connect();
  try {
    const schemas = await inspector.getSchemas(client, includeSchemas);
    const tables = await inspector.getTables(client, schemas);

    // Approximate row counts for the UI.
    const tableSummaries = [];
    for (const t of tables) {
      const approx = await inspector.getApproxRowCount(client, t.schema, t.name);
      tableSummaries.push({
        schema: t.schema,
        name: t.name,
        approxRows: approx,
      });
    }
    return { schemas, tables: tableSummaries };
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeEmitter() {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);

  ee.log = (level, message, extra = {}) => {
    ee.emit('event', { type: 'log', level, message, ts: Date.now(), ...extra });
  };
  ee.phase = (phase, message) => {
    ee.emit('event', { type: 'phase', phase, message, ts: Date.now() });
  };
  ee.progress = (payload) => {
    ee.emit('event', { type: 'progress', ts: Date.now(), ...payload });
  };
  ee.done = (payload = {}) => {
    ee.emit('event', { type: 'done', ts: Date.now(), ...payload });
  };
  ee.fail = (error) => {
    ee.emit('event', {
      type: 'error',
      ts: Date.now(),
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
    });
  };
  return ee;
}

async function safeQuery(client, sql, emitter, { ignoreErrors = false, label } = {}) {
  try {
    await client.query(sql);
    if (label) emitter.log('info', `OK: ${label}`);
  } catch (err) {
    const msg = `Failed: ${label || sql.slice(0, 80)} — ${err.message}`;
    if (ignoreErrors) {
      emitter.log('warn', msg);
    } else {
      emitter.log('error', msg);
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* COPY one table (binary)                                             */
/* ------------------------------------------------------------------ */

async function copyOneTable(source, target, schema, table, emitter) {
  const ident = qualified(schema, table);
  const start = Date.now();
  let bytes = 0;
  let lastReport = 0;

  const fromStream = source.query(
    copyTo(`COPY ${ident} TO STDOUT WITH (FORMAT binary)`)
  );
  const toStream = target.query(
    copyFrom(`COPY ${ident} FROM STDIN WITH (FORMAT binary)`)
  );

  fromStream.on('data', (chunk) => {
    bytes += chunk.length;
    const now = Date.now();
    if (now - lastReport > 250) {
      lastReport = now;
      emitter.progress({
        scope: 'table',
        schema, table,
        bytes,
        elapsedMs: now - start,
      });
    }
  });

  await pipeline(fromStream, toStream);

  emitter.progress({
    scope: 'table',
    schema, table,
    bytes,
    elapsedMs: Date.now() - start,
    finished: true,
  });
  return { bytes, elapsedMs: Date.now() - start };
}

/* ------------------------------------------------------------------ */
/* Main migration                                                      */
/* ------------------------------------------------------------------ */

async function runMigration(opts, emitter) {
  const {
    source,
    target,
    includeSchemas = null,
    cleanTarget = false,
    skipExtensions = false,
    skipViews = false,
    skipIndexes = false,
    disableTriggers = true,
  } = opts;

  const src = new Client(buildClientConfig(source));
  const tgt = new Client(buildClientConfig(target));

  emitter.phase('connect', 'Подключение к базам данных…');
  await src.connect();
  await tgt.connect();
  emitter.log('info', 'Подключение установлено');

  try {
    /* ----- 1. Inspect source ----- */
    emitter.phase('inspect', 'Анализ структуры исходной БД…');
    const schemas    = await inspector.getSchemas(src, includeSchemas);
    if (schemas.length === 0) {
      throw new Error('В исходной БД не найдено пользовательских схем для миграции');
    }
    emitter.log('info', `Схемы: ${schemas.join(', ')}`);

    const extensions  = skipExtensions ? [] : await inspector.getExtensions(src);
    const enumTypes   = await inspector.getEnumTypes(src, schemas);
    const domains     = await inspector.getDomains(src, schemas);
    const sequences   = await inspector.getSequences(src, schemas);
    const tables      = await inspector.getTables(src, schemas);
    const constraints = await inspector.getConstraints(src, schemas);
    const indexes     = skipIndexes ? [] : await inspector.getIndexes(src, schemas);
    const views       = skipViews ? [] : await inspector.getViews(src, schemas);

    emitter.log('info',
      `Найдено: ${tables.length} таблиц, ${sequences.length} sequences, ` +
      `${enumTypes.length} enum, ${indexes.length} индексов, ` +
      `${constraints.foreign.length} FK, ${views.length} views`
    );

    /* ----- 2. Optionally clean target schemas ----- */
    if (cleanTarget) {
      emitter.phase('clean', 'Очистка целевых схем…');
      for (const s of schemas) {
        await safeQuery(tgt,
          `DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE;`,
          emitter, { ignoreErrors: false, label: `DROP SCHEMA ${s}` }
        );
      }
    }

    /* ----- 3. Create schemas ----- */
    emitter.phase('schemas', 'Создание схем…');
    for (const s of schemas) {
      await safeQuery(tgt,
        `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`,
        emitter, { label: `CREATE SCHEMA ${s}` }
      );
    }

    /* ----- 4. Extensions ----- */
    if (extensions.length > 0) {
      emitter.phase('extensions', 'Создание расширений…');
      for (const ext of extensions) {
        await safeQuery(tgt, ext.ddl, emitter,
          { ignoreErrors: true, label: `CREATE EXTENSION ${ext.name}` });
      }
    }

    /* ----- 5. Enum types & domains ----- */
    if (enumTypes.length > 0) {
      emitter.phase('types', 'Создание enum-типов…');
      for (const t of enumTypes) {
        await safeQuery(tgt, t.ddl, emitter,
          { ignoreErrors: true, label: `CREATE TYPE ${t.schema}.${t.name}` });
      }
    }
    if (domains.length > 0) {
      emitter.phase('domains', 'Создание доменов…');
      for (const d of domains) {
        await safeQuery(tgt, d.ddl, emitter,
          { ignoreErrors: true, label: `CREATE DOMAIN ${d.schema}.${d.name}` });
      }
    }

    /* ----- 6. Sequences (standalone, not owned by identity columns) ----- */
    const standaloneSequences = sequences.filter(s => !s.ownedBy);
    if (standaloneSequences.length > 0) {
      emitter.phase('sequences', 'Создание sequences…');
      for (const s of standaloneSequences) {
        await safeQuery(tgt, s.ddl, emitter,
          { ignoreErrors: true, label: `CREATE SEQUENCE ${s.schema}.${s.name}` });
      }
    }

    /* ----- 7. Tables (no constraints / indexes yet) ----- */
    emitter.phase('tables', 'Создание таблиц…');
    for (const t of tables) {
      await safeQuery(tgt, t.ddl, emitter,
        { ignoreErrors: false, label: `CREATE TABLE ${t.schema}.${t.name}` });
    }

    /* ----- 8. Copy data ----- */
    emitter.phase('data', 'Копирование данных…');
    if (disableTriggers) {
      try {
        await tgt.query("SET session_replication_role = 'replica';");
        emitter.log('info', 'Триггеры отключены на время загрузки (session_replication_role=replica)');
      } catch (err) {
        emitter.log('warn',
          `Не удалось отключить триггеры (нужны права superuser): ${err.message}`);
      }
    }

    let copiedTables = 0;
    let totalBytes = 0;
    const tableResults = [];
    for (const t of tables) {
      emitter.progress({
        scope: 'overall',
        currentTable: `${t.schema}.${t.name}`,
        copiedTables,
        totalTables: tables.length,
      });
      try {
        const r = await copyOneTable(src, tgt, t.schema, t.name, emitter);
        copiedTables += 1;
        totalBytes += r.bytes;
        tableResults.push({
          schema: t.schema, name: t.name,
          ok: true, bytes: r.bytes, elapsedMs: r.elapsedMs,
        });
        emitter.log('info',
          `Скопировано ${t.schema}.${t.name}: ${formatBytes(r.bytes)} за ${r.elapsedMs} ms`
        );
      } catch (err) {
        tableResults.push({
          schema: t.schema, name: t.name, ok: false, error: err.message,
        });
        emitter.log('error',
          `Ошибка копирования ${t.schema}.${t.name}: ${err.message}`);
        // Recover the connection: COPY errors leave it in an aborted txn-like state.
        try { await src.query('SELECT 1'); } catch { /* noop */ }
        try { await tgt.query('SELECT 1'); } catch { /* noop */ }
      }
    }

    if (disableTriggers) {
      try { await tgt.query("SET session_replication_role = 'origin';"); } catch { /* noop */ }
    }

    /* ----- 9. Sequence values ----- */
    if (sequences.length > 0) {
      emitter.phase('setval', 'Восстановление значений sequences…');
      for (const s of sequences) {
        if (s.lastValue == null) continue;
        const sql =
          `SELECT setval('${s.schema}.${s.name}'::regclass, ${s.lastValue}, ${s.isCalled ? 'true' : 'false'});`;
        await safeQuery(tgt, sql, emitter,
          { ignoreErrors: true, label: `setval ${s.schema}.${s.name}` });
      }
    }

    /* ----- 10. Constraints (PK first to enable FK lookups, then UNIQUE, CHECK, FK) ----- */
    const allConstraints = [
      ...constraints.primary.map(c => ({ ...c, kind: 'PK' })),
      ...constraints.unique .map(c => ({ ...c, kind: 'UNIQUE' })),
      ...constraints.check  .map(c => ({ ...c, kind: 'CHECK' })),
      ...constraints.foreign.map(c => ({ ...c, kind: 'FK' })),
    ];
    if (allConstraints.length > 0) {
      emitter.phase('constraints', 'Применение ограничений…');
      let appliedConstraints = 0;
      for (const c of allConstraints) {
        emitter.progress({
          scope: 'post',
          phase: 'constraints',
          current: appliedConstraints + 1,
          total: allConstraints.length,
          currentName: `${c.kind} ${c.schema}.${c.table}.${c.name}`,
        });
        await safeQuery(tgt, c.ddl, emitter,
          { ignoreErrors: true, label: `${c.kind} ${c.schema}.${c.table}.${c.name}` });
        appliedConstraints += 1;
      }
    }

    /* ----- 11. Indexes ----- */
    let createdIndexes = 0;
    let failedIndexes = 0;
    if (indexes.length > 0) {
      emitter.phase('indexes', `Создание индексов (0/${indexes.length})…`);
      for (let i = 0; i < indexes.length; i++) {
        const idx = indexes[i];
        const fullName = `${idx.schema}.${idx.table}.${idx.name}`;
        emitter.progress({
          scope: 'post',
          phase: 'indexes',
          current: i + 1,
          total: indexes.length,
          currentName: fullName,
        });
        try {
          await tgt.query(idx.ddl);
          createdIndexes += 1;
          emitter.log('info', `OK: INDEX ${fullName}`);
        } catch (err) {
          failedIndexes += 1;
          emitter.log('warn', `Не удалось создать индекс ${fullName}: ${err.message}`);
        }
      }
      emitter.phase('indexes', `Индексы готовы (${createdIndexes}/${indexes.length})`);
    }

    /* ----- 12. Views ----- */
    if (views.length > 0) {
      emitter.phase('views', 'Создание представлений…');
      for (const v of views) {
        await safeQuery(tgt, v.ddl, emitter,
          { ignoreErrors: true, label: `VIEW ${v.schema}.${v.name}` });
      }
    }

    emitter.done({
      summary: {
        schemas: schemas.length,
        tables: tables.length,
        copiedTables,
        totalBytes,
        sequences: sequences.length,
        constraints:
          constraints.primary.length + constraints.unique.length +
          constraints.check.length + constraints.foreign.length,
        indexes: indexes.length,
        createdIndexes,
        failedIndexes,
        views: views.length,
      },
      tables: tableResults,
    });
  } finally {
    try { await src.end(); } catch { /* noop */ }
    try { await tgt.end(); } catch { /* noop */ }
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + ' ' + units[i];
}

module.exports = {
  buildClientConfig,
  testConnection,
  inspectSource,
  runMigration,
  makeEmitter,
};
