"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createDashboardDispatcher } = require("../../src/dispatcher");

describe("DashboardDispatcher Queues Route", () => {
  const healthyQueue1 = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => ({
      waiting: 142,
      active: 8,
      delayed: 23,
      dlq: 3
    })
  };

  const healthyQueue2 = {
    isClosed: false,
    isPaused: async () => true,
    getMetrics: async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      dlq: 12
    })
  };

  const closedQueue = {
    isClosed: true,
    isPaused: async () => false,
    getMetrics: async () => ({})
  };

  const throwsClosedQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => {
      throw new Error("Queue is closed");
    }
  };

  const failingQueue = {
    isClosed: false,
    isPaused: async () => false,
    getMetrics: async () => {
      throw new Error("Redis connection closed");
    }
  };

  describe("executeQueuesRoute", () => {
    it("should return 200 with empty queues array when no queues registered", async () => {
      const dispatcher = createDashboardDispatcher({ queues: {} });
      const response = await dispatcher.executeQueuesRoute();

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { queues: [] });
    });

    it("should return 200 with all registered queues matching the contract schema", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: {
          "email-notifications": healthyQueue1,
          "video-transcoding": healthyQueue2
        }
      });

      const response = await dispatcher.executeQueuesRoute();

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        queues: [
          {
            name: "email-notifications",
            isPaused: false,
            metrics: {
              waiting: 142,
              active: 8,
              delayed: 23,
              dlq: 3
            }
          },
          {
            name: "video-transcoding",
            isPaused: true,
            metrics: {
              waiting: 0,
              active: 0,
              delayed: 0,
              dlq: 12
            }
          }
        ]
      });
    });

    it("should return 503 QUEUE_CLOSED when any registered queue is closed", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: {
          healthy: healthyQueue1,
          closed: closedQueue
        }
      });

      const response = await dispatcher.executeQueuesRoute();

      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        error: {
          code: "QUEUE_CLOSED",
          message: "Queue is closed",
          details: null
        }
      });
    });

    it("should return 503 QUEUE_CLOSED when a queue throws 'Queue is closed'", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: {
          throws: throwsClosedQueue
        }
      });

      const response = await dispatcher.executeQueuesRoute();

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
      const dispatcher = createDashboardDispatcher({
        queues: {
          failing: failingQueue
        }
      });

      const response = await dispatcher.executeQueuesRoute();

      assert.equal(response.status, 500);
      assert.deepEqual(response.body, {
        error: {
          code: "INTERNAL_ERROR",
          message: "Redis connection closed",
          details: null
        }
      });
    });
  });

  describe("dispatch method for /api/queues", () => {
    it("should dispatch GET /api/queues and return 200 JSON response", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { "email-notifications": healthyQueue1 }
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

      await dispatcher.dispatch({ method: "GET", url: "/api/queues" }, res);

      assert.equal(sentStatus, 200);
      assert.equal(sentBody.queues.length, 1);
      assert.equal(sentBody.queues[0].name, "email-notifications");
    });

    it("should dispatch GET /api/queues/ with trailing slash", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { "email-notifications": healthyQueue1 }
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

      await dispatcher.dispatch({ method: "GET", url: "/api/queues/" }, res);

      assert.equal(sentStatus, 200);
      assert.equal(sentBody.queues.length, 1);
    });

    it("should support basePath option for /api/queues", async () => {
      const dispatcher = createDashboardDispatcher({
        basePath: "/admin/queues",
        queues: { "email-notifications": healthyQueue1 }
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
        { method: "GET", url: "/admin/queues/api/queues" },
        res
      );

      assert.equal(sentStatus, 200);
      assert.equal(sentBody.queues.length, 1);
    });

    it("should return 405 METHOD_NOT_ALLOWED on non-GET methods without next", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { "email-notifications": healthyQueue1 }
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

      await dispatcher.dispatch({ method: "POST", url: "/api/queues" }, res);

      assert.equal(sentStatus, 405);
      assert.equal(sentBody.error.code, "METHOD_NOT_ALLOWED");
    });

    it("should invoke next() on non-GET methods when next is provided", async () => {
      const dispatcher = createDashboardDispatcher({
        queues: { "email-notifications": healthyQueue1 }
      });

      let nextCalled = false;
      const res = {};

      await dispatcher.dispatch(
        { method: "POST", url: "/api/queues" },
        res,
        () => {
          nextCalled = true;
        }
      );

      assert.equal(nextCalled, true);
    });
  });
});
