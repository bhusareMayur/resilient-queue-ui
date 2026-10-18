"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fastifyDashboardPlugin } = require("../../src/adapters/fastify");

class MockFastify {
  constructor() {
    this.routes = new Map();
  }

  get(path, options, handler) {
    if (typeof options === "function") {
      handler = options;
      options = {};
    }
    this.routes.set(path, { options, handler });
  }

  async inject(path, params, query = {}) {
    const route = this.routes.get(path);
    if (!route) {
      return { statusCode: 404, body: null };
    }

    let statusCode = 200;
    let responseBody = null;

    const reply = {
      code(c) {
        statusCode = c;
        return reply;
      },
      send(b) {
        responseBody = b;
        return reply;
      }
    };

    const request = { params, query };

    if (typeof route.options?.preHandler === "function") {
      await route.options.preHandler(request, reply);
    }

    await route.handler(request, reply);
    return { statusCode, body: responseBody };
  }
}

describe("Fastify Dashboard Plugin Integration", () => {
  const mockQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({
      waiting: 42,
      active: 3,
      delayed: 7,
      dlq: 1
    }),
    getDLQ: async (opts) => ({
      total: 1,
      jobs: [{ id: "failed-order-1", failureReason: "Payment declined" }]
    }),
    getJob: async (jobId) => {
      if (jobId === "order-abc-123") {
        return {
          id: "order-abc-123",
          data: { total: 99.99 },
          state: "completed",
          progress: 100,
          updateProgress: async () => {}
        };
      }
      return null;
    }
  };

  const closedQueue = {
    isClosed: true,
    isPaused: async () => false,
    getMetrics: async () => ({}),
    getDLQ: async () => ({ total: 0, jobs: [] }),
    getJob: async () => null
  };

  it("should register route and execute handler returning 200 OK for metrics", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/metrics", {
      queueName: "orders"
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      queue: "orders",
      isPaused: false,
      metrics: {
        waiting: 42,
        active: 3,
        delayed: 7,
        dlq: 1
      }
    });
  });

  it("should register route and execute handler returning 200 OK for DLQ", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject(
      "/api/queues/:queueName/dlq",
      { queueName: "orders" },
      { start: "0", limit: "10", order: "desc" }
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      queue: "orders",
      total: 1,
      start: 0,
      limit: 10,
      order: "desc",
      jobs: [{ id: "failed-order-1", failureReason: "Payment declined" }]
    });
  });

  it("should return 400 on invalid query parameters in Fastify DLQ route", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject(
      "/api/queues/:queueName/dlq",
      { queueName: "orders" },
      { order: "unknown" }
    );

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });

  it("should return 404 for unknown queue", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/metrics", {
      queueName: "unknown"
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, "QUEUE_NOT_FOUND");
  });

  it("should return 503 for closed queue", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { closed: closedQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/metrics", {
      queueName: "closed"
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, "QUEUE_CLOSED");
  });

  it("should execute preHandler hook if provided in options", async () => {
    const fastify = new MockFastify();
    let authHookCalled = false;

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue },
          preHandler: async (req, reply) => {
            authHookCalled = true;
          }
        },
        resolve
      );
    });

    await fastify.inject("/api/queues/:queueName/metrics", { queueName: "orders" });
    assert.equal(authHookCalled, true);
  });

  it("should register route and execute handler returning 200 OK for Job inspection", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/jobs/:jobId", {
      queueName: "orders",
      jobId: "order-abc-123"
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      queue: "orders",
      job: {
        id: "order-abc-123",
        data: { total: 99.99 },
        state: "completed",
        progress: 100
      }
    });
    assert.equal("updateProgress" in res.body.job, false);
  });

  it("should return 404 for missing job in Fastify route", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/jobs/:jobId", {
      queueName: "orders",
      jobId: "non-existent"
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, "JOB_NOT_FOUND");
  });

  it("should return 404 for unknown queue in Fastify Job route", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { orders: mockQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/jobs/:jobId", {
      queueName: "unknown",
      jobId: "order-abc-123"
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, "QUEUE_NOT_FOUND");
  });

  it("should return 503 for closed queue in Fastify Job route", async () => {
    const fastify = new MockFastify();

    await new Promise((resolve) => {
      fastifyDashboardPlugin(
        fastify,
        {
          queues: { closed: closedQueue }
        },
        resolve
      );
    });

    const res = await fastify.inject("/api/queues/:queueName/jobs/:jobId", {
      queueName: "closed",
      jobId: "order-abc-123"
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, "QUEUE_CLOSED");
  });
});
