"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createExpressAdapter } = require("../../src/adapters/express");

describe("Express Adapter Integration", () => {
  let server;
  let serverUrl;

  const mockDLQJobs = [
    {
      id: "failed-job-1",
      data: { to: "user@example.com" },
      attempt: 3,
      stalledCount: 0,
      createdAt: 1776500000000,
      failedAt: 1776500030000,
      failureReason: "SMTP 550: User unknown"
    },
    {
      id: null,
      raw: "{\"corrupted_json",
      corrupted: true,
      error: "Unexpected end of JSON input"
    }
  ];

  const mockEmailQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({
      waiting: 15,
      active: 2,
      delayed: 0,
      dlq: 2
    }),
    getDLQ: async (opts) => ({
      total: 2,
      jobs: mockDLQJobs
    }),
    getJob: async (jobId) => {
      if (jobId === "active-job-1") {
        return {
          id: "active-job-1",
          data: { recipient: "user@example.com" },
          state: "active",
          progress: 45,
          attempt: 1,
          stalledCount: 0,
          createdAt: 1776500000000,
          startedAt: 1776500001000,
          updateProgress: async () => {}
        };
      }
      return null;
    }
  };

  const mockClosedQueue = {
    isClosed: true,
    isPaused: async () => false,
    getMetrics: async () => ({}),
    getDLQ: async () => ({ total: 0, jobs: [] }),
    getJob: async () => null
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

  describe("GET /api/queues/:queueName/metrics", () => {
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
          dlq: 2
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

  describe("GET /api/queues/:queueName/dlq", () => {
    it("should return 200 OK with paginated DLQ jobs including corrupted entries", async () => {
      const res = await fetch(`${serverUrl}/api/queues/email-queue/dlq?start=0&limit=20&order=desc`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /application\/json/);

      const data = await res.json();
      assert.deepEqual(data, {
        queue: "email-queue",
        total: 2,
        start: 0,
        limit: 20,
        order: "desc",
        jobs: mockDLQJobs
      });
    });

    it("should return 400 Bad Request on invalid order parameter", async () => {
      const res = await fetch(`${serverUrl}/api/queues/email-queue/dlq?order=alphabetical`);
      assert.equal(res.status, 400);

      const data = await res.json();
      assert.equal(data.error.code, "VALIDATION_ERROR");
      assert.equal(data.error.message, 'order must be "asc" or "desc"');
      assert.deepEqual(data.error.details, { parameter: "order", value: "alphabetical" });
    });

    it("should return 400 Bad Request on negative start parameter", async () => {
      const res = await fetch(`${serverUrl}/api/queues/email-queue/dlq?start=-1`);
      assert.equal(res.status, 400);

      const data = await res.json();
      assert.equal(data.error.code, "VALIDATION_ERROR");
      assert.equal(data.error.message, "start must be a non-negative integer");
      assert.deepEqual(data.error.details, { parameter: "start", value: "-1" });
    });

    it("should return 400 Bad Request on non-integer limit parameter", async () => {
      const res = await fetch(`${serverUrl}/api/queues/email-queue/dlq?limit=abc`);
      assert.equal(res.status, 400);

      const data = await res.json();
      assert.equal(data.error.code, "VALIDATION_ERROR");
      assert.equal(data.error.message, "limit must be a non-negative integer");
    });

    it("should return 404 Not Found when querying DLQ for unregistered queue", async () => {
      const res = await fetch(`${serverUrl}/api/queues/billing-queue/dlq`);
      assert.equal(res.status, 404);

      const data = await res.json();
      assert.equal(data.error.code, "QUEUE_NOT_FOUND");
      assert.equal(data.error.message, "Queue 'billing-queue' is not registered with the dashboard adapter");
    });

    it("should return 503 Service Unavailable when querying DLQ for closed queue", async () => {
      const res = await fetch(`${serverUrl}/api/queues/closed-queue/dlq`);
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

  describe("GET /api/queues/:queueName/jobs/:jobId", () => {
    it("should return 200 OK with job payload and omit updateProgress", async () => {
      const res = await fetch(`${serverUrl}/api/queues/email-queue/jobs/active-job-1`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /application\/json/);

      const data = await res.json();
      assert.equal(data.queue, "email-queue");
      assert.equal(data.job.id, "active-job-1");
      assert.equal(data.job.state, "active");
      assert.equal(data.job.progress, 45);
      assert.deepEqual(data.job.data, { recipient: "user@example.com" });
      assert.equal("updateProgress" in data.job, false);
    });

    it("should return 404 Not Found for non-existent job ID", async () => {
      const res = await fetch(`${serverUrl}/api/queues/email-queue/jobs/missing-job-999`);
      assert.equal(res.status, 404);

      const data = await res.json();
      assert.deepEqual(data, {
        error: {
          code: "JOB_NOT_FOUND",
          message: "Job 'missing-job-999' not found or expired under retention policy",
          details: null
        }
      });
    });

    it("should return 404 Not Found for unregistered queue", async () => {
      const res = await fetch(`${serverUrl}/api/queues/unknown-queue/jobs/active-job-1`);
      assert.equal(res.status, 404);

      const data = await res.json();
      assert.equal(data.error.code, "QUEUE_NOT_FOUND");
      assert.equal(data.error.message, "Queue 'unknown-queue' is not registered with the dashboard adapter");
    });

    it("should return 503 Service Unavailable when queue is closed", async () => {
      const res = await fetch(`${serverUrl}/api/queues/closed-queue/jobs/active-job-1`);
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
});

describe("Express Adapter with basePath option", () => {
  let server;
  let serverUrl;

  const mockQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({ waiting: 1, active: 0, delayed: 0, dlq: 0 }),
    getDLQ: async () => ({ total: 0, jobs: [] }),
    getJob: async (jobId) => {
      if (jobId === "base-job-1") {
        return { id: "base-job-1", state: "completed", data: { done: true } };
      }
      return null;
    }
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

  it("should respond when requested under basePath prefix for metrics", async () => {
    const res = await fetch(`${serverUrl}/admin/queues/api/queues/notifications/metrics`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "notifications");
    assert.equal(data.metrics.waiting, 1);
  });

  it("should respond when requested under basePath prefix for DLQ", async () => {
    const res = await fetch(`${serverUrl}/admin/queues/api/queues/notifications/dlq`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "notifications");
    assert.equal(data.total, 0);
    assert.deepEqual(data.jobs, []);
  });

  it("should respond when requested under basePath prefix for Job inspection", async () => {
    const res = await fetch(`${serverUrl}/admin/queues/api/queues/notifications/jobs/base-job-1`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queue, "notifications");
    assert.equal(data.job.id, "base-job-1");
    assert.equal(data.job.state, "completed");
  });

  it("should respond when requested under basePath prefix for queues listing", async () => {
    const res = await fetch(`${serverUrl}/admin/queues/api/queues`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.deepEqual(data, {
      queues: [
        {
          name: "notifications",
          isPaused: false,
          metrics: {
            waiting: 1,
            active: 0,
            delayed: 0,
            dlq: 0
          }
        }
      ]
    });
  });
});

describe("Express Adapter with multiple queues (GET /api/queues)", () => {
  let server;
  let serverUrl;

  const queue1 = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({ waiting: 10, active: 2, delayed: 0, dlq: 1 })
  };

  const queue2 = {
    isClosed: false,
    isPaused: async () => true,
    getMetrics: async () => ({ waiting: 0, active: 0, delayed: 5, dlq: 0 })
  };

  before(async () => {
    const adapter = createExpressAdapter({
      queues: {
        "queue-alpha": queue1,
        "queue-beta": queue2
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
  });

  it("should return 200 OK with list of all registered queues", async () => {
    const res = await fetch(`${serverUrl}/api/queues`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.queues.length, 2);
    assert.deepEqual(data.queues, [
      {
        name: "queue-alpha",
        isPaused: false,
        metrics: { waiting: 10, active: 2, delayed: 0, dlq: 1 }
      },
      {
        name: "queue-beta",
        isPaused: true,
        metrics: { waiting: 0, active: 0, delayed: 5, dlq: 0 }
      }
    ]);
  });

  it("should serve index.html on root GET /", async () => {
    const res = await fetch(`${serverUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const text = await res.text();
    assert.match(text, /ResilientQueue Dashboard/);
  });

  it("should serve styles.css on GET /styles.css", async () => {
    const res = await fetch(`${serverUrl}/styles.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
    const text = await res.text();
    assert.match(text, /--sidebar-width/);
  });
});
