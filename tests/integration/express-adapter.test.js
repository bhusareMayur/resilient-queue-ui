"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createExpressAdapter } = require("../../src/adapters/express");

describe("Express Adapter Integration", () => {
  let server;
  let serverUrl;

  const mockEmailQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({
      waiting: 15,
      active: 2,
      delayed: 0,
      dlq: 1
    })
  };

  const mockClosedQueue = {
    isClosed: true,
    isPaused: async () => false,
    getMetrics: async () => ({})
  };

  before(async () => {
    const adapter = createExpressAdapter({
      queues: {
        "email-queue": mockEmailQueue,
        "closed-queue": mockClosedQueue
      }
    });

    server = http.createServer((req, res) => {
      adapter(req, res, (err) => {
        if (err) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: err.message }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Handled by downstream next()" }));
      });
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        serverUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should return 200 OK with correct JSON payload for registered queue", async () => {
    const res = await fetch(`${serverUrl}/api/queues/email-queue/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);

    const data = await res.json();
    assert.deepEqual(data, {
      queue: "email-queue",
      isPaused: false,
      metrics: {
        waiting: 15,
        active: 2,
        delayed: 0,
        dlq: 1
      }
    });
  });

  it("should return 404 Not Found for unregistered queue", async () => {
    const res = await fetch(`${serverUrl}/api/queues/unknown-queue/metrics`);
    assert.equal(res.status, 404);

    const data = await res.json();
    assert.deepEqual(data, {
      error: {
        code: "QUEUE_NOT_FOUND",
        message: "Queue 'unknown-queue' is not registered with the dashboard adapter",
        details: null
      }
    });
  });

  it("should return 503 Service Unavailable when queue is closed", async () => {
    const res = await fetch(`${serverUrl}/api/queues/closed-queue/metrics`);
    assert.equal(res.status, 503);

    const data = await res.json();
    assert.deepEqual(data, {
      error: {
        code: "QUEUE_CLOSED",
        message: "Queue is closed",
        details: null
      }
    });
  });

  it("should fall through to next() for unmatched routes", async () => {
    const res = await fetch(`${serverUrl}/unmatched/path`);
    assert.equal(res.status, 404);

    const data = await res.json();
    assert.equal(data.message, "Handled by downstream next()");
  });
});

describe("Express Adapter with basePath option", () => {
  let server;
  let serverUrl;

  const mockQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({ waiting: 1, active: 0, delayed: 0, dlq: 0 })
  };

  before(async () => {
    const adapter = createExpressAdapter({
      basePath: "/admin/queues",
      queues: { notifications: mockQueue }
    });

    server = http.createServer((req, res) => {
      adapter(req, res, (err) => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        serverUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should respond when requested under basePath prefix", async () => {
    const res = await fetch(`${serverUrl}/admin/queues/api/queues/notifications/metrics`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "notifications");
    assert.equal(data.metrics.waiting, 1);
  });
});
