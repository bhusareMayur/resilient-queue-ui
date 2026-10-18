"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const OverviewView = require("../../src/ui/views/overview");
const DLQView = require("../../src/ui/views/dlq");
const JobView = require("../../src/ui/views/job");
const { DashboardApp } = require("../../src/ui/app");
const {
  createDashboardDispatcher,
  resolveUiAssetPath,
  UI_DIR
} = require("../../src/dispatcher");

describe("UI Components & Views", () => {
  describe("Queue Overview View Component", () => {
    it("should render loading state with accessible ARIA attributes", () => {
      const html = OverviewView.renderLoading();
      assert.match(html, /role="status"/);
      assert.match(html, /aria-live="polite"/);
      assert.match(html, /class="spinner"/);
      assert.match(html, /Loading Queues/);
    });

    it("should render empty state when no queues are registered", () => {
      const html = OverviewView.renderEmpty();
      assert.match(html, /role="status"/);
      assert.match(html, /No Queues Registered/);
      assert.match(html, /createExpressAdapter/);
    });

    it("should render error state with retry action button and error details", () => {
      const error = {
        code: "QUEUE_CLOSED",
        message: "Queue is closed"
      };
      const html = OverviewView.renderError(error);
      assert.match(html, /role="alert"/);
      assert.match(html, /aria-live="assertive"/);
      assert.match(html, /QUEUE_CLOSED/);
      assert.match(html, /Queue is closed/);
      assert.match(html, /id="retry-overview-btn"/);
      assert.match(html, /aria-label="Retry loading queue metrics"/);
    });

    it("should render data table and aggregate telemetry cards with live metrics", () => {
      const queues = [
        {
          name: "email-queue",
          isPaused: false,
          metrics: { waiting: 10, active: 2, delayed: 3, dlq: 0 }
        },
        {
          name: "video-queue",
          isPaused: true,
          metrics: { waiting: 0, active: 1, delayed: 0, dlq: 5 }
        }
      ];

      const html = OverviewView.renderData(queues);

      // Aggregates: Queues: 2, Waiting: 10, Active: 3, Delayed: 3, DLQ: 5
      assert.match(html, /class="metric-value">2<\/div>/); // Queues count
      assert.match(html, /class="metric-value">10<\/div>/); // Waiting sum
      assert.match(html, /class="metric-value">3<\/div>/); // Active sum
      assert.match(html, /class="metric-value has-dlq">5<\/div>/); // DLQ sum highlighted

      // Queue rows
      assert.match(html, /email-queue/);
      assert.match(html, /video-queue/);

      // Status badges
      assert.match(html, /badge-active/);
      assert.match(html, /badge-paused/);

      // DLQ badges
      assert.match(html, /badge-dlq-clean/);
      assert.match(html, /badge-dlq-alert/);
      assert.match(html, /data-queue="video-queue"/);
    });

    it("should fall back to empty state when data is empty array", () => {
      const html = OverviewView.renderData([]);
      assert.match(html, /No Queues Registered/);
    });
  });

  describe("Dead Letter Queue (DLQ) View Component", () => {
    it("should render no queues registered state when queue list is empty", () => {
      const html = DLQView.render({}, []);
      assert.match(html, /role="status"/);
      assert.match(html, /No Queues Registered/);
      assert.match(html, /createExpressAdapter/);
    });

    it("should render prompt to select a queue when no queue is selected", () => {
      const queues = [
        { name: "emails", metrics: { dlq: 2 } },
        { name: "orders", metrics: { dlq: 0 } }
      ];
      const html = DLQView.render({ selectedQueue: null }, queues);
      assert.match(html, /Select a Queue/);
      assert.match(html, /Choose a registered queue from the dropdown/);
      assert.match(html, /emails \(DLQ: 2\)/);
      assert.match(html, /orders \(DLQ: 0\)/);
    });

    it("should render loading state when fetching DLQ jobs for selected queue", () => {
      const html = DLQView.render(
        { selectedQueue: "email-queue", loading: true },
        [{ name: "email-queue", metrics: { dlq: 3 } }]
      );
      assert.match(html, /role="status"/);
      assert.match(html, /class="spinner"/);
      assert.match(html, /Loading Dead-Letter Jobs/);
      assert.match(html, /email-queue/);
    });

    it("should render empty state when a selected queue has 0 dead-letter jobs", () => {
      const html = DLQView.render(
        { selectedQueue: "email-queue", jobs: [], total: 0 },
        [{ name: "email-queue", metrics: { dlq: 0 } }]
      );
      assert.match(html, /No Dead-Letter Jobs/);
      assert.match(html, /0 dead-letter jobs/);
      assert.match(html, /email-queue/);
    });

    it("should render error state with retry button and error details", () => {
      const error = {
        code: "REDIS_TIMEOUT",
        message: "Failed to connect to Redis within 5000ms"
      };
      const html = DLQView.render(
        { selectedQueue: "orders", error },
        [{ name: "orders", metrics: { dlq: 1 } }]
      );
      assert.match(html, /role="alert"/);
      assert.match(html, /REDIS_TIMEOUT/);
      assert.match(html, /Failed to Load DLQ/);
      assert.match(html, /Failed to connect to Redis within 5000ms/);
      assert.match(html, /id="dlq-retry-btn"/);
      assert.match(html, /aria-label="Retry loading DLQ"/);
    });

    it("should render queue not found error state when queue does not exist", () => {
      const error = {
        code: "QUEUE_NOT_FOUND",
        status: 404
      };
      const html = DLQView.render(
        { selectedQueue: "unknown-queue", error },
        [{ name: "emails", metrics: { dlq: 0 } }]
      );
      assert.match(html, /Queue Not Found/);
      assert.match(html, /unknown-queue.*is not registered/);
    });

    it("should render table with normal failed jobs and inspection controls", () => {
      const state = {
        selectedQueue: "orders",
        total: 1,
        start: 0,
        limit: 50,
        order: "desc",
        jobs: [
          {
            id: "job-12345",
            attempt: 3,
            stalledCount: 1,
            createdAt: 1700000000000,
            failedAt: 1700000050000,
            failureReason: "Payment gateway timeout after 30s",
            data: { orderId: "ord-99", amount: 1500 }
          }
        ]
      };
      const html = DLQView.render(state, [{ name: "orders" }]);
      assert.match(html, /job-12345/);
      assert.match(html, /Payment gateway timeout after 30s/);
      assert.match(html, /3 \(1 stalls\)/);
      assert.match(html, /class="btn btn-secondary btn-sm dlq-inspect-btn"/);
      assert.match(html, /Inspect/);
    });

    it("should safely render corrupted DLQ records with id: null without crashing", () => {
      const state = {
        selectedQueue: "orders",
        total: 2,
        start: 0,
        limit: 50,
        jobs: [
          {
            id: null,
            corrupted: true,
            raw: '{"broken: json...',
            error: "Unexpected end of JSON input"
          }
        ]
      };
      const html = DLQView.render(state, [{ name: "orders" }]);
      assert.match(html, /CORRUPTED/);
      assert.match(html, /Unexpected end of JSON input/);
      assert.match(html, /View Raw/);
      assert.doesNotMatch(html, /null<\/span>/);
    });

    it("should render expanded job details with formatted payload and cross-link to Job Inspector", () => {
      const job = {
        id: "job-abc",
        attempt: 2,
        stalledCount: 0,
        createdAt: 1700000000000,
        failedAt: 1700000010000,
        failureReason: "Database constraint error",
        data: { email: "user@example.com" }
      };
      const htmlWithQueue = DLQView.renderJobDetail(job, false, "orders");
      assert.match(htmlWithQueue, /job-abc/);
      assert.match(htmlWithQueue, /Database constraint error/);
      assert.match(htmlWithQueue, /user@example\.com/);
      assert.match(htmlWithQueue, /Inspect in Job Inspector/);
      assert.match(htmlWithQueue, /data-queue="orders"/);
      assert.match(htmlWithQueue, /data-job-id="job-abc"/);

      const htmlWithoutQueue = DLQView.renderJobDetail(job, false);
      assert.match(htmlWithoutQueue, /All diagnostics above are retrieved directly from the Dead Letter Queue record/);
    });

    it("should render expanded corrupted job details preserving raw content safely", () => {
      const corruptedJob = {
        id: null,
        corrupted: true,
        raw: "<malformed-non-json-data>",
        error: "SyntaxError: Unexpected token <"
      };
      const html = DLQView.renderJobDetail(corruptedJob, true);
      assert.match(html, /Corrupted Payload Record/);
      assert.match(html, /&lt;malformed-non-json-data&gt;/);
      assert.match(html, /SyntaxError: Unexpected token &lt;/);
    });

    it("should render pagination navigation with correct page counts and button states", () => {
      // First page of 3
      const state1 = {
        jobs: new Array(10).fill({ id: "job", failureReason: "err" }),
        total: 25,
        start: 0,
        limit: 10
      };
      const html1 = DLQView.renderTable(state1);
      assert.match(html1, /Showing <strong>1–10<\/strong> of <strong>25<\/strong> jobs/);
      assert.match(html1, /Page 1 of 3/);
      assert.match(html1, /id="dlq-prev-btn"\s+disabled/); // Prev disabled on page 1
      assert.doesNotMatch(html1, /id="dlq-next-btn"\s+disabled/); // Next enabled

      // Last page
      const state2 = {
        jobs: new Array(5).fill({ id: "job", failureReason: "err" }),
        total: 25,
        start: 20,
        limit: 10
      };
      const html2 = DLQView.renderTable(state2);
      assert.match(html2, /Showing <strong>21–25<\/strong> of <strong>25<\/strong> jobs/);
      assert.match(html2, /Page 3 of 3/);
      assert.doesNotMatch(html2, /id="dlq-prev-btn"\s+disabled/); // Prev enabled
      assert.match(html2, /id="dlq-next-btn"\s+disabled/); // Next disabled on last page
    });

    it("should safely handle corrupted records when entry is null or not an object", () => {
      const state = {
        selectedQueue: "orders",
        total: 2,
        start: 0,
        limit: 50,
        jobs: [null, undefined]
      };
      const html = DLQView.renderTable(state);
      assert.match(html, /CORRUPTED/);
      assert.match(html, /Corrupted JSON/);
    });

    it("should safely format undefined payload in renderJobDetail", () => {
      const job = { id: "job-fn", data: undefined };
      const html = DLQView.renderJobDetail(job, false);
      assert.match(html, /job-fn/);
      assert.match(html, /null/);
    });

    it("should handle out-of-bounds start parameter safely without negative counts", () => {
      const state = {
        jobs: [],
        total: 10,
        start: 50,
        limit: 10
      };
      const html = DLQView.renderTable(state);
      assert.match(html, /Showing <strong>10–10<\/strong> of <strong>10<\/strong> jobs/);
      assert.match(html, /Page 6 of 1/);
    });

    it("should include unregistered queue in dropdown when navigated directly", () => {
      const html = DLQView.render({ selectedQueue: "deleted-queue" }, [{ name: "active-queue" }]);
      assert.match(html, /deleted-queue \(Not in registry\)/);
      assert.match(html, /active-queue/);
    });
  });

  describe("Job Inspection View Component (Milestone 7)", () => {
    it("should render prompt select state when no job is requested", () => {
      const html = JobView.render({}, [{ name: "emails" }]);
      assert.match(html, /Inspect a Job/);
      assert.match(html, /Select a registered queue and enter a unique Job ID/);
      assert.match(html, /id="job-search-form"/);
      assert.match(html, /id="job-queue-select"/);
      assert.match(html, /id="job-id-input"/);
    });

    it("should render empty state when no queues are registered", () => {
      const html = JobView.render({}, []);
      assert.match(html, /No Queues Registered/);
      assert.match(html, /createExpressAdapter/);
    });

    it("should render loading state with accessible ARIA attributes", () => {
      const html = JobView.render(
        { loading: true, selectedQueue: "emails", jobId: "job-101" },
        [{ name: "emails" }]
      );
      assert.match(html, /role="status"/);
      assert.match(html, /aria-live="polite"/);
      assert.match(html, /class="spinner"/);
      assert.match(html, /Inspecting Job\.\.\./);
      assert.match(html, /job-101/);
      assert.match(html, /emails/);
    });

    it("should render 404 JOB_NOT_FOUND state when job is not found", () => {
      const error = { code: "JOB_NOT_FOUND", status: 404 };
      const html = JobView.render(
        { error, selectedQueue: "orders", jobId: "nonexistent-job" },
        [{ name: "orders" }]
      );
      assert.match(html, /Job Not Found/);
      assert.match(html, /nonexistent-job/);
      assert.match(html, /orders/);
      assert.match(html, /JOB_NOT_FOUND/);
    });

    it("should render 404 QUEUE_NOT_FOUND state when queue is not registered", () => {
      const error = { code: "QUEUE_NOT_FOUND", status: 404, message: "Queue unknown-queue is not registered" };
      const html = JobView.render(
        { error, selectedQueue: "unknown-queue", jobId: "job-1" },
        [{ name: "orders" }]
      );
      assert.match(html, /Queue Not Registered/);
      assert.match(html, /unknown-queue/);
    });

    it("should render 400 VALIDATION_ERROR state on missing parameters", () => {
      const error = { code: "VALIDATION_ERROR", status: 400, message: "jobId must be a non-empty string." };
      const html = JobView.render(
        { error, selectedQueue: "orders", jobId: "" },
        [{ name: "orders" }]
      );
      assert.match(html, /Invalid Search Parameter/);
      assert.match(html, /jobId must be a non-empty string\./);
    });

    it("should render 501 NOT_SUPPORTED compatibility warning when queue does not support getJob", () => {
      const error = { code: "NOT_SUPPORTED", status: 501 };
      const html = JobView.render(
        { error, selectedQueue: "legacy-queue", jobId: "job-1" },
        [{ name: "legacy-queue" }]
      );
      assert.match(html, /Core Library Compatibility: getJob\(\) Not Supported/);
      assert.match(html, /does not implement the public <code>getJob\(id\)<\/code> API/);
    });

    it("should render generic error state with retry action on internal error", () => {
      const error = { code: "INTERNAL_ERROR", status: 500, message: "Redis connection timed out" };
      const html = JobView.render(
        { error, selectedQueue: "orders", jobId: "job-1" },
        [{ name: "orders" }]
      );
      assert.match(html, /Failed to Inspect Job/);
      assert.match(html, /Redis connection timed out/);
      assert.match(html, /id="job-retry-btn"/);
    });

    it("should render complete job details with state badges, progress bar, timing, and payloads", () => {
      const job = {
        id: "job-video-99",
        state: "active",
        progress: 72,
        attempt: 2,
        stalledCount: 1,
        createdAt: 1700000000000,
        startedAt: 1700000010000,
        completedAt: null,
        failedAt: null,
        retriedAt: null,
        failureReason: null,
        idempotencyKey: "idem-vid-99",
        delay: 5000,
        ttlSeconds: 86400,
        removeOnComplete: true,
        removeOnFail: 50,
        data: { inputUri: "s3://bucket/video.mov", format: "mp4" },
        returnValue: null
      };

      const html = JobView.render(
        { job, selectedQueue: "video-transcoding", jobId: "job-video-99" },
        [{ name: "video-transcoding" }]
      );

      assert.match(html, /job-video-99/);
      assert.match(html, /badge-active/);
      assert.match(html, /State: active/);
      assert.match(html, /style="width: 72%;"/);
      assert.match(html, /72%/);
      assert.match(html, /idem-vid-99/);
      assert.match(html, /5000ms/);
      assert.match(html, /86400s/);
      assert.match(html, /Remove immediately/);
      assert.match(html, /Keep latest 50 jobs/);
      assert.match(html, /s3:\/\/bucket\/video\.mov/);
    });

    it("should render completed job with return value", () => {
      const job = {
        id: "job-completed-1",
        state: "completed",
        progress: 100,
        attempt: 1,
        stalledCount: 0,
        createdAt: 1700000000000,
        startedAt: 1700000010000,
        completedAt: 1700000020000,
        data: { target: "email" },
        returnValue: { messageId: "msg-12345", status: "SENT" }
      };

      const html = JobView.render(
        { job, selectedQueue: "emails", jobId: "job-completed-1" },
        [{ name: "emails" }]
      );

      assert.match(html, /badge-completed/);
      assert.match(html, /State: completed/);
      assert.match(html, /msg-12345/);
      assert.match(html, /SENT/);
    });

    it("should render failed job with failure diagnostics callout", () => {
      const job = {
        id: "job-failed-1",
        state: "failed",
        progress: 50,
        attempt: 3,
        stalledCount: 2,
        createdAt: 1700000000000,
        startedAt: 1700000010000,
        failedAt: 1700000030000,
        failureReason: "ECONNREFUSED 127.0.0.1:5432",
        data: { query: "SELECT * FROM users" }
      };

      const html = JobView.render(
        { job, selectedQueue: "db-sync", jobId: "job-failed-1" },
        [{ name: "db-sync" }]
      );

      assert.match(html, /badge-failed/);
      assert.match(html, /State: failed/);
      assert.match(html, /ECONNREFUSED 127\.0\.0\.1:5432/);
      assert.match(html, /SELECT \* FROM users/);
    });

    it("should safely sanitize malicious job properties to prevent XSS", () => {
      const maliciousJob = {
        id: "<script>alert('id')</script>",
        state: "<img src=x onerror=alert('state')>",
        progress: 0,
        attempt: 1,
        failureReason: "<script>alert('err')</script>",
        idempotencyKey: "<b onmouseover=alert(1)>key</b>",
        data: { payload: "<svg onload=alert('data')>" },
        returnValue: { output: "<iframe src='evil.com'></iframe>" }
      };

      const html = JobView.render(
        { job: maliciousJob, selectedQueue: "test-queue", jobId: "<script>alert('id')</script>" },
        [{ name: "test-queue" }]
      );

      assert.doesNotMatch(html, /<script>/i);
      assert.doesNotMatch(html, /<img src=x/i);
      assert.doesNotMatch(html, /<svg onload/i);
      assert.doesNotMatch(html, /<iframe src/i);
      assert.match(html, /&lt;script&gt;alert\(&#039;id&#039;\)&lt;\/script&gt;/);
      assert.match(html, /&lt;img src=x/);
      assert.match(html, /&lt;svg onload/);
    });
  });

  describe("DashboardApp Controller Logic", () => {
    it("should initialize with default active view and view titles", () => {
      const app = new DashboardApp({ baseUrl: "/admin" });
      assert.equal(app.state.activeView, "overview");
      assert.equal(app.state.queues.length, 0);
      assert.equal(app.apiClient.baseUrl, "/admin");
    });

    it("should navigate between views and update active view state", () => {
      const app = new DashboardApp();
      assert.equal(app.state.activeView, "overview");

      app.navigate("dlq");
      assert.equal(app.state.activeView, "dlq");

      app.navigate("job");
      assert.equal(app.state.activeView, "job");

      // Invalid view falls back to overview
      app.navigate("invalid-view");
      assert.equal(app.state.activeView, "overview");
    });

    it("should fetch queues and update internal state on success", async () => {
      const mockQueues = [
        {
          name: "email-queue",
          isPaused: false,
          metrics: { waiting: 1, active: 0, delayed: 0, dlq: 0 }
        }
      ];

      const mockApiClient = {
        getQueues: async () => ({ queues: mockQueues })
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      await app.fetchQueues();

      assert.equal(app.state.loading, false);
      assert.equal(app.state.error, null);
      assert.deepEqual(app.state.queues, mockQueues);
      assert(app.state.lastUpdated instanceof Date);
    });

    it("should record error state on API failure", async () => {
      const mockError = new Error("Connection refused");
      const mockApiClient = {
        getQueues: async () => {
          throw mockError;
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      await app.fetchQueues();

      assert.equal(app.state.loading, false);
      assert.equal(app.state.error, mockError);
      assert.deepEqual(app.state.queues, []);
    });

    it("should fetch DLQ jobs and update internal dlq state on success", async () => {
      const mockDlqResponse = {
        jobs: [{ id: "job-1", attempt: 2, failureReason: "err", data: {} }],
        total: 1,
        start: 0,
        limit: 50,
        order: "desc"
      };
      const mockApiClient = {
        getQueueDLQ: async (name, params) => {
          assert.equal(name, "emails");
          assert.deepEqual(params, { start: 0, limit: 50, order: "desc" });
          return mockDlqResponse;
        }
      };
      const app = new DashboardApp({ apiClient: mockApiClient });
      app.state.dlq.selectedQueue = "emails";
      await app.fetchDLQ();

      assert.equal(app.state.dlq.loading, false);
      assert.equal(app.state.dlq.error, null);
      assert.equal(app.state.dlq.total, 1);
      assert.equal(app.state.dlq.jobs.length, 1);
      assert.equal(app.state.dlq.jobs[0].id, "job-1");
    });

    it("should record DLQ error state on API failure", async () => {
      const mockError = new Error("500 Internal Error");
      const mockApiClient = {
        getQueueDLQ: async () => {
          throw mockError;
        }
      };
      const app = new DashboardApp({ apiClient: mockApiClient });
      app.state.dlq.selectedQueue = "emails";
      await app.fetchDLQ();

      assert.equal(app.state.dlq.loading, false);
      assert.equal(app.state.dlq.error, mockError);
      assert.deepEqual(app.state.dlq.jobs, []);
    });

    it("should handle navigate('dlq', { queue: 'orders' }) and reset pagination", () => {
      let fetchedQueue = null;
      const mockApiClient = {
        getQueueDLQ: async (name) => {
          fetchedQueue = name;
          return { jobs: [], total: 0, start: 0, limit: 50, order: "desc" };
        }
      };
      const app = new DashboardApp({ apiClient: mockApiClient });
      app.state.dlq.start = 50;
      app.state.dlq.expandedJobIndex = 2;
      app.navigate("dlq", { queue: "orders" });

      assert.equal(app.state.activeView, "dlq");
      assert.equal(app.state.dlq.selectedQueue, "orders");
      assert.equal(app.state.dlq.start, 0);
      assert.equal(app.state.dlq.expandedJobIndex, null);
      assert.equal(fetchedQueue, "orders");
    });

    it("should auto-select queue with DLQ items when fetching queues on DLQ view", async () => {
      let dlqFetched = null;
      const mockQueues = [
        { name: "clean-queue", metrics: { dlq: 0 } },
        { name: "failing-queue", metrics: { dlq: 4 } }
      ];
      const mockApiClient = {
        getQueues: async () => ({ queues: mockQueues }),
        getQueueDLQ: async (name) => {
          dlqFetched = name;
          return { jobs: [], total: 4 };
        }
      };
      const app = new DashboardApp({ apiClient: mockApiClient });
      app.state.activeView = "dlq";
      await app.fetchQueues();

      assert.equal(app.state.dlq.selectedQueue, "failing-queue");
      assert.equal(dlqFetched, "failing-queue");
    });

    it("should ignore stale out-of-order DLQ responses", async () => {
      let resolveFirst;
      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const mockApiClient = {
        getQueueDLQ: async (name) => {
          if (name === "slow-queue") {
            await firstPromise;
            return { jobs: [{ id: "slow-job" }], total: 1, start: 0, limit: 50, order: "desc" };
          }
          return { jobs: [{ id: "fast-job" }], total: 1, start: 0, limit: 50, order: "desc" };
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });

      // Request 1: slow-queue
      app.state.dlq.selectedQueue = "slow-queue";
      const p1 = app.fetchDLQ();

      // Request 2: fast-queue before p1 resolves
      app.state.dlq.selectedQueue = "fast-queue";
      const p2 = app.fetchDLQ();

      await p2;
      assert.equal(app.state.dlq.selectedQueue, "fast-queue");
      assert.equal(app.state.dlq.jobs[0].id, "fast-job");

      // Now resolve the older slow-queue request
      resolveFirst();
      await p1;

      // Ensure state was NOT overwritten by slow-queue response
      assert.equal(app.state.dlq.selectedQueue, "fast-queue");
      assert.equal(app.state.dlq.jobs[0].id, "fast-job");
    });

    it("should prevent redundant hashchange re-navigation when state already matches", () => {
      const app = new DashboardApp();
      app.state.activeView = "dlq";
      app.state.dlq.selectedQueue = "orders";

      let navigated = false;
      app.navigate = () => {
        navigated = true;
      };

      const originalWindow = globalThis.window;
      try {
        globalThis.window = {
          location: { hash: "#/dlq?queue=orders" }
        };

        app.handleHashChange();
        assert.equal(navigated, false);
      } finally {
        globalThis.window = originalWindow;
      }
    });

    it("should fetch job descriptor and update internal job state on success", async () => {
      const mockJob = {
        id: "job-xyz",
        state: "completed",
        progress: 100,
        data: { test: true }
      };
      const mockApiClient = {
        getJob: async (queue, jobId) => {
          assert.equal(queue, "emails");
          assert.equal(jobId, "job-xyz");
          return { job: mockJob };
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      await app.fetchJob("emails", "job-xyz");

      assert.equal(app.state.job.loading, false);
      assert.equal(app.state.job.error, null);
      assert.deepEqual(app.state.job.job, mockJob);
      assert.equal(app.state.job.selectedQueue, "emails");
      assert.equal(app.state.job.jobId, "job-xyz");
    });

    it("should set validation error in fetchJob when queue or jobId is omitted", async () => {
      const app = new DashboardApp({ apiClient: {} });
      await app.fetchJob("", "job-1");

      assert.equal(app.state.job.loading, false);
      assert.equal(app.state.job.error?.code, "VALIDATION_ERROR");
      assert.match(app.state.job.error.message, /Please select a registered queue/);

      await app.fetchJob("emails", "");
      assert.equal(app.state.job.loading, false);
      assert.equal(app.state.job.error?.code, "VALIDATION_ERROR");
      assert.match(app.state.job.error.message, /jobId must be a non-empty string/);
    });

    it("should record job error state on API failure", async () => {
      const mockError = new Error("404 Not Found");
      mockError.status = 404;
      mockError.code = "JOB_NOT_FOUND";

      const mockApiClient = {
        getJob: async () => {
          throw mockError;
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      await app.fetchJob("emails", "missing-job");

      assert.equal(app.state.job.loading, false);
      assert.equal(app.state.job.error, mockError);
      assert.equal(app.state.job.job, null);
    });

    it("should ignore stale out-of-order job responses", async () => {
      let resolveFirst;
      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const mockApiClient = {
        getJob: async (queue, id) => {
          if (id === "slow-job") {
            await firstPromise;
            return { job: { id: "slow-job", state: "active" } };
          }
          return { job: { id: "fast-job", state: "completed" } };
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      app.state.job.selectedQueue = "orders";

      // Request 1: slow-job
      const p1 = app.fetchJob("orders", "slow-job");

      // Request 2: fast-job before p1 completes
      const p2 = app.fetchJob("orders", "fast-job");

      await p2;
      assert.equal(app.state.job.jobId, "fast-job");
      assert.equal(app.state.job.job.id, "fast-job");

      // Resolve older slow-job
      resolveFirst();
      await p1;

      // State should not be overwritten
      assert.equal(app.state.job.jobId, "fast-job");
      assert.equal(app.state.job.job.id, "fast-job");
    });

    it("should handle navigate('job', { queue: 'emails', jobId: 'job-55' }) and trigger fetchJob", () => {
      let fetchedParams = null;
      const mockApiClient = {
        getJob: async (q, id) => {
          fetchedParams = { q, id };
          return { job: { id, state: "waiting" } };
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      app.navigate("job", { queue: "emails", jobId: "job-55" });

      assert.equal(app.state.activeView, "job");
      assert.equal(app.state.job.selectedQueue, "emails");
      assert.equal(app.state.job.jobId, "job-55");
      assert.deepEqual(fetchedParams, { q: "emails", id: "job-55" });
    });

    it("should handle hash routing for #/job?queue=orders&jobId=job-99", () => {
      let fetchedParams = null;
      const mockApiClient = {
        getJob: async (q, id) => {
          fetchedParams = { q, id };
          return { job: { id, state: "completed" } };
        }
      };

      const app = new DashboardApp({ apiClient: mockApiClient });
      const originalWindow = globalThis.window;
      try {
        globalThis.window = {
          location: { hash: "#/job?queue=orders&jobId=job-99" }
        };

        app.handleHashChange();
        assert.equal(app.state.activeView, "job");
        assert.equal(app.state.job.selectedQueue, "orders");
        assert.equal(app.state.job.jobId, "job-99");
        assert.deepEqual(fetchedParams, { q: "orders", id: "job-99" });
      } finally {
        globalThis.window = originalWindow;
      }
    });
  });

  describe("UI Asset Resolution and Static Serving via Dispatcher", () => {
    it("should resolve index.html for root path and /index.html", () => {
      const assetRoot = resolveUiAssetPath("/");
      assert(assetRoot);
      assert.equal(assetRoot.fullPath, path.resolve(UI_DIR, "index.html"));
      assert.match(assetRoot.contentType, /text\/html/);

      const assetIndex = resolveUiAssetPath("/index.html");
      assert(assetIndex);
      assert.equal(assetIndex.fullPath, path.resolve(UI_DIR, "index.html"));
    });

    it("should resolve styles.css with text/css content type", () => {
      const assetCss = resolveUiAssetPath("/styles.css");
      assert(assetCss);
      assert.equal(assetCss.fullPath, path.resolve(UI_DIR, "styles.css"));
      assert.match(assetCss.contentType, /text\/css/);
    });

    it("should resolve api-client.js and app.js with application/javascript content type", () => {
      const assetApiClient = resolveUiAssetPath("/api-client.js");
      assert(assetApiClient);
      assert.match(assetApiClient.contentType, /application\/javascript/);

      const assetApp = resolveUiAssetPath("/app.js");
      assert(assetApp);
      assert.match(assetApp.contentType, /application\/javascript/);
    });

    it("should reject path traversal attempts and return null", () => {
      assert.equal(resolveUiAssetPath("/../package.json"), null);
      assert.equal(resolveUiAssetPath("/../../src/index.js"), null);
      assert.equal(resolveUiAssetPath("/%2e%2e/package.json"), null);
      assert.equal(resolveUiAssetPath("/%2e%2e%2fpackage.json"), null);
      assert.equal(resolveUiAssetPath("/styles.css\0.html"), null);
      assert.equal(resolveUiAssetPath(null), null);
      assert.equal(resolveUiAssetPath(undefined), null);
      assert.equal(resolveUiAssetPath("/non-existent-asset.xyz"), null);
    });

    it("should resolve /ui and /ui/ to index.html and /ui/styles.css to styles.css", () => {
      const assetUi = resolveUiAssetPath("/ui");
      assert(assetUi);
      assert.equal(assetUi.fullPath, path.resolve(UI_DIR, "index.html"));

      const assetUiSlash = resolveUiAssetPath("/ui/");
      assert(assetUiSlash);
      assert.equal(assetUiSlash.fullPath, path.resolve(UI_DIR, "index.html"));

      const assetUiCss = resolveUiAssetPath("/ui/styles.css");
      assert(assetUiCss);
      assert.equal(assetUiCss.fullPath, path.resolve(UI_DIR, "styles.css"));
    });

    it("should serve index.html when GET / is dispatched", async () => {
      const dummyQueue = { getMetrics: async () => ({}), isPaused: async () => false };
      const dispatcher = createDashboardDispatcher({
        queues: { emails: dummyQueue }
      });

      let sentStatus = null;
      let sentType = null;
      let sentContent = null;

      const res = {
        statusCode: 200,
        setHeader(name, val) {
          if (name.toLowerCase() === "content-type") sentType = val;
        },
        end(data) {
          sentContent = data;
        }
      };

      await dispatcher.dispatch({ method: "GET", url: "/" }, res);

      assert.match(sentType, /text\/html/);
      assert.match(sentContent.toString(), /ResilientQueue Dashboard/);
    });

    it("should serve styles.css when GET /styles.css is dispatched", async () => {
      const dummyQueue = { getMetrics: async () => ({}), isPaused: async () => false };
      const dispatcher = createDashboardDispatcher({
        queues: { emails: dummyQueue }
      });

      let sentType = null;
      let sentContent = null;

      const res = {
        statusCode: 200,
        setHeader(name, val) {
          if (name.toLowerCase() === "content-type") sentType = val;
        },
        end(data) {
          sentContent = data;
        }
      };

      await dispatcher.dispatch({ method: "GET", url: "/styles.css" }, res);

      assert.match(sentType, /text\/css/);
      assert.match(sentContent.toString(), /--sidebar-width/);
    });

    it("should serve index.html under configured basePath", async () => {
      const dummyQueue = { getMetrics: async () => ({}), isPaused: async () => false };
      const dispatcher = createDashboardDispatcher({
        basePath: "/admin/queues",
        queues: { emails: dummyQueue }
      });

      let sentType = null;
      let sentContent = null;

      const res = {
        statusCode: 200,
        setHeader(name, val) {
          if (name.toLowerCase() === "content-type") sentType = val;
        },
        end(data) {
          sentContent = data;
        }
      };

      await dispatcher.dispatch({ method: "GET", url: "/admin/queues/" }, res);

      assert.match(sentType, /text\/html/);
      assert.match(sentContent.toString(), /ResilientQueue Dashboard/);
    });
  });
});
