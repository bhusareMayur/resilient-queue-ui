"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ApiClient, ApiError } = require("../../src/ui/api-client");

describe("ApiClient", () => {
  describe("Constructor & URL Construction", () => {
    it("should initialize with default base URL", () => {
      const client = new ApiClient();
      assert.equal(client.baseUrl, "");
      assert.equal(client.buildUrl("/api/queues"), "/api/queues");
    });

    it("should support string as options parameter", () => {
      const client = new ApiClient("http://localhost:3000");
      assert.equal(client.baseUrl, "http://localhost:3000");
    });

    it("should strip trailing slashes from baseUrl", () => {
      const client = new ApiClient({ baseUrl: "http://localhost:3000/admin/queues///" });
      assert.equal(client.baseUrl, "http://localhost:3000/admin/queues");
      assert.equal(client.buildUrl("/api/queues"), "http://localhost:3000/admin/queues/api/queues");
    });

    it("should handle path without leading slash", () => {
      const client = new ApiClient({ baseUrl: "/prefix" });
      assert.equal(client.buildUrl("api/queues"), "/prefix/api/queues");
    });

    it("should format query parameters correctly", () => {
      const client = new ApiClient();
      const url = client.buildUrl("/api/queues/email-queue/dlq", {
        start: 10,
        limit: 25,
        order: "desc"
      });
      assert.equal(url, "/api/queues/email-queue/dlq?start=10&limit=25&order=desc");
    });

    it("should safely encode special characters, slashes, and spaces in queueName and jobId", async () => {
      let requestedUrl = null;
      const mockFetch = async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true })
        };
      };

      const client = new ApiClient({ fetch: mockFetch });

      await client.getQueueMetrics("emails/urgent high#1");
      assert.equal(requestedUrl, "/api/queues/emails%2Furgent%20high%231/metrics");

      await client.getQueueDLQ("orders?batch=1&flag=true", { start: 0 });
      assert.equal(requestedUrl, "/api/queues/orders%3Fbatch%3D1%26flag%3Dtrue/dlq?start=0");

      await client.getJob("emails", "job/123#special?data");
      assert.equal(requestedUrl, "/api/queues/emails/jobs/job%2F123%23special%3Fdata");
    });

    it("should accept numeric job IDs transparently", async () => {
      let requestedUrl = null;
      const mockFetch = async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true })
        };
      };

      const client = new ApiClient({ fetch: mockFetch });
      await client.getJob("emails", 12345);
      assert.equal(requestedUrl, "/api/queues/emails/jobs/12345");
    });

    it("should validate queueName and jobId as non-empty strings", async () => {
      const client = new ApiClient({ fetch: async () => ({}) });

      await assert.rejects(
        () => client.getQueueMetrics(""),
        { name: "ApiError", code: "VALIDATION_ERROR", status: 400 }
      );

      await assert.rejects(
        () => client.getQueueMetrics("   "),
        { name: "ApiError", code: "VALIDATION_ERROR", status: 400 }
      );

      await assert.rejects(
        () => client.getQueueMetrics(null),
        { name: "ApiError", code: "VALIDATION_ERROR", status: 400 }
      );

      await assert.rejects(
        () => client.getQueueDLQ(""),
        { name: "ApiError", code: "VALIDATION_ERROR", status: 400 }
      );

      await assert.rejects(
        () => client.getJob("emails", ""),
        { name: "ApiError", code: "VALIDATION_ERROR", status: 400 }
      );

      await assert.rejects(
        () => client.getJob("", "job-1"),
        { name: "ApiError", code: "VALIDATION_ERROR", status: 400 }
      );
    });
  });

  describe("Successful JSON Responses", () => {
    it("should return queues list on getQueues()", async () => {
      const expectedPayload = {
        queues: [
          {
            name: "email-queue",
            isPaused: false,
            metrics: { waiting: 10, active: 2, delayed: 0, dlq: 1 }
          }
        ]
      };

      const client = new ApiClient({
        fetch: async (url, options) => {
          assert.equal(url, "/api/queues");
          assert.equal(options.method, "GET");
          assert.equal(options.headers.Accept, "application/json");
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(expectedPayload)
          };
        }
      });

      const result = await client.getQueues();
      assert.deepEqual(result, expectedPayload);
    });

    it("should return single queue metrics on getQueueMetrics()", async () => {
      const expectedPayload = {
        queue: "email-queue",
        isPaused: true,
        metrics: { waiting: 0, active: 0, delayed: 5, dlq: 0 }
      };

      const client = new ApiClient({
        baseUrl: "http://example.com/admin",
        fetch: async (url) => {
          assert.equal(url, "http://example.com/admin/api/queues/email-queue/metrics");
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(expectedPayload)
          };
        }
      });

      const result = await client.getQueueMetrics("email-queue");
      assert.deepEqual(result, expectedPayload);
    });

    it("should return DLQ payload on getQueueDLQ()", async () => {
      const expectedPayload = {
        queue: "email-queue",
        total: 1,
        start: 0,
        limit: 50,
        order: "desc",
        jobs: [
          { id: "dead-1", failureReason: "Timeout" }
        ]
      };

      const client = new ApiClient({
        fetch: async (url) => {
          assert.equal(url, "/api/queues/email-queue/dlq?start=0&limit=50&order=desc");
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(expectedPayload)
          };
        }
      });

      const result = await client.getQueueDLQ("email-queue", { start: 0, limit: 50, order: "desc" });
      assert.deepEqual(result, expectedPayload);
    });

    it("should return job payload on getJob()", async () => {
      const expectedPayload = {
        queue: "email-queue",
        job: {
          id: "job-abc",
          state: "completed",
          data: { recipient: "user@example.com" }
        }
      };

      const client = new ApiClient({
        fetch: async (url) => {
          assert.equal(url, "/api/queues/email-queue/jobs/job-abc");
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(expectedPayload)
          };
        }
      });

      const result = await client.getJob("email-queue", "job-abc");
      assert.deepEqual(result, expectedPayload);
    });
  });

  describe("HTTP Errors, Network Failures, and Malformed Responses", () => {
    it("should parse standard JSON error envelope on 404 QUEUE_NOT_FOUND", async () => {
      const client = new ApiClient({
        fetch: async () => ({
          ok: false,
          status: 404,
          text: async () => JSON.stringify({
            error: {
              code: "QUEUE_NOT_FOUND",
              message: "Queue 'missing' is not registered with the dashboard adapter",
              details: null
            }
          })
        })
      });

      await assert.rejects(
        () => client.getQueueMetrics("missing"),
        (err) => {
          assert(err instanceof ApiError);
          assert.equal(err.name, "ApiError");
          assert.equal(err.status, 404);
          assert.equal(err.code, "QUEUE_NOT_FOUND");
          assert.equal(err.message, "Queue 'missing' is not registered with the dashboard adapter");
          assert.equal(err.details, null);
          return true;
        }
      );
    });

    it("should parse standard JSON error envelope on 503 QUEUE_CLOSED", async () => {
      const client = new ApiClient({
        fetch: async () => ({
          ok: false,
          status: 503,
          text: async () => JSON.stringify({
            error: {
              code: "QUEUE_CLOSED",
              message: "Queue is closed",
              details: null
            }
          })
        })
      });

      await assert.rejects(
        () => client.getQueues(),
        (err) => {
          assert(err instanceof ApiError);
          assert.equal(err.status, 503);
          assert.equal(err.code, "QUEUE_CLOSED");
          assert.equal(err.message, "Queue is closed");
          return true;
        }
      );
    });

    it("should handle non-JSON HTTP errors (e.g. 502 Bad Gateway HTML)", async () => {
      const client = new ApiClient({
        fetch: async () => ({
          ok: false,
          status: 502,
          text: async () => "<html><body>502 Bad Gateway</body></html>"
        })
      });

      await assert.rejects(
        () => client.getQueues(),
        (err) => {
          assert(err instanceof ApiError);
          assert.equal(err.status, 502);
          assert.equal(err.code, "HTTP_ERROR");
          assert.match(err.message, /HTTP error 502/);
          assert.equal(err.rawResponse, "<html><body>502 Bad Gateway</body></html>");
          return true;
        }
      );
    });

    it("should handle 200 OK with malformed / invalid JSON body", async () => {
      const client = new ApiClient({
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => "corrupted{not json}"
        })
      });

      await assert.rejects(
        () => client.getQueues(),
        (err) => {
          assert(err instanceof ApiError);
          assert.equal(err.status, 200);
          assert.equal(err.code, "PARSE_ERROR");
          assert.equal(err.message, "Invalid JSON response from server");
          return true;
        }
      );
    });

    it("should handle network failure when fetch throws", async () => {
      const client = new ApiClient({
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        }
      });

      await assert.rejects(
        () => client.getQueues(),
        (err) => {
          assert(err instanceof ApiError);
          assert.equal(err.status, 0);
          assert.equal(err.code, "NETWORK_ERROR");
          assert.equal(err.message, "Failed to fetch");
          assert(err.details instanceof TypeError);
          return true;
        }
      );
    });

    it("should throw ENVIRONMENT_ERROR if fetch is missing", async () => {
      const client = new ApiClient({ fetch: null });
      client.fetch = undefined;

      await assert.rejects(
        () => client.getQueues(),
        { name: "ApiError", code: "ENVIRONMENT_ERROR", status: 0 }
      );
    });
  });
});
