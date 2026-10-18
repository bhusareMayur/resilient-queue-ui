"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  createDashboardDispatcher,
  parseDLQQueryParams
} = require("../../src/dispatcher");

describe("parseDLQQueryParams", () => {
  it("should apply default query values when parameters are omitted", () => {
    const result = parseDLQQueryParams({});
    assert.deepEqual(result, {
      start: 0,
      limit: 50,
      order: "asc"
    });
  });

  it("should parse valid string parameters", () => {
    const result = parseDLQQueryParams({
      start: "10",
      limit: "25",
      order: "desc"
    });
    assert.deepEqual(result, {
      start: 10,
      limit: 25,
      order: "desc"
    });
  });

  it("should accept valid numeric parameters", () => {
    const result = parseDLQQueryParams({
      start: 5,
      limit: 10,
      order: "asc"
    });
    assert.deepEqual(result, {
      start: 5,
      limit: 10,
      order: "asc"
    });
  });

  it("should normalize case-insensitive order", () => {
    const res1 = parseDLQQueryParams({ order: "DESC" });
    assert.equal(res1.order, "desc");

    const res2 = parseDLQQueryParams({ order: "Asc" });
    assert.equal(res2.order, "asc");
  });

  it("should reject negative or non-integer start parameter", () => {
    const res1 = parseDLQQueryParams({ start: "-1" });
    assert.equal(res1.error.error.code, "VALIDATION_ERROR");
    assert.equal(res1.error.error.message, "start must be a non-negative integer");
    assert.deepEqual(res1.error.error.details, { parameter: "start", value: "-1" });

    const res2 = parseDLQQueryParams({ start: "1.5" });
    assert.equal(res2.error.error.code, "VALIDATION_ERROR");

    const res3 = parseDLQQueryParams({ start: "abc" });
    assert.equal(res3.error.error.code, "VALIDATION_ERROR");

    const res4 = parseDLQQueryParams({ start: -5 });
    assert.equal(res4.error.error.code, "VALIDATION_ERROR");
  });

  it("should reject negative or non-integer limit parameter", () => {
    const res1 = parseDLQQueryParams({ limit: "-10" });
    assert.equal(res1.error.error.code, "VALIDATION_ERROR");
    assert.equal(res1.error.error.message, "limit must be a non-negative integer");
    assert.deepEqual(res1.error.error.details, { parameter: "limit", value: "-10" });

    const res2 = parseDLQQueryParams({ limit: "5.5" });
    assert.equal(res2.error.error.code, "VALIDATION_ERROR");

    const res3 = parseDLQQueryParams({ limit: "unlimited" });
    assert.equal(res3.error.error.code, "VALIDATION_ERROR");
  });

  it("should reject invalid order parameter", () => {
    const res1 = parseDLQQueryParams({ order: "alphabetical" });
    assert.equal(res1.error.error.code, "VALIDATION_ERROR");
    assert.equal(res1.error.error.message, 'order must be "asc" or "desc"');
    assert.deepEqual(res1.error.error.details, { parameter: "order", value: "alphabetical" });

    const res2 = parseDLQQueryParams({ order: 123 });
    assert.equal(res2.error.error.code, "VALIDATION_ERROR");
  });
});

describe("DashboardDispatcher DLQ Route", () => {
  const healthyQueue = {
    isClosed: false,
    getDLQ: async (opts) => ({
      total: 2,
      jobs: [
        { id: "job-1", failureReason: "Network error" },
        { id: "job-2", failureReason: "Bad input" }
      ]
    })
  };

  const closedQueue = {
    isClosed: true,
    getDLQ: async () => ({ total: 0, jobs: [] })
  };

  const failingQueue = {
    isClosed: false,
    getDLQ: async () => {
      throw new Error("Redis connection closed");
    }
  };

  const dispatcher = createDashboardDispatcher({
    queues: {
      emails: healthyQueue,
      closed: closedQueue,
      failing: failingQueue
    }
  });

  it("should return 200 with DLQ payload adhering to contract schema", async () => {
    const response = await dispatcher.executeDLQRoute("emails", {
      start: "0",
      limit: "20",
      order: "desc"
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      queue: "emails",
      total: 2,
      start: 0,
      limit: 20,
      order: "desc",
      jobs: [
        { id: "job-1", failureReason: "Network error" },
        { id: "job-2", failureReason: "Bad input" }
      ]
    });
  });

  it("should return 404 QUEUE_NOT_FOUND when queue is not registered", async () => {
    const response = await dispatcher.executeDLQRoute("unknown");

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: {
        code: "QUEUE_NOT_FOUND",
        message: "Queue 'unknown' is not registered with the dashboard adapter",
        details: null
      }
    });
  });

  it("should return 400 VALIDATION_ERROR on invalid query parameters", async () => {
    const response = await dispatcher.executeDLQRoute("emails", {
      order: "invalid"
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
    assert.equal(response.body.error.message, 'order must be "asc" or "desc"');
  });

  it("should return 503 QUEUE_CLOSED when queue is closed", async () => {
    const response = await dispatcher.executeDLQRoute("closed");

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: {
        code: "QUEUE_CLOSED",
        message: "Queue is closed",
        details: null
      }
    });
  });

  it("should return 500 INTERNAL_ERROR when core fails", async () => {
    const response = await dispatcher.executeDLQRoute("failing");

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "INTERNAL_ERROR");
    assert.equal(response.body.error.message, "Redis connection closed");
  });

  it("should dispatch DLQ route from req and parse query string", async () => {
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
      {
        method: "GET",
        url: "/api/queues/emails/dlq?start=0&limit=20&order=desc"
      },
      res
    );

    assert.equal(sentStatus, 200);
    assert.equal(sentBody.queue, "emails");
    assert.equal(sentBody.start, 0);
    assert.equal(sentBody.limit, 20);
    assert.equal(sentBody.order, "desc");
  });
});
