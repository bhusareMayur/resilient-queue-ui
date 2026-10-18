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

  it("should retrieve empty DLQ initially", async (t) => {
    if (!redisAvailable) return t.skip();

    const res = await fetch(`${serverUrl}/api/queues/live-test/dlq?start=0&limit=10&order=desc`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "live-test");
    assert.equal(data.total, 0);
    assert.equal(data.start, 0);
    assert.equal(data.limit, 10);
    assert.equal(data.order, "desc");
    assert.deepEqual(data.jobs, []);
  });

  it("should retrieve DLQ jobs and handle corrupted JSON entries from live Redis", async (t) => {
    if (!redisAvailable) return t.skip();

    const failedJobPayload = {
      id: "live-dead-job-1",
      data: { recipient: "dead@letter.com" },
      attempt: 4,
      createdAt: Date.now() - 5000,
      failedAt: Date.now(),
      failureReason: "Recipient mailbox unavailable"
    };

    // Push one valid failed job and one corrupted string to DLQ list
    await queue.producer.rpush(queue.dlqKey, JSON.stringify(failedJobPayload));
    await queue.producer.rpush(queue.dlqKey, "corrupted_payload_without_json{");

    const res = await fetch(`${serverUrl}/api/queues/live-test/dlq?start=0&limit=10&order=asc`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.total, 2);
    assert.equal(data.jobs.length, 2);

    // First job is the valid failed job
    assert.equal(data.jobs[0].id, "live-dead-job-1");
    assert.equal(data.jobs[0].failureReason, "Recipient mailbox unavailable");

    // Second job is the corrupted entry
    assert.equal(data.jobs[1].id, null);
    assert.equal(data.jobs[1].corrupted, true);
    assert.equal(data.jobs[1].raw, "corrupted_payload_without_json{");
  });

  it("should inspect an enqueued job from live Redis and omit functions", async (t) => {
    if (!redisAvailable) return t.skip();

    const jobId = await queue.enqueue(
      { task: "send-invoice", amount: 150 },
      { idempotencyKey: "invoice-999" }
    );

    const res = await fetch(`${serverUrl}/api/queues/live-test/jobs/${jobId}`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "live-test");
    assert.equal(data.job.id, jobId);
    assert.equal(data.job.state, "waiting");
    assert.deepEqual(data.job.data, { task: "send-invoice", amount: 150 });
    assert.equal(data.job.idempotencyKey, "invoice-999");
    assert.equal("updateProgress" in data.job, false);
  });

  it("should return 404 JOB_NOT_FOUND when inspecting non-existent job in live Redis", async (t) => {
    if (!redisAvailable) return t.skip();

    const res = await fetch(`${serverUrl}/api/queues/live-test/jobs/missing-live-job-404`);
    assert.equal(res.status, 404);

    const data = await res.json();
    assert.equal(data.error.code, "JOB_NOT_FOUND");
    assert.equal(
      data.error.message,
      "Job 'missing-live-job-404' not found or expired under retention policy"
    );
  });

  it("should return 503 QUEUE_CLOSED after queue is closed for metrics, DLQ, and job inspection", async (t) => {
    if (!redisAvailable) return t.skip();

    await queue.close();

    const resMetrics = await fetch(`${serverUrl}/api/queues/live-test/metrics`);
    assert.equal(resMetrics.status, 503);
    const dataMetrics = await resMetrics.json();
    assert.equal(dataMetrics.error.code, "QUEUE_CLOSED");

    const resDLQ = await fetch(`${serverUrl}/api/queues/live-test/dlq`);
    assert.equal(resDLQ.status, 503);
    const dataDLQ = await resDLQ.json();
    assert.equal(dataDLQ.error.code, "QUEUE_CLOSED");

    const resJob = await fetch(`${serverUrl}/api/queues/live-test/jobs/any-id`);
    assert.equal(resJob.status, 503);
    const dataJob = await resJob.json();
    assert.equal(dataJob.error.code, "QUEUE_CLOSED");
  });
});
