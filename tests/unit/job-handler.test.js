"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { handleGetJob, serializeJob } = require("../../src/handlers/job");

describe("serializeJob", () => {
  it("should filter out function-valued properties such as updateProgress", () => {
    const rawJob = {
      id: "job-123",
      data: { user: "alice" },
      state: "active",
      progress: 50,
      updateProgress: async () => {},
      customHelper: () => "ignored"
    };

    const serialized = serializeJob(rawJob);

    assert.equal(serialized.id, "job-123");
    assert.deepEqual(serialized.data, { user: "alice" });
    assert.equal(serialized.state, "active");
    assert.equal(serialized.progress, 50);
    assert.equal("updateProgress" in serialized, false);
    assert.equal("customHelper" in serialized, false);
  });

  it("should filter out undefined values and preserve nulls, arrays, and primitives", () => {
    const rawJob = {
      id: "job-456",
      data: [1, 2, 3],
      result: null,
      error: undefined
    };

    const serialized = serializeJob(rawJob);

    assert.equal(serialized.id, "job-456");
    assert.deepEqual(serialized.data, [1, 2, 3]);
    assert.equal(serialized.result, null);
    assert.equal("error" in serialized, false);
  });

  it("should return null for null or non-object inputs", () => {
    assert.equal(serializeJob(null), null);
    assert.equal(serializeJob(undefined), null);
    assert.equal(serializeJob("string"), null);
    assert.equal(serializeJob(123), null);
  });
});

describe("handleGetJob", () => {
  const dummyJob = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    data: { to: "user@example.com", template: "welcome" },
    state: "completed",
    progress: 100,
    attempt: 0,
    stalledCount: 0,
    createdAt: 1776500000000,
    startedAt: 1776500001000,
    completedAt: 1776500002500,
    result: { messageId: "<abc@example.com>" },
    updateProgress: async () => {}
  };

  it("should retrieve and safely serialize an existing job", async () => {
    let capturedId = null;
    const mockQueue = {
      isClosed: false,
      getJob: async (id) => {
        capturedId = id;
        return dummyJob;
      }
    };

    const result = await handleGetJob(mockQueue, "550e8400-e29b-41d4-a716-446655440000");

    assert.equal(capturedId, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(result.id, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(result.state, "completed");
    assert.equal("updateProgress" in result, false);
  });

  it("should return null when job is not found or expired", async () => {
    const mockQueue = {
      isClosed: false,
      getJob: async () => null
    };

    const result = await handleGetJob(mockQueue, "non-existent-id");
    assert.equal(result, null);
  });

  it("should throw QUEUE_CLOSED immediately when queue.isClosed is true", async () => {
    let called = false;
    const mockQueue = {
      isClosed: true,
      getJob: async () => {
        called = true;
        return null;
      }
    };

    await assert.rejects(
      async () => await handleGetJob(mockQueue, "any-id"),
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
      getJob: async () => {
        throw new Error("Queue is closed");
      }
    };

    await assert.rejects(
      async () => await handleGetJob(mockQueue, "any-id"),
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
      getJob: async () => {
        throw new Error("Redis connection refused");
      }
    };

    await assert.rejects(
      async () => await handleGetJob(mockQueue, "any-id"),
      (err) => {
        assert.equal(err.message, "Redis connection refused");
        assert.notEqual(err.code, "QUEUE_CLOSED");
        return true;
      }
    );
  });

  it("should throw TypeError when queue instance is missing or invalid", async () => {
    await assert.rejects(
      async () => await handleGetJob(null, "some-id"),
      {
        name: "TypeError",
        message: /Valid ResilientQueue instance is required/
      }
    );
  });

  it("should throw TypeError when jobId is missing, empty, or non-string", async () => {
    const mockQueue = { isClosed: false, getJob: async () => null };

    await assert.rejects(async () => await handleGetJob(mockQueue, ""), {
      name: "TypeError",
      message: /jobId must be a non-empty string/
    });

    await assert.rejects(async () => await handleGetJob(mockQueue, "   "), {
      name: "TypeError",
      message: /jobId must be a non-empty string/
    });

    await assert.rejects(async () => await handleGetJob(mockQueue, null), {
      name: "TypeError",
      message: /jobId must be a non-empty string/
    });

    await assert.rejects(async () => await handleGetJob(mockQueue, 12345), {
      name: "TypeError",
      message: /jobId must be a non-empty string/
    });
  });
});
