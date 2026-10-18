"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { handleGetMetrics } = require("../../src/handlers/metrics");

describe("handleGetMetrics", () => {
  it("should retrieve metrics and pause state successfully", async () => {
    let capturedOptions = null;
    const mockQueue = {
      isClosed: false,
      isPaused: async (opts) => {
        capturedOptions = opts;
        return false;
      },
      getMetrics: async () => ({
        waiting: 142,
        active: 8,
        delayed: 23,
        dlq: 3
      })
    };

    const result = await handleGetMetrics(mockQueue);

    assert.deepEqual(result, {
      isPaused: false,
      metrics: {
        waiting: 142,
        active: 8,
        delayed: 23,
        dlq: 3
      }
    });
    assert.deepEqual(capturedOptions, { localOnly: false });
  });

  it("should respect localOnlyPaused option", async () => {
    let capturedOptions = null;
    const mockQueue = {
      isClosed: false,
      isPaused: async (opts) => {
        capturedOptions = opts;
        return true;
      },
      getMetrics: async () => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        dlq: 0
      })
    };

    const result = await handleGetMetrics(mockQueue, { localOnlyPaused: true });

    assert.equal(result.isPaused, true);
    assert.deepEqual(capturedOptions, { localOnly: true });
  });

  it("should throw QUEUE_CLOSED error immediately when queue.isClosed is true", async () => {
    let called = false;
    const mockQueue = {
      isClosed: true,
      isPaused: async () => {
        called = true;
        return false;
      },
      getMetrics: async () => {
        called = true;
        return {};
      }
    };

    await assert.rejects(
      async () => await handleGetMetrics(mockQueue),
      (err) => {
        assert.equal(err.code, "QUEUE_CLOSED");
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, "Queue is closed");
        return true;
      }
    );

    assert.equal(called, false);
  });

  it("should catch core 'Queue is closed' exception and convert to QUEUE_CLOSED error", async () => {
    const mockQueue = {
      // isClosed might not be set or exposed
      isPaused: async () => false,
      getMetrics: async () => {
        throw new Error("Queue is closed");
      }
    };

    await assert.rejects(
      async () => await handleGetMetrics(mockQueue),
      (err) => {
        assert.equal(err.code, "QUEUE_CLOSED");
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, "Queue is closed");
        return true;
      }
    );
  });

  it("should rethrow unexpected Redis or core errors", async () => {
    const mockQueue = {
      isPaused: async () => false,
      getMetrics: async () => {
        throw new Error("Redis connection timeout");
      }
    };

    await assert.rejects(
      async () => await handleGetMetrics(mockQueue),
      (err) => {
        assert.equal(err.message, "Redis connection timeout");
        assert.notEqual(err.code, "QUEUE_CLOSED");
        return true;
      }
    );
  });

  it("should throw TypeError when queue instance is missing or invalid", async () => {
    await assert.rejects(
      async () => await handleGetMetrics(null),
      {
        name: "TypeError",
        message: /Valid ResilientQueue instance is required/
      }
    );
  });
});
