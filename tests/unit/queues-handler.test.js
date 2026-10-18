"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { handleGetQueues } = require("../../src/handlers/queues");
const { createQueueRegistry } = require("../../src/registry");

describe("handleGetQueues", () => {
  it("should return empty queues array when registry is empty", async () => {
    const registry = createQueueRegistry({ queues: {} });
    const result = await handleGetQueues(registry);

    assert.deepEqual(result, { queues: [] });
  });

  it("should return summary for a single registered queue", async () => {
    const mockQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({
        waiting: 10,
        active: 2,
        delayed: 1,
        dlq: 0
      })
    };

    const registry = createQueueRegistry({
      queues: {
        "email-notifications": mockQueue
      }
    });

    const result = await handleGetQueues(registry);

    assert.equal(result.queues.length, 1);
    assert.deepEqual(result.queues[0], {
      name: "email-notifications",
      isPaused: false,
      metrics: {
        waiting: 10,
        active: 2,
        delayed: 1,
        dlq: 0
      }
    });
  });

  it("should return summaries for multiple registered queues with varying pause states", async () => {
    const queue1 = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({
        waiting: 142,
        active: 8,
        delayed: 23,
        dlq: 3
      })
    };

    const queue2 = {
      isClosed: false,
      isPaused: async () => true,
      getMetrics: async () => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        dlq: 12
      })
    };

    const registry = createQueueRegistry({
      queues: {
        "email-notifications": queue1,
        "video-transcoding": queue2
      }
    });

    const result = await handleGetQueues(registry);

    assert.equal(result.queues.length, 2);
    assert.deepEqual(result.queues, [
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
    ]);
  });

  it("should respect localOnlyPaused option and forward to queue.isPaused", async () => {
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

    const registry = createQueueRegistry({
      queues: { test: mockQueue }
    });

    await handleGetQueues(registry, { localOnlyPaused: true });

    assert.deepEqual(capturedOptions, { localOnly: true });
  });

  it("should support plain objects, Maps, and arrays as queue inputs", async () => {
    const mockQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 1, active: 0, delayed: 0, dlq: 0 })
    };

    const map = new Map([["from-map", mockQueue]]);
    const resMap = await handleGetQueues(map);
    assert.equal(resMap.queues.length, 1);
    assert.equal(resMap.queues[0].name, "from-map");

    const arr = [{ name: "from-arr", queue: mockQueue }];
    const resArr = await handleGetQueues(arr);
    assert.equal(resArr.queues.length, 1);
    assert.equal(resArr.queues[0].name, "from-arr");

    const record = { "from-record": mockQueue };
    const resRecord = await handleGetQueues(record);
    assert.equal(resRecord.queues.length, 1);
    assert.equal(resRecord.queues[0].name, "from-record");
  });

  it("should throw QUEUE_CLOSED error immediately when any queue in registry is closed", async () => {
    const healthyQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 5, active: 0, delayed: 0, dlq: 0 })
    };

    const closedQueue = {
      isClosed: true,
      isPaused: async () => false,
      getMetrics: async () => ({})
    };

    const registry = createQueueRegistry({
      queues: {
        healthy: healthyQueue,
        closed: closedQueue
      }
    });

    await assert.rejects(
      async () => await handleGetQueues(registry),
      (err) => {
        assert.equal(err.code, "QUEUE_CLOSED");
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, "Queue is closed");
        return true;
      }
    );
  });

  it("should catch core 'Queue is closed' exception thrown during metrics check and convert to QUEUE_CLOSED", async () => {
    const throwsClosedQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => {
        throw new Error("Queue is closed");
      }
    };

    const registry = createQueueRegistry({
      queues: {
        failing: throwsClosedQueue
      }
    });

    await assert.rejects(
      async () => await handleGetQueues(registry),
      (err) => {
        assert.equal(err.code, "QUEUE_CLOSED");
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, "Queue is closed");
        return true;
      }
    );
  });

  it("should rethrow unexpected Redis or core errors", async () => {
    const failingQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => {
        throw new Error("Redis connection refused");
      }
    };

    const registry = createQueueRegistry({
      queues: { failing: failingQueue }
    });

    await assert.rejects(
      async () => await handleGetQueues(registry),
      (err) => {
        assert.equal(err.message, "Redis connection refused");
        assert.notEqual(err.code, "QUEUE_CLOSED");
        return true;
      }
    );
  });

  it("should throw TypeError when registry is invalid or missing", async () => {
    await assert.rejects(
      async () => await handleGetQueues(null),
      {
        name: "TypeError",
        message: /Valid QueueRegistry instance or queue map is required/
      }
    );

    await assert.rejects(
      async () => await handleGetQueues("invalid"),
      {
        name: "TypeError",
        message: /Valid QueueRegistry instance or queue map is required/
      }
    );
  });
});
