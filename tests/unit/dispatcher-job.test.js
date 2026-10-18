"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createDashboardDispatcher } = require("../../src/dispatcher");

describe("DashboardDispatcher Job Route", () => {
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

  const healthyQueue = {
    isClosed: false,
    getJob: async (id) => {
      if (id === "job-123" || id === "550e8400-e29b-41d4-a716-446655440000" || id === "custom-task-batch-92") {
        return { ...dummyJob, id };
      }
      return null;
    }
  };

  const closedQueue = {
    isClosed: true,
    getJob: async () => null
  };

  const throwsClosedQueue = {
    isClosed: false,
    getJob: async () => {
      throw new Error("Queue is closed");
    }
  };

  const failingQueue = {
    isClosed: false,
    getJob: async () => {
      throw new Error("Redis connection closed");
    }
  };

  const dispatcher = createDashboardDispatcher({
    queues: {
      emails: healthyQueue,
      closed: closedQueue,
      "throws-closed": throwsClosedQueue,
      failing: failingQueue,
      "queue with spaces": healthyQueue
    }
  });

  it("should return 200 with job payload adhering to contract schema and omitting updateProgress", async () => {
    const response = await dispatcher.executeJobRoute("emails", "550e8400-e29b-41d4-a716-446655440000");

    assert.equal(response.status, 200);
    assert.equal(response.body.queue, "emails");
    assert.equal(response.body.job.id, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(response.body.job.state, "completed");
    assert.equal(response.body.job.progress, 100);
    assert.deepEqual(response.body.job.data, { to: "user@example.com", template: "welcome" });
    assert.equal("updateProgress" in response.body.job, false);
  });

  it("should accept non-UUID string identifiers transparently", async () => {
    const response = await dispatcher.executeJobRoute("emails", "custom-task-batch-92");

    assert.equal(response.status, 200);
    assert.equal(response.body.queue, "emails");
    assert.equal(response.body.job.id, "custom-task-batch-92");
  });

  it("should correctly handle and decode URL-encoded queue names and job IDs", async () => {
    const response = await dispatcher.executeJobRoute("queue%20with%20spaces", "job%2D123");

    assert.equal(response.status, 200);
    assert.equal(response.body.queue, "queue with spaces");
    assert.equal(response.body.job.id, "job-123");
  });

  it("should return 404 JOB_NOT_FOUND when job is not found or expired", async () => {
    const response = await dispatcher.executeJobRoute("emails", "non-existent-job");

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: {
        code: "JOB_NOT_FOUND",
        message: "Job 'non-existent-job' not found or expired under retention policy",
        details: null
      }
    });
  });

  it("should return 404 QUEUE_NOT_FOUND when queue is not registered", async () => {
    const response = await dispatcher.executeJobRoute("unknown-queue", "job-123");

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: {
        code: "QUEUE_NOT_FOUND",
        message: "Queue 'unknown-queue' is not registered with the dashboard adapter",
        details: null
      }
    });
  });

  it("should return 400 VALIDATION_ERROR on empty or whitespace queue name", async () => {
    const res1 = await dispatcher.executeJobRoute("", "job-123");
    assert.equal(res1.status, 400);
    assert.equal(res1.body.error.code, "VALIDATION_ERROR");
    assert.equal(res1.body.error.message, "queueName must be a non-empty string");

    const res2 = await dispatcher.executeJobRoute("   ", "job-123");
    assert.equal(res2.status, 400);
    assert.equal(res2.body.error.code, "VALIDATION_ERROR");

    const res3 = await dispatcher.executeJobRoute(null, "job-123");
    assert.equal(res3.status, 400);
    assert.equal(res3.body.error.code, "VALIDATION_ERROR");
  });

  it("should return 400 VALIDATION_ERROR on empty or whitespace job ID", async () => {
    const res1 = await dispatcher.executeJobRoute("emails", "");
    assert.equal(res1.status, 400);
    assert.equal(res1.body.error.code, "VALIDATION_ERROR");
    assert.equal(res1.body.error.message, "jobId must be a non-empty string");

    const res2 = await dispatcher.executeJobRoute("emails", "   ");
    assert.equal(res2.status, 400);
    assert.equal(res2.body.error.code, "VALIDATION_ERROR");

    const res3 = await dispatcher.executeJobRoute("emails", null);
    assert.equal(res3.status, 400);
    assert.equal(res3.body.error.code, "VALIDATION_ERROR");
  });

  it("should return 400 VALIDATION_ERROR on malformed URL encoding in parameters", async () => {
    const resQueue = await dispatcher.executeJobRoute("%E0%A4%A", "job-123");
    assert.equal(resQueue.status, 400);
    assert.equal(resQueue.body.error.code, "VALIDATION_ERROR");
    assert.equal(resQueue.body.error.message, "Invalid URL-encoded queueName parameter");

    const resJob = await dispatcher.executeJobRoute("emails", "%E0%A4%A");
    assert.equal(resJob.status, 400);
    assert.equal(resJob.body.error.code, "VALIDATION_ERROR");
    assert.equal(resJob.body.error.message, "Invalid URL-encoded jobId parameter");
  });

  it("should return 503 QUEUE_CLOSED when queue is marked isClosed", async () => {
    const response = await dispatcher.executeJobRoute("closed", "job-123");

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
    const response = await dispatcher.executeJobRoute("throws-closed", "job-123");

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
    const response = await dispatcher.executeJobRoute("failing", "job-123");

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "INTERNAL_ERROR");
    assert.equal(response.body.error.message, "Redis connection closed");
  });

  it("should dispatch Job route from req with URL matching", async () => {
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
        url: "/api/queues/emails/jobs/job-123"
      },
      res
    );

    assert.equal(sentStatus, 200);
    assert.equal(sentBody.queue, "emails");
    assert.equal(sentBody.job.id, "job-123");
  });

  it("should return 405 METHOD_NOT_ALLOWED when method is not GET on job route without next", async () => {
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
        method: "DELETE",
        url: "/api/queues/emails/jobs/job-123"
      },
      res
    );

    assert.equal(sentStatus, 405);
    assert.equal(sentBody.error.code, "METHOD_NOT_ALLOWED");
  });

  it("should call next() when method is not GET on job route and next is provided", async () => {
    let nextCalled = false;
    const res = {};

    await dispatcher.dispatch(
      {
        method: "POST",
        url: "/api/queues/emails/jobs/job-123"
      },
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.equal(nextCalled, true);
  });
});
