"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  createDashboardDispatcher,
  createErrorResponse
} = require("../../src/dispatcher");

describe("DashboardDispatcher", () => {
  const healthyQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({
      waiting: 50,
      active: 5,
      delayed: 12,
      dlq: 1
    })
  };

  const closedQueue = {
    isClosed: true,
    isPaused: async () => false,
    getMetrics: async () => ({})
  };

  const closedThrowsQueue = {
    isPaused: async () => false,
    getMetrics: async () => {
      throw new Error("Queue is closed");
    }
  };

  const failingQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => {
      throw new Error("Redis CLUSTERDOWN error");
    }
  };

  describe("executeMetricsRoute", () => {
    const dispatcher = createDashboardDispatcher({
      queues: {
        "email-notifications": healthyQueue,
        "closed-queue": closedQueue,
        "throws-closed": closedThrowsQueue,
        "failing-queue": failingQueue,
        "queue with spaces": healthyQueue
      }
    });

    it("should return 200 with metrics and paused status for registered queue", async () => {
      const response = await dispatcher.executeMetricsRoute("email-notifications");

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        queue: "email-notifications",
        isPaused: false,
        metrics: {
          waiting: 50,
          active: 5,
          delayed: 12,
          dlq: 1
        }
      });
    });

    it("should correctly handle and decode URL-encoded queue names", async () => {
      const response = await dispatcher.executeMetricsRoute("queue%20with%20spaces");

      assert.equal(response.status, 200);
      assert.equal(response.body.queue, "queue with spaces");
    });

    it("should return 404 QUEUE_NOT_FOUND when queue is not in registry", async () => {
      const response = await dispatcher.executeMetricsRoute("unknown-queue");

      assert.equal(response.status, 404);
      assert.deepEqual(response.body, {
        error: {
          code: "QUEUE_NOT_FOUND",
          message: "Queue 'unknown-queue' is not registered with the dashboard adapter",
          details: null
        }
      });
    });

    it("should return 400 VALIDATION_ERROR for empty or whitespace queue name", async () => {
      const res1 = await dispatcher.executeMetricsRoute("");
      assert.equal(res1.status, 400);
      assert.equal(res1.body.error.code, "VALIDATION_ERROR");

      const res2 = await dispatcher.executeMetricsRoute("   ");
      assert.equal(res2.status, 400);
      assert.equal(res2.body.error.code, "VALIDATION_ERROR");

      const res3 = await dispatcher.executeMetricsRoute(null);
      assert.equal(res3.status, 400);
      assert.equal(res3.body.error.code, "VALIDATION_ERROR");
    });

    it("should return 400 VALIDATION_ERROR for invalid URI component encoding", async () => {
      const response = await dispatcher.executeMetricsRoute("%E0%A4%A");

      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "VALIDATION_ERROR");
      assert.equal(response.body.error.message, "Invalid URL-encoded queueName parameter");
    });

    it("should return 503 QUEUE_CLOSED when queue is marked isClosed", async () => {
      const response = await dispatcher.executeMetricsRoute("closed-queue");

      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        error: {
          code: "QUEUE_CLOSED",
          message: "Queue is closed",
          details: null
        }
      });
    });

    it("should return 503 QUEUE_CLOSED when queue throws 'Queue is closed'", async () => {
      const response = await dispatcher.executeMetricsRoute("throws-closed");

      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        error: {
          code: "QUEUE_CLOSED",
          message: "Queue is closed",
          details: null
        }
      });
    });

    it("should return 500 INTERNAL_ERROR when core throws an unexpected error", async () => {
      const response = await dispatcher.executeMetricsRoute("failing-queue");

      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, "INTERNAL_ERROR");
      assert.equal(response.body.error.message, "Redis CLUSTERDOWN error");
    });
  });

  describe("dispatch method", () => {
    it("should handle matching routes and call sendJson", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { emails: healthyQueue }
      });

      let sentStatus = null;
      let sentBody = null;
      const res = {
        status: (s) => {
          sentStatus = s;
          return {
            json: (b) => {
              sentBody = b;
            }
          };
        }
      };

      await dispatcher.dispatch({ method: "GET", url: "/api/queues/emails/metrics" }, res);

      assert.equal(sentStatus, 200);
      assert.equal(sentBody.queue, "emails");
      assert.equal(sentBody.metrics.waiting, 50);
    });

    it("should support basePath prefix option", async () => {
      const dispatcher = createDashboardDispatcher({
        basePath: "/admin/queues",
        queues: { emails: healthyQueue }
      });

      let sentStatus = null;
      let sentBody = null;
      const res = {
        status: (s) => {
          sentStatus = s;
          return {
            json: (b) => {
              sentBody = b;
            }
          };
        }
      };

      await dispatcher.dispatch(
        { method: "GET", url: "/admin/queues/api/queues/emails/metrics" },
        res
      );

      assert.equal(sentStatus, 200);
      assert.equal(sentBody.queue, "emails");
    });

    it("should invoke next() when route does not match", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { emails: healthyQueue }
      });

      let nextCalled = false;
      const res = {};

      await dispatcher.dispatch(
        { method: "GET", url: "/other/unrelated/path" },
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(nextCalled, true);
    });

    it("should invoke next() when HTTP method is not GET", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { emails: healthyQueue }
      });

      let nextCalled = false;
      const res = {};

      await dispatcher.dispatch(
        { method: "POST", url: "/api/queues/emails/metrics" },
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(nextCalled, true);
    });

    it("should return 405 METHOD_NOT_ALLOWED when method is not GET and no next is provided", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { emails: healthyQueue }
      });

      let sentStatus = null;
      let sentBody = null;
      const res = {
        status: (s) => {
          sentStatus = s;
          return {
            json: (b) => {
              sentBody = b;
            }
          };
        }
      };

      await dispatcher.dispatch(
        { method: "POST", url: "/api/queues/emails/metrics" },
        res
      );

      assert.equal(sentStatus, 405);
      assert.equal(sentBody.error.code, "METHOD_NOT_ALLOWED");
    });

    it("should not match sibling paths sharing a partial basePath prefix", async () => {
      const dispatcher = createDashboardDispatcher({
        basePath: "/admin/queues",
        queues: { emails: healthyQueue }
      });

      let nextCalled = false;
      const res = {};

      await dispatcher.dispatch(
        { method: "GET", url: "/admin/queues-other/api/queues/emails/metrics" },
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(nextCalled, true);
    });

    it("should not match routes with multi-segment queue names containing slashes", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { emails: healthyQueue }
      });

      let nextCalled = false;
      const res = {};

      await dispatcher.dispatch(
        { method: "GET", url: "/api/queues/sub/path/metrics" },
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(nextCalled, true);
    });
  });
});
