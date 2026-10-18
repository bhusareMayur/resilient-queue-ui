"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { ResilientQueue } = require("@mayurbhusare/resilient-queue");
const { createExpressAdapter } = require("../../src/adapters/express");

function checkRedisAvailable(port = 6379, host = "127.0.0.1", timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe("Live ResilientQueue Integration", () => {
  let server;
  let serverUrl;
  let queue;
  let redisAvailable = false;
  const prefix = `rq:ui:test:${Date.now()}`;

  before(async (t) => {
    redisAvailable = await checkRedisAvailable();
    if (!redisAvailable) {
      t.skip("Redis server is not reachable on 127.0.0.1:6379; skipping live integration tests");
      return;
    }

    queue = new ResilientQueue({
      redisUrl: "redis://127.0.0.1:6379",
      keyPrefix: prefix
    });

    const adapter = createExpressAdapter({
      queues: {
        "live-test": queue
      }
    });

    server = http.createServer(adapter);

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
    if (queue && !queue.isClosed) {
      try {
        await queue.close();
      } catch {
        // ignore
      }
    }
  });

  it("should retrieve initial live metrics (0 waiting, 0 active, 0 delayed, 0 dlq)", async (t) => {
    if (!redisAvailable) return t.skip();

    const res = await fetch(`${serverUrl}/api/queues/live-test/metrics`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "live-test");
    assert.equal(data.isPaused, false);
    assert.deepEqual(data.metrics, {
      waiting: 0,
      active: 0,
      delayed: 0,
      dlq: 0
    });
  });

  it("should reflect enqueued jobs in live metrics", async (t) => {
    if (!redisAvailable) return t.skip();

    await queue.enqueue({ task: "send-welcome-email" });

    const res = await fetch(`${serverUrl}/api/queues/live-test/metrics`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.metrics.waiting, 1);
  });

  it("should reflect pause state in live metrics", async (t) => {
    if (!redisAvailable) return t.skip();

    await queue.pause();

    const res = await fetch(`${serverUrl}/api/queues/live-test/metrics`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.isPaused, true);

    await queue.resume();

    const res2 = await fetch(`${serverUrl}/api/queues/live-test/metrics`);
    const data2 = await res2.json();
    assert.equal(data2.isPaused, false);
  });

  it("should return 503 QUEUE_CLOSED after queue is closed", async (t) => {
    if (!redisAvailable) return t.skip();

    await queue.close();

    const res = await fetch(`${serverUrl}/api/queues/live-test/metrics`);
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
});
