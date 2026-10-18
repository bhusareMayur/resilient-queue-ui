"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { handleGetDLQ } = require("../../src/handlers/dlq");

describe("handleGetDLQ", () => {
  it("should retrieve DLQ jobs and total count successfully", async () => {
    let capturedOptions = null;
    const mockJobs = [
      { id: "job-1", data: { foo: "bar" }, failedAt: 1000, failureReason: "Timeout" },
      { id: "job-2", data: { baz: "qux" }, failedAt: 2000, failureReason: "Network error" }
    ];

    const mockQueue = {
      isClosed: false,
      getDLQ: async (opts) => {
        capturedOptions = opts;
        return {
          total: 10,
          jobs: mockJobs
        };
      }
    };

    const result = await handleGetDLQ(mockQueue, { start: 0, limit: 20, order: "desc" });

    assert.deepEqual(result, {
      total: 10,
      jobs: mockJobs
    });
    assert.deepEqual(capturedOptions, { start: 0, limit: 20, order: "desc" });
  });

  it("should handle empty DLQ correctly", async () => {
    const mockQueue = {
      isClosed: false,
      getDLQ: async () => ({
        total: 0,
        jobs: []
      })
    };

    const result = await handleGetDLQ(mockQueue);

    assert.deepEqual(result, {
      total: 0,
      jobs: []
    });
  });

  it("should throw QUEUE_CLOSED error immediately when queue.isClosed is true", async () => {
    let called = false;
    const mockQueue = {
      isClosed: true,
      getDLQ: async () => {
        called = true;
        return { total: 0, jobs: [] };
      }
    };

    await assert.rejects(
      async () => await handleGetDLQ(mockQueue),
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
      getDLQ: async () => {
        throw new Error("Queue is closed");
      }
    };

    await assert.rejects(
      async () => await handleGetDLQ(mockQueue),
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
      getDLQ: async () => {
        throw new Error("Redis cluster down");
      }
    };

    await assert.rejects(
      async () => await handleGetDLQ(mockQueue),
      (err) => {
        assert.equal(err.message, "Redis cluster down");
        assert.notEqual(err.code, "QUEUE_CLOSED");
        return true;
      }
    );
  });

  it("should throw TypeError when queue instance is missing or invalid", async () => {
    await assert.rejects(
      async () => await handleGetDLQ(null),
      {
        name: "TypeError",
        message: /Valid ResilientQueue instance is required/
      }
    );
  });
});
