'use strict';

/**
 * server.js
 * ---------
 * Express HTTP server exposing:
 *   GET  /                             — UI
 *   POST /api/test-connection          — verify a single connection
 *   POST /api/inspect                  — list schemas + tables of source
 *   POST /api/migrate                  — start a migration, returns { jobId }
 *   GET  /api/migrate/:jobId/events    — SSE stream of progress/log events
 */

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const {
  testConnection,
  inspectSource,
  runMigration,
  makeEmitter,
} = require('./migrator');

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* In-memory job registry                                              */
/* ------------------------------------------------------------------ */
const jobs = new Map(); // jobId -> { emitter, events: [], finished: bool }

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

function registerJob() {
  const jobId = newJobId();
  const emitter = makeEmitter();
  const job = { emitter, events: [], finished: false };
  emitter.on('event', (evt) => {
    job.events.push(evt);
    if (evt.type === 'done' || evt.type === 'error') {
      job.finished = true;
    }
    // Keep memory bounded (last 5000 events).
    if (job.events.length > 5000) job.events.splice(0, job.events.length - 5000);
  });
  jobs.set(jobId, job);

  // Auto-cleanup old finished jobs after 30 minutes.
  setTimeout(() => {
    if (job.finished) jobs.delete(jobId);
  }, 30 * 60 * 1000).unref();

  return { jobId, emitter };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.post('/api/test-connection', async (req, res) => {
  const { connection } = req.body || {};
  if (!connection) return res.status(400).json({ ok: false, error: 'connection required' });
  const result = await testConnection(connection);
  res.json(result);
});

app.post('/api/inspect', async (req, res) => {
  try {
    const { connection, includeSchemas } = req.body || {};
    if (!connection) return res.status(400).json({ ok: false, error: 'connection required' });
    const data = await inspectSource(connection, includeSchemas || null);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/migrate', (req, res) => {
  const body = req.body || {};
  if (!body.source || !body.target) {
    return res.status(400).json({ ok: false, error: 'source and target are required' });
  }
  const { jobId, emitter } = registerJob();

  // Run asynchronously; do not await so the request returns immediately.
  setImmediate(async () => {
    try {
      await runMigration(body, emitter);
    } catch (err) {
      emitter.fail(err);
    }
  });

  res.json({ ok: true, jobId });
});

app.get('/api/migrate/:jobId/events', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ ok: false, error: 'job not found' });
    return;
  }

  // SSE headers
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // 1. Replay buffered events.
  for (const evt of job.events) send(evt);

  // 2. If finished, close after replay.
  if (job.finished) {
    res.end();
    return;
  }

  // 3. Subscribe to new events.
  const onEvent = (evt) => {
    send(evt);
    if (evt.type === 'done' || evt.type === 'error') {
      job.emitter.off('event', onEvent);
      res.end();
    }
  };
  job.emitter.on('event', onEvent);

  // 4. Heartbeat to keep proxies/clients from idle-closing.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.emitter.off('event', onEvent);
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`migrati listening on http://localhost:${PORT}`);
});
