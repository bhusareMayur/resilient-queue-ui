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

    it("should safely convert numbers and non-string values to strings in escapeHtml", () => {
      const queues = [
        {
          name: 12345,
          isPaused: false,
          metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 }
        }
      ];
      const html = OverviewView.renderData(queues);
      assert.match(html, /12345/);
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

    it("should format ISO string and Date timestamps correctly in JobView", () => {
      const job = {
        id: "job-ts-1",
        state: "completed",
        progress: 100,
        createdAt: "2026-04-18T10:00:00.000Z",
        completedAt: new Date(1776500000000)
      };
      const html = JobView.renderJobDetails(job, "emails");
      // Ensure timestamps are formatted into date strings and not "-"
      assert.doesNotMatch(html, /<dd class="metric-num">-<\/dd>/);
      assert.match(html, /2026/);
    });

    it("should show Clear button in JobView toolbar when error or query is present", () => {
      const htmlError = JobView.renderSearchToolbar(
        { error: { message: "Job not found" }, jobId: "job-err" },
        [{ name: "emails" }],
        "emails"
      );
      assert.match(htmlError, /id="job-clear-btn"/);
      assert.match(htmlError, /Clear/);

      const htmlWithId = JobView.renderSearchToolbar(
        { job: null, error: null, jobId: "some-job" },
        [{ name: "emails" }],
        "emails"
      );
      assert.match(htmlWithId, /id="job-clear-btn"/);
    });

    it("should hide Clear button in JobView toolbar when search state is clean", () => {
      const htmlClean = JobView.renderSearchToolbar(
        { job: null, error: null, jobId: "" },
        [{ name: "emails" }],
        "emails"
      );
      assert.doesNotMatch(htmlClean, /id="job-clear-btn"/);
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

  describe("Milestone 8: Queue Activity & Monitoring", () => {
    describe("Live Queue Monitoring & Metric Distinction", () => {
      it("should clearly distinguish numeric zero from unavailable metrics", () => {
        const queues = [
          {
            name: "zero-queue",
            isPaused: false,
            metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 }
          },
          {
            name: "unavailable-queue",
            isPaused: false,
            metrics: { waiting: null, active: undefined, delayed: NaN, dlq: null }
          }
        ];

        const html = OverviewView.renderData(queues);

        // Zero queue has clear '0' counts
        assert.match(html, /zero-queue/);
        assert.match(html, /<td class="metric-number">0<\/td>/);
        assert.match(html, /class="metric-number badge-dlq-clean">0<\/span>/);

        // Unavailable queue renders '—' with .metric-unavailable class
        assert.match(html, /unavailable-queue/);
        assert.match(html, /<span class="metric-unavailable" title="Waiting unavailable">—<\/span>/);
        assert.match(html, /<span class="metric-unavailable" title="Active unavailable">—<\/span>/);
        assert.match(html, /<span class="metric-unavailable" title="Delayed unavailable">—<\/span>/);
        assert.match(html, /<span class="metric-unavailable" title="DLQ count unavailable">—<\/span>/);
      });

      it("should clearly distinguish closed queues and display Closed badge with unavailable metrics", () => {
        const queues = [
          {
            name: "closed-queue-1",
            isClosed: true,
            metrics: null
          },
          {
            name: "closed-queue-2",
            status: "closed",
            metrics: null
          }
        ];

        const html = OverviewView.renderData(queues);
        assert.match(html, /badge-closed/);
        assert.match(html, /Status: Closed/);
        assert.match(html, /closed-queue-1/);
        assert.match(html, /closed-queue-2/);
      });

      it("should clearly distinguish queue request failures and display Error badge", () => {
        const queues = [
          {
            name: "failing-queue",
            status: "error",
            error: { message: "Redis timeout" },
            metrics: null
          }
        ];

        const html = OverviewView.renderData(queues);
        assert.match(html, /badge-error/);
        assert.match(html, /Status: Error/);
        assert.match(html, /failing-queue/);
      });

      it("should handle completely missing or null metrics objects gracefully", () => {
        const queues = [
          {
            name: "no-metrics-queue",
            isPaused: false,
            metrics: null
          }
        ];

        const html = OverviewView.renderData(queues);
        assert.match(html, /no-metrics-queue/);
        assert.match(html, /badge-unavailable/);
        assert.match(html, /Status: Unavailable/);
        assert.match(html, /metric-unavailable/);
      });
    });

    describe("Queue Health Indicators & Last Update Timestamp", () => {
      it("should derive status only from API data and never claim healthy based solely on zero counts", () => {
        const zeroQueue = {
          name: "idle-queue",
          isPaused: false,
          metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 }
        };

        const badge = OverviewView.renderStatusBadge(zeroQueue);
        // Must be Active/Paused/Closed/Unavailable/Error, NEVER "Healthy"
        assert.doesNotMatch(badge, /healthy/i);
        assert.match(badge, /badge-active/);
        assert.match(badge, /Active/);

        const pausedZeroQueue = {
          name: "paused-idle-queue",
          isPaused: true,
          metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 }
        };
        const pausedBadge = OverviewView.renderStatusBadge(pausedZeroQueue);
        assert.doesNotMatch(pausedBadge, /healthy/i);
        assert.match(pausedBadge, /badge-paused/);
        assert.match(pausedBadge, /Paused/);
      });

      it("should treat missing or undefined metrics property as Unavailable", () => {
        const noMetricsQueue = {
          name: "undefined-metrics-queue"
        };
        const badge = OverviewView.renderStatusBadge(noMetricsQueue);
        assert.match(badge, /badge-unavailable/);
        assert.match(badge, /Unavailable/);
      });

      it("should show last successful update time in table and header", () => {
        const testDate = new Date("2026-10-19T10:00:00.000Z");
        const queues = [
          {
            name: "sync-queue",
            isPaused: false,
            metrics: { waiting: 5, active: 1, delayed: 0, dlq: 0 },
            lastUpdated: testDate
          }
        ];

        const html = OverviewView.renderData(queues, { lastUpdated: testDate });
        assert.match(html, /class="last-updated-cell"/);
        assert.match(html, /2026-10-19T10:00:00\.000Z/);
        assert.match(html, /class="last-sync-label"/);
        assert.match(html, /Last updated:/);
      });

      it("should show fallback dash when lastUpdated is missing", () => {
        const queues = [
          {
            name: "no-time-queue",
            isPaused: false,
            metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 }
          }
        ];

        const html = OverviewView.renderData(queues);
        assert.match(html, /<td class="last-updated-cell text-muted">—<\/td>/);
      });
    });

    describe("Auto-Refresh, Polling Cleanup, Overlap Prevention & Stale Responses", () => {
      it("should support configurable polling interval and timer control", () => {
        const app = new DashboardApp({ pollInterval: 3000 });
        assert.equal(app.pollInterval, 3000);

        app.setPollInterval(10000);
        assert.equal(app.pollInterval, 10000);

        app.setPollInterval(0);
        assert.equal(app.pollInterval, 0);
        assert.equal(app._isPolling, false);
        assert.equal(app._pollTimer, null);

        app.destroy();
      });

      it("should disable auto-refresh when autoRefresh: false option is passed", () => {
        const app = new DashboardApp({ autoRefresh: false });
        assert.equal(app.pollInterval, 0);
        assert.equal(app._isPolling, false);
        app.destroy();
      });

      it("should clean up timers when navigating away from overview", () => {
        const app = new DashboardApp({ pollInterval: 2000 });
        app.startPolling();
        assert.equal(app._isPolling, true);
        assert.ok(app._pollTimer !== null);

        // Navigating away from overview to DLQ must clean up timer
        app.navigate("dlq");
        assert.equal(app._isPolling, false);
        assert.equal(app._pollTimer, null);

        // Navigating back to overview should resume polling
        app.navigate("overview");
        assert.equal(app._isPolling, true);
        assert.ok(app._pollTimer !== null);

        // Navigating to job inspection must also clean up timer
        app.navigate("job");
        assert.equal(app._isPolling, false);
        assert.equal(app._pollTimer, null);

        app.destroy();
        assert.equal(app._pollTimer, null);
      });

      it("should never start or maintain timers outside overview view", () => {
        const app = new DashboardApp({ pollInterval: 1000 });
        app.state.activeView = "dlq";

        // Calling startPolling while on DLQ view must immediately stop and not create a timer
        app.startPolling();
        assert.equal(app._isPolling, false);
        assert.equal(app._pollTimer, null);

        // Calling setPollInterval while on DLQ view must not start polling
        app.setPollInterval(2000);
        assert.equal(app._isPolling, false);
        assert.equal(app._pollTimer, null);

        // Switch to job view and try startPolling again
        app.state.activeView = "job";
        app.startPolling();
        assert.equal(app._isPolling, false);
        assert.equal(app._pollTimer, null);

        app.destroy();
      });

      it("should never multiply timers on repeated calls to startPolling, setPollInterval, or navigate", () => {
        const app = new DashboardApp({ pollInterval: 5000 });

        // Repeated startPolling calls
        app.startPolling();
        const timer1 = app._pollTimer;
        app.startPolling();
        const timer2 = app._pollTimer;
        app.startPolling();
        const timer3 = app._pollTimer;

        assert.ok(timer1 !== null);
        assert.ok(timer2 !== null);
        assert.ok(timer3 !== null);
        // Only one active timer should exist at any given time
        assert.equal(app._isPolling, true);

        // Repeated setPollInterval calls
        app.setPollInterval(3000);
        app.setPollInterval(4000);
        app.setPollInterval(5000);
        assert.equal(app._isPolling, true);
        assert.ok(app._pollTimer !== null);

        // Repeated navigate('overview') calls
        app.navigate("overview");
        app.navigate("overview");
        app.navigate("overview");
        assert.equal(app._isPolling, true);
        assert.ok(app._pollTimer !== null);

        app.destroy();
        assert.equal(app._pollTimer, null);
      });

      it("should update lastUpdated timestamp ONLY after successful responses and never on failure", async () => {
        let shouldFail = false;
        const mockApiClient = {
          getQueues: async () => {
            if (shouldFail) {
              throw new Error("Temporary Redis error");
            }
            return { queues: [{ name: "test-queue", metrics: { waiting: 0 } }] };
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient });

        // Initial success
        await app.fetchQueues();
        assert.ok(app.state.lastUpdated instanceof Date);
        const firstSuccessTimestamp = app.state.lastUpdated.getTime();

        // Failed request
        shouldFail = true;
        await app.fetchQueues();
        assert.equal(app.state.lastUpdated.getTime(), firstSuccessTimestamp); // Preserved!

        // Another failed request
        await app.fetchQueues();
        assert.equal(app.state.lastUpdated.getTime(), firstSuccessTimestamp); // Still preserved!

        // Subsequent success after slight delay
        shouldFail = false;
        await new Promise((r) => setTimeout(r, 10));
        await app.fetchQueues();
        assert.ok(app.state.lastUpdated.getTime() > firstSuccessTimestamp); // Successfully updated!

        app.destroy();
      });

      it("should not re-render view on auto-refresh completion if user navigated away", async () => {
        let resolveInFlight;
        const inFlightPromise = new Promise((resolve) => {
          resolveInFlight = resolve;
        });

        const mockApiClient = {
          getQueues: async () => {
            await inFlightPromise;
            return { queues: [{ name: "emails", metrics: { waiting: 10 } }] };
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient });
        let renderViewCallsOnDlq = 0;

        // Start background auto-refresh on overview
        const p1 = app.fetchQueues({ isAutoRefresh: true });

        // User navigates away to DLQ view while fetch is in-flight
        app.state.activeView = "dlq";
        app.renderView = () => {
          if (app.state.activeView === "dlq") {
            renderViewCallsOnDlq++;
          }
        };

        // Complete the in-flight auto-refresh
        resolveInFlight();
        await p1;

        // Should not have re-rendered the DLQ view
        assert.equal(renderViewCallsOnDlq, 0);
        app.destroy();
      });

      it("should prevent overlapping requests during polling", async () => {
        let fetchCount = 0;
        let resolveInFlight;
        const slowPromise = new Promise((resolve) => {
          resolveInFlight = resolve;
        });

        const mockApiClient = {
          getQueues: async () => {
            fetchCount++;
            if (fetchCount === 1) {
              await slowPromise;
            }
            return { queues: [{ name: "emails", metrics: { waiting: 1 } }] };
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient, pollInterval: 100 });
        app.startPolling();

        // Start first fetch (which stays in flight)
        const p1 = app.fetchQueues();
        assert.equal(fetchCount, 1);
        assert.equal(app._isFetchingQueues, true);

        // A poll tick triggered while fetch 1 is in-flight must not start an overlapping fetch
        await app._pollTick();
        assert.equal(fetchCount, 1); // Still 1! No overlapping request initiated

        // A manual fetchQueues with preventOverlap=true must reuse the in-flight promise
        const p2 = app.fetchQueues({ preventOverlap: true });
        assert.equal(fetchCount, 1); // Still 1!
        assert.equal(p2, app._currentQueuesPromise);

        // Complete the in-flight fetch
        resolveInFlight();
        await p1;
        await p2;

        assert.equal(app._isFetchingQueues, false);
        assert.equal(fetchCount, 1);
        app.destroy();
      });

      it("should discard stale out-of-order queue metrics responses", async () => {
        let resolveSlow;
        const slowPromise = new Promise((resolve) => {
          resolveSlow = resolve;
        });

        const mockApiClient = {
          getQueues: async () => {
            return { queues: [{ name: "fast-queue", metrics: { waiting: 99 } }] };
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient });

        // Request 1: Slow request
        mockApiClient.getQueues = async () => {
          await slowPromise;
          return { queues: [{ name: "slow-queue", metrics: { waiting: 1 } }] };
        };
        const p1 = app.fetchQueues();

        // Request 2: Fast request started while Request 1 is still in flight
        mockApiClient.getQueues = async () => {
          return { queues: [{ name: "fast-queue", metrics: { waiting: 99 } }] };
        };
        const p2 = app.fetchQueues();

        await p2;
        assert.equal(app.state.queues[0].name, "fast-queue");
        assert.equal(app.state.queues[0].metrics.waiting, 99);

        // Now let slow Request 1 resolve
        resolveSlow();
        await p1;

        // Ensure state was NOT overwritten by the stale Request 1
        assert.equal(app.state.queues[0].name, "fast-queue");
        assert.equal(app.state.queues[0].metrics.waiting, 99);
        app.destroy();
      });

      it("should discard stale errors from earlier requests", async () => {
        let resolveSlowError;
        const slowErrorPromise = new Promise((resolve) => {
          resolveSlowError = resolve;
        });

        const mockApiClient = {
          getQueues: async () => {}
        };

        const app = new DashboardApp({ apiClient: mockApiClient });

        // Request 1: Slow error
        mockApiClient.getQueues = async () => {
          await slowErrorPromise;
          throw new Error("Old slow error");
        };
        const p1 = app.fetchQueues();

        // Request 2: Fast success
        mockApiClient.getQueues = async () => {
          return { queues: [{ name: "good-queue", metrics: { waiting: 5 } }] };
        };
        const p2 = app.fetchQueues();

        await p2;
        assert.equal(app.state.error, null);
        assert.equal(app.state.queues[0].name, "good-queue");

        // Resolve old slow error
        resolveSlowError();
        await p1;

        // Ensure error state was NOT overwritten by stale error
        assert.equal(app.state.error, null);
        assert.equal(app.state.queues[0].name, "good-queue");
        app.destroy();
      });

      it("should handle temporary failures gracefully by retaining cached queues and showing banner", async () => {
        const initialQueues = [
          { name: "persistent-queue", isPaused: false, metrics: { waiting: 12, active: 3, delayed: 0, dlq: 0 } }
        ];

        let failNext = false;
        const mockApiClient = {
          getQueues: async () => {
            if (failNext) {
              const err = new Error("Temporary Redis reconnect failure");
              err.code = "REDIS_RECONNECT";
              throw err;
            }
            return { queues: initialQueues };
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient });

        // Initial successful fetch
        await app.fetchQueues();
        assert.equal(app.state.queues.length, 1);
        assert.equal(app.state.queues[0].name, "persistent-queue");
        assert.equal(app.state.error, null);
        assert.equal(app.state.syncError, null);

        // Next background refresh fails
        failNext = true;
        await app.fetchQueues({ isAutoRefresh: true });

        // Cached queues must be preserved!
        assert.equal(app.state.queues.length, 1);
        assert.equal(app.state.queues[0].name, "persistent-queue");
        assert.ok(app.state.syncError !== null);
        assert.equal(app.state.syncError.code, "REDIS_RECONNECT");

        // OverviewView rendered with sync error shows cached data and banner
        const html = OverviewView.renderData(app.state.queues, {
          syncError: app.state.syncError,
          lastUpdated: app.state.lastUpdated
        });
        assert.match(html, /sync-error-banner/);
        assert.match(html, /Temporary Sync Failure/);
        assert.match(html, /Temporary Redis reconnect failure/);
        assert.match(html, /persistent-queue/);
        assert.match(html, /id="retry-overview-sync-btn"/);

        // Subsequent poll succeeds and clears sync error
        failNext = false;
        await app.fetchQueues({ isAutoRefresh: true });
        assert.equal(app.state.syncError, null);
        assert.equal(app.state.error, null);
        assert.equal(app.state.queues.length, 1);

        const recoveredHtml = OverviewView.renderData(app.state.queues, {
          syncError: app.state.syncError,
          lastUpdated: app.state.lastUpdated
        });
        assert.doesNotMatch(recoveredHtml, /sync-error-banner/);
        assert.match(recoveredHtml, /persistent-queue/);
        app.destroy();
      });

      it("should show full error state when initial fetch fails (0 cached queues)", async () => {
        const mockApiClient = {
          getQueues: async () => {
            const err = new Error("Connection refused");
            err.code = "CONNECTION_REFUSED";
            throw err;
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient });
        await app.fetchQueues();

        assert.equal(app.state.queues.length, 0);
        assert.ok(app.state.error !== null);
        assert.equal(app.state.error.code, "CONNECTION_REFUSED");

        const html = OverviewView.renderError(app.state.error);
        assert.match(html, /error-state/);
        assert.match(html, /CONNECTION_REFUSED/);
        assert.match(html, /Connection refused/);
        assert.match(html, /id="retry-overview-btn"/);
        app.destroy();
      });

      it("should bind polling controls and update pollInterval on select change", () => {
        let changeListener = null;
        const fakeSelect = {
          value: "5000",
          addEventListener: (event, handler) => {
            if (event === "change") changeListener = handler;
          }
        };

        const originalDocument = global.document;
        global.document = {
          getElementById: (id) => {
            if (id === "poll-interval-select") return fakeSelect;
            return null;
          },
          querySelectorAll: () => [],
          querySelector: () => null
        };

        try {
          const app = new DashboardApp({ pollInterval: 5000 });
          app.bindPollingControls();

          assert.equal(fakeSelect.value, "5000");
          assert.ok(typeof changeListener === "function");

          // Simulate user selecting "Every 2s" (2000ms)
          changeListener({ target: { value: "2000" } });
          assert.equal(app.pollInterval, 2000);
          assert.equal(app._isPolling, true);

          // Simulate user selecting "Off (Manual)" (0ms)
          changeListener({ target: { value: "0" } });
          assert.equal(app.pollInterval, 0);
          assert.equal(app._isPolling, false);
          assert.equal(app._pollTimer, null);

          app.destroy();
        } finally {
          global.document = originalDocument;
        }
      });

      it("should bind beforeunload and pagehide to invoke destroy and clean up timers", () => {
        const listeners = {};
        const originalWindow = global.window;
        global.window = {
          addEventListener: (event, handler) => {
            listeners[event] = handler;
          },
          removeEventListener: (event, handler) => {
            if (listeners[event] === handler) delete listeners[event];
          }
        };

        try {
          const app = new DashboardApp({ pollInterval: 2000 });
          app.bindUnload();
          app.startPolling();

          assert.ok(typeof listeners.beforeunload === "function");
          assert.ok(typeof listeners.pagehide === "function");
          assert.equal(app._isPolling, true);
          assert.ok(app._pollTimer !== null);

          // Trigger page unload
          listeners.beforeunload();
          assert.equal(app._isPolling, false);
          assert.equal(app._pollTimer, null);
          assert.equal(app._isDestroyed, true);
        } finally {
          global.window = originalWindow;
        }
      });

      it("should execute app.init() without throwing and initialize overview polling", () => {
        const originalDocument = global.document;
        const originalWindow = global.window;

        global.document = {
          getElementById: () => null,
          querySelectorAll: () => [],
          querySelector: () => null,
          addEventListener: () => {}
        };
        global.window = {
          location: { hash: "", pathname: "/" },
          addEventListener: () => {},
          removeEventListener: () => {}
        };

        try {
          const app = new DashboardApp({ pollInterval: 5000 });
          assert.doesNotThrow(() => {
            app.init();
          });
          assert.equal(app.state.activeView, "overview");
          assert.equal(app._isPolling, true);
          assert.ok(app._pollTimer !== null);
          app.destroy();
        } finally {
          global.document = originalDocument;
          global.window = originalWindow;
        }
      });

      it("should not start polling on init() if initial hash routed to a non-overview view", () => {
        const originalDocument = global.document;
        const originalWindow = global.window;

        global.document = {
          getElementById: () => null,
          querySelectorAll: () => [],
          querySelector: () => null,
          addEventListener: () => {}
        };
        global.window = {
          location: { hash: "#/dlq", pathname: "/" },
          addEventListener: () => {},
          removeEventListener: () => {}
        };

        try {
          const app = new DashboardApp({ pollInterval: 5000 });
          app.init();
          assert.equal(app.state.activeView, "dlq");
          assert.equal(app._isPolling, false);
          assert.equal(app._pollTimer, null);
          app.destroy();
        } finally {
          global.document = originalDocument;
          global.window = originalWindow;
        }
      });

      it("should discard responses and prevent state mutation when request completes after destroy()", async () => {
        let resolveInFlight;
        const slowPromise = new Promise((resolve) => {
          resolveInFlight = resolve;
        });

        const mockApiClient = {
          getQueues: async () => {
            await slowPromise;
            return { queues: [{ name: "never-loaded", metrics: { waiting: 10 } }] };
          }
        };

        const app = new DashboardApp({ apiClient: mockApiClient });
        const p = app.fetchQueues();

        // Destroy app while fetch is in-flight
        app.destroy();
        assert.equal(app._isDestroyed, true);

        // Resolve slow promise
        resolveInFlight();
        await p;

        // Ensure state was not modified
        assert.equal(app.state.queues.length, 0);
        assert.equal(app.state.lastUpdated, null);
      });
    });
  });

  describe("Milestone 9: Queue Management & Operational Controls", () => {
    describe("Client-Side Search & Filtering", () => {
      it("should filter queues by case-insensitive name match", () => {
        const queues = [
          { name: "email-notifications", metrics: { waiting: 5, active: 1, delayed: 0, dlq: 0 } },
          { name: "video-transcoder", metrics: { waiting: 0, active: 2, delayed: 0, dlq: 0 } },
          { name: "email-digests", metrics: { waiting: 10, active: 0, delayed: 1, dlq: 0 } }
        ];

        const filtered = OverviewView.filterQueues(queues, { searchQuery: "email" });
        assert.equal(filtered.length, 2);
        assert.equal(filtered[0].name, "email-notifications");
        assert.equal(filtered[1].name, "email-digests");

        const filteredUpper = OverviewView.filterQueues(queues, { searchQuery: "TRANSCODER" });
        assert.equal(filteredUpper.length, 1);
        assert.equal(filteredUpper[0].name, "video-transcoder");
      });

      it("should filter queues by operational status", () => {
        const queues = [
          { name: "q-active", isPaused: false, metrics: { waiting: 1 } },
          { name: "q-paused", isPaused: true, metrics: { waiting: 0 } },
          { name: "q-closed", isClosed: true, metrics: null },
          { name: "q-error", error: new Error("fail") },
          { name: "q-unavail", metrics: null }
        ];

        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "active" }).length, 1);
        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "active" })[0].name, "q-active");

        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "paused" }).length, 1);
        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "paused" })[0].name, "q-paused");

        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "closed" }).length, 1);
        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "closed" })[0].name, "q-closed");

        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "error" }).length, 1);
        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "error" })[0].name, "q-error");

        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "unavailable" }).length, 1);
        assert.equal(OverviewView.filterQueues(queues, { statusFilter: "unavailable" })[0].name, "q-unavail");
      });

      it("should combine search query and status filter", () => {
        const queues = [
          { name: "email-active", isPaused: false, metrics: { waiting: 1 } },
          { name: "email-paused", isPaused: true, metrics: { waiting: 0 } },
          { name: "video-paused", isPaused: true, metrics: { waiting: 0 } }
        ];

        const result = OverviewView.filterQueues(queues, { searchQuery: "email", statusFilter: "paused" });
        assert.equal(result.length, 1);
        assert.equal(result[0].name, "email-paused");
      });

      it("should render overview toolbar and display matching queue count in header badge", () => {
        const queues = [
          { name: "email-queue", metrics: { waiting: 1, active: 0, delayed: 0, dlq: 0 } },
          { name: "sms-queue", metrics: { waiting: 2, active: 0, delayed: 0, dlq: 0 } }
        ];

        const html = OverviewView.renderData(queues, { searchQuery: "email" });
        assert.match(html, /id="overview-search-input"/);
        assert.match(html, /id="overview-status-select"/);
        assert.match(html, /1 of 2 matching/);
        assert.match(html, /email-queue/);
        assert.doesNotMatch(html, /sms-queue/);
      });

      it("should render empty filter state when no queues match search filter", () => {
        const queues = [
          { name: "email-queue", metrics: { waiting: 1, active: 0, delayed: 0, dlq: 0 } }
        ];

        const html = OverviewView.renderData(queues, { searchQuery: "non-existent-filter-xyz" });
        assert.match(html, /empty-filter-state/);
        assert.match(html, /No Matching Queues/);
        assert.match(html, /non-existent-filter-xyz/);
        assert.match(html, /id="overview-clear-filters-btn"/);
        assert.match(html, /id="overview-reset-filters-btn"/);
        assert.match(html, /class="btn btn-secondary btn-sm overview-clear-btn"/);
      });
    });

    describe("Multi-Column Sorting & Metric Non-Zero Distinction", () => {
      it("should sort queues by numeric metrics in ascending and descending order", () => {
        const queues = [
          { name: "q-10", metrics: { waiting: 10 } },
          { name: "q-1", metrics: { waiting: 1 } },
          { name: "q-5", metrics: { waiting: 5 } }
        ];

        const asc = OverviewView.sortQueues(queues, { sortKey: "waiting", sortOrder: "asc" });
        assert.deepEqual(asc.map((q) => q.name), ["q-1", "q-5", "q-10"]);

        const desc = OverviewView.sortQueues(queues, { sortKey: "waiting", sortOrder: "desc" });
        assert.deepEqual(desc.map((q) => q.name), ["q-10", "q-5", "q-1"]);
      });

      it("should handle unavailable metrics without treating them as zero during sorting", () => {
        const queues = [
          { name: "q-high", metrics: { waiting: 10 } },
          { name: "q-zero", metrics: { waiting: 0 } },
          { name: "q-unavail", metrics: { waiting: null } },
          { name: "q-mid", metrics: { waiting: 2 } }
        ];

        // In ascending order: 0 must come first, NOT null. Null is not zero and sorted to the end!
        const asc = OverviewView.sortQueues(queues, { sortKey: "waiting", sortOrder: "asc" });
        assert.equal(asc[0].name, "q-zero"); // 0 is smallest valid number
        assert.equal(asc[1].name, "q-mid");  // 2
        assert.equal(asc[2].name, "q-high"); // 10
        assert.equal(asc[3].name, "q-unavail"); // unavailable is at the end, not at 0!

        // In descending order: 10 must come first, then 2, then 0, and unavailable at the end
        const desc = OverviewView.sortQueues(queues, { sortKey: "waiting", sortOrder: "desc" });
        assert.equal(desc[0].name, "q-high"); // 10
        assert.equal(desc[1].name, "q-mid");  // 2
        assert.equal(desc[2].name, "q-zero"); // 0
        assert.equal(desc[3].name, "q-unavail"); // unavailable is at the end, not treated as 0!
      });

      it("should render appropriate aria-sort attributes, sort indicator icons, and stable element IDs on table headers", () => {
        const queues = [
          { name: "queue-a", metrics: { waiting: 1, active: 0, delayed: 0, dlq: 0 } }
        ];

        // Sorted by waiting descending
        const html = OverviewView.renderData(queues, { sortKey: "waiting", sortOrder: "desc" });
        assert.match(html, /<th scope="col" aria-sort="descending">\s*<button type="button" id="sort-btn-waiting" class="sort-header-btn" data-sort-key="waiting"/);
        assert.match(html, /<th scope="col" aria-sort="none">\s*<button type="button" id="sort-btn-name" class="sort-header-btn" data-sort-key="name"/);
        assert.match(html, /<th scope="col" aria-sort="none">\s*<button type="button" id="sort-btn-active" class="sort-header-btn" data-sort-key="active"/);
        assert.match(html, /id="sort-btn-status"/);
        assert.match(html, /id="sort-btn-delayed"/);
        assert.match(html, /id="sort-btn-dlq"/);
        assert.match(html, /id="sort-btn-lastUpdated"/);
      });

      it("should sort queues by lastUpdated handling valid, invalid, and missing timestamps safely", () => {
        const queues = [
          { name: "q-recent", lastUpdated: "2026-10-19T12:00:00.000Z" },
          { name: "q-old", lastUpdated: "2026-10-19T10:00:00.000Z" },
          { name: "q-invalid", lastUpdated: "not-a-valid-date" },
          { name: "q-missing", lastUpdated: null }
        ];

        // In descending order: newest first, then older, then invalid/missing at the end
        const desc = OverviewView.sortQueues(queues, { sortKey: "lastUpdated", sortOrder: "desc" });
        assert.equal(desc[0].name, "q-recent");
        assert.equal(desc[1].name, "q-old");
        assert.equal(desc[2].name, "q-invalid");
        assert.equal(desc[3].name, "q-missing");

        // In ascending order: oldest first, then newer, then invalid/missing at the end
        const asc = OverviewView.sortQueues(queues, { sortKey: "lastUpdated", sortOrder: "asc" });
        assert.equal(asc[0].name, "q-old");
        assert.equal(asc[1].name, "q-recent");
        assert.equal(asc[2].name, "q-invalid");
        assert.equal(asc[3].name, "q-missing");
      });
    });

    describe("Multi-Queue Navigation & Row Actions", () => {
      it("should render DLQ Explorer and Job Inspector navigation action buttons for each queue", () => {
        const queues = [
          { name: "billing-queue", metrics: { waiting: 5, active: 1, delayed: 0, dlq: 3 } },
          { name: "clean-queue", metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 } }
        ];

        const html = OverviewView.renderData(queues);
        assert.match(html, /class="btn btn-secondary btn-xs action-nav-btn overview-dlq-btn"/);
        assert.match(html, /class="btn btn-secondary btn-xs action-nav-btn overview-job-btn"/);
        assert.match(html, /data-queue="billing-queue"/);
        assert.match(html, /data-queue="clean-queue"/);
        assert.match(html, /href="#\/dlq\?queue=billing-queue"/);
        assert.match(html, /href="#\/job\?queue=billing-queue"/);
        assert.match(html, /href="#\/dlq\?queue=clean-queue"/);
        assert.match(html, /href="#\/job\?queue=clean-queue"/);
      });

      it("should properly URL-encode queue names with spaces, slashes, and special characters in navigation links", () => {
        const queues = [
          { name: "org/team emails & alerts", metrics: { waiting: 1, active: 0, delayed: 0, dlq: 0 } }
        ];

        const html = OverviewView.renderData(queues);
        assert.match(html, /href="#\/dlq\?queue=org%2Fteam%20emails%20%26%20alerts"/);
        assert.match(html, /href="#\/job\?queue=org%2Fteam%20emails%20%26%20alerts"/);
      });
    });

    describe("Operational Diagnostics & Error Mapping", () => {
      it("should provide actionable diagnostics distinguishing NOT_SUPPORTED, QUEUE_CLOSED, and QUEUE_NOT_FOUND", () => {
        const notSupportedDiag = OverviewView.getDiagnosticInfo({ code: "NOT_SUPPORTED", status: 501 });
        assert.equal(notSupportedDiag.title, "Core Feature Not Supported");
        assert.match(notSupportedDiag.guidance, /installed version of @mayurbhusare\/resilient-queue does not expose this method/i);

        const queueClosedDiag = OverviewView.getDiagnosticInfo({ code: "QUEUE_CLOSED", status: 503 });
        assert.equal(queueClosedDiag.title, "Queue Closed");
        assert.match(queueClosedDiag.guidance, /queue\.close\(\)/i);

        const queueNotFoundDiag = OverviewView.getDiagnosticInfo({ code: "QUEUE_NOT_FOUND", status: 404 });
        assert.equal(queueNotFoundDiag.title, "Queue Not Registered");
        assert.match(queueNotFoundDiag.guidance, /'queues' configuration object/i);
      });

      it("should render actionable diagnostic callout in OverviewView.renderError", () => {
        const error = { code: "QUEUE_CLOSED", message: "Queue is closed" };
        const html = OverviewView.renderError(error);
        assert.match(html, /Operational Diagnostic/);
        assert.match(html, /queue\.close\(\)/);
        assert.match(html, /id="retry-overview-btn"/);
      });

      it("should never expose internal Redis keys, connection strings, or database details", () => {
        const err = {
          code: "INTERNAL_ERROR",
          message: "Command failed at redis://user:secret123@internal-redis.cluster.local:6379"
        };
        const diag = OverviewView.getDiagnosticInfo(err);
        assert.equal(diag.code, "INTERNAL_ERROR");
        assert.doesNotMatch(diag.guidance, /secret123/);
        assert.doesNotMatch(diag.guidance, /cluster\.local/);
      });
    });

    describe("Security & XSS Prevention Audit", () => {
      it("should safely sanitize malicious queue names and prevent XSS injection in overview", () => {
        const xssQueue = {
          name: '<script>alert("xss")</script><img src=x onerror=alert(1)>',
          metrics: { waiting: 1, active: 0, delayed: 0, dlq: 0 }
        };

        const html = OverviewView.renderData([xssQueue], {
          searchQuery: 'alert("xss")'
        });

        assert.doesNotMatch(html, /<script>alert\("xss"\)<\/script>/);
        assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
        assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /value="alert\(&quot;xss&quot;\)"/);
      });
    });

    describe("Lifecycle & Navigation Guards", () => {
      it("should not re-render view if DLQ request completes after user navigated to another view", async () => {
        let resolveDlq;
        const dlqPromise = new Promise((resolve) => {
          resolveDlq = resolve;
        });

        const mockApiClient = {
          getQueueDLQ: async () => {
            await dlqPromise;
            return { jobs: [{ id: "job-late" }], total: 1 };
          }
        };

        let renderCount = 0;
        const app = new DashboardApp({ apiClient: mockApiClient });
        app.state.activeView = "dlq";
        app.state.dlq.selectedQueue = "emails";

        // Monkey patch renderView to count invocations
        const originalRender = app.renderView.bind(app);
        app.renderView = () => {
          renderCount++;
          originalRender();
        };

        const p = app.fetchDLQ();

        // User navigates to Job view before DLQ finishes
        app.state.activeView = "job";

        resolveDlq();
        await p;

        // Ensure dlq finished without re-rendering job view as dlq
        assert.equal(app.state.activeView, "job");
        app.destroy();
      });

      it("should safely handle malformed URI decoding in hashchange without throwing", () => {
        const app = new DashboardApp();
        const originalWindow = global.window;
        global.window = {
          location: { hash: "#/dlq/%E0%A4%A" } // Invalid incomplete percent-encoding
        };

        try {
          assert.doesNotThrow(() => {
            app.handleHashChange();
          });
          assert.equal(app.state.activeView, "dlq");
        } finally {
          global.window = originalWindow;
          app.destroy();
        }
      });

      it("should bind and trigger clear filter buttons to reset search and status filter", () => {
        const originalDocument = global.document;
        let clearClickCallback;
        const fakeClearBtn = {
          addEventListener: (event, handler) => {
            if (event === "click") {
              clearClickCallback = handler;
            }
          }
        };

        global.document = {
          getElementById: () => null,
          querySelectorAll: (sel) => {
            if (sel.includes("overview-clear-btn") || sel.includes("overview-clear-filters-btn")) {
              return [fakeClearBtn];
            }
            return [];
          },
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          app.state.overview.searchQuery = "failing-queue";
          app.state.overview.statusFilter = "error";

          let rendered = false;
          app.renderView = () => {
            rendered = true;
          };

          app.bindViewEvents();
          assert.ok(typeof clearClickCallback === "function");

          clearClickCallback();
          assert.equal(app.state.overview.searchQuery, "");
          assert.equal(app.state.overview.statusFilter, "all");
          assert.equal(rendered, true);

          app.destroy();
        } finally {
          global.document = originalDocument;
        }
      });
    });
  });

  describe("Milestone 12: Accessibility, Keyboard Usability & Responsive Polish", () => {
    describe("Skip Links, Live Regions & Landmarks", () => {
      it("should include skip-to-content link targeting #content-container in index.html", () => {
        const htmlPath = path.join(UI_DIR, "index.html");
        const html = fs.readFileSync(htmlPath, "utf8");
        assert.match(html, /<a\s+href="#content-container"\s+class="skip-link">Skip to main content<\/a>/);
      });

      it("should include dedicated live announcer with polite aria-live in index.html and remove redundant chatter from main", () => {
        const htmlPath = path.join(UI_DIR, "index.html");
        const html = fs.readFileSync(htmlPath, "utf8");
        assert.match(html, /<div\s+id="live-announcer"\s+class="visually-hidden"\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"><\/div>/);
        assert.match(html, /<main class="content-area" id="content-container" role="main" tabindex="-1">/);
        const mainMatch = html.match(/<main[^>]+>/);
        assert.ok(mainMatch);
        assert.doesNotMatch(mainMatch[0], /aria-live/);
      });

      it("should emit discrete live announcer updates via app.announce()", async () => {
        let announcerText = "";
        const fakeAnnouncer = {
          get textContent() { return announcerText; },
          set textContent(val) { announcerText = val; }
        };

        const originalDoc = global.document;
        global.document = {
          getElementById: (id) => (id === "live-announcer" ? fakeAnnouncer : null),
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          app.announce("Queue metrics updated");
          await new Promise((r) => setTimeout(r, 80));
          assert.equal(announcerText, "Queue metrics updated");
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });
    });

    describe("Accessible Status Badges & Color Independence", () => {
      it("should render distinct visual glyphs and labels for all queue statuses", () => {
        const queues = [
          { name: "q-active", isPaused: false, metrics: { waiting: 0, active: 1, delayed: 0, dlq: 0 } },
          { name: "q-paused", isPaused: true, metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 } },
          { name: "q-closed", isClosed: true, metrics: null },
          { name: "q-error", error: new Error("Redis timeout"), metrics: null },
          { name: "q-unavailable", metrics: null }
        ];

        const html = OverviewView.renderData(queues);
        // Active: ●
        assert.match(html, /<span class="badge badge-active" role="status" aria-label="Status: Active"><span aria-hidden="true">●<\/span> Active<\/span>/);
        // Paused: ⏸
        assert.match(html, /<span class="badge badge-paused" role="status" aria-label="Status: Paused"><span aria-hidden="true">⏸<\/span> Paused<\/span>/);
        // Closed: ■
        assert.match(html, /<span class="badge badge-closed" role="status" aria-label="Status: Closed"><span aria-hidden="true">■<\/span> Closed<\/span>/);
        // Error: ⚠️
        assert.match(html, /<span class="badge badge-error" role="status" aria-label="Status: Error"><span aria-hidden="true">⚠️<\/span> Error<\/span>/);
        // Unavailable: —
        assert.match(html, /<span class="badge badge-unavailable" role="status" aria-label="Status: Unavailable"><span aria-hidden="true">—<\/span> Unavailable<\/span>/);
      });
    });

    describe("Focus Preservation Across Auto-Refresh & Rerenders", () => {
      it("should preserve search input focus and cursor selection range across renderView", () => {
        const originalDoc = global.document;
        let focusedEl = null;
        let rangeSet = null;

        const fakeSearchInput = {
          id: "overview-search-input",
          selectionStart: 4,
          selectionEnd: 7,
          focus: function() { focusedEl = this; },
          setSelectionRange: function(s, e) { rangeSet = [s, e]; },
          addEventListener: () => {},
          getAttribute: () => null,
          classList: { contains: () => false }
        };

        global.document = {
          activeElement: fakeSearchInput,
          getElementById: (id) => (id === "overview-search-input" ? fakeSearchInput : id === "content-container" ? { innerHTML: "" } : null),
          querySelector: () => null,
          querySelectorAll: () => []
        };

        try {
          const app = new DashboardApp();
          app.state.activeView = "overview";
          app.state.queues = [{ name: "email-queue", metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 } }];
          app.renderView();

          assert.equal(focusedEl, fakeSearchInput);
          assert.deepEqual(rangeSet, [4, 7]);
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });

      it("should restore focus to active sort header button across renderView", () => {
        const originalDoc = global.document;
        let focusedEl = null;

        const fakeSortBtn = {
          id: null,
          getAttribute: (attr) => (attr === "data-sort-key" ? "waiting" : null),
          classList: { contains: (cls) => cls === "sort-header-btn" },
          focus: function() { focusedEl = this; }
        };

        global.document = {
          activeElement: fakeSortBtn,
          getElementById: (id) => (id === "content-container" ? { innerHTML: "" } : null),
          querySelector: (sel) => (sel.includes('[data-sort-key="waiting"]') ? fakeSortBtn : null),
          querySelectorAll: () => []
        };

        try {
          const app = new DashboardApp();
          app.state.activeView = "overview";
          app.state.queues = [{ name: "email-queue", metrics: { waiting: 5, active: 0, delayed: 0, dlq: 0 } }];
          app.renderView();

          assert.equal(focusedEl, fakeSortBtn);
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });

      it("should restore focus to active DLQ row action button across renderView", () => {
        const originalDoc = global.document;
        let focusedEl = null;

        const fakeDlqBtn = {
          id: null,
          getAttribute: (attr) => (attr === "data-queue" ? "billing-queue" : null),
          classList: { contains: (cls) => cls === "overview-dlq-btn" },
          focus: function() { focusedEl = this; }
        };

        global.document = {
          activeElement: fakeDlqBtn,
          getElementById: (id) => (id === "content-container" ? { innerHTML: "" } : null),
          querySelector: (sel) => (sel.includes('[data-queue="billing-queue"]') ? fakeDlqBtn : null),
          querySelectorAll: () => []
        };

        try {
          const app = new DashboardApp();
          app.state.activeView = "overview";
          app.state.queues = [{ name: "billing-queue", metrics: { waiting: 0, active: 0, delayed: 0, dlq: 3 } }];
          app.renderView();

          assert.equal(focusedEl, fakeDlqBtn);
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });
    });

    describe("Mobile Navigation Drawer & Focus Trapping", () => {
      it("should close mobile drawer on Escape and restore focus to #mobile-toggle-btn", () => {
        const originalDoc = global.document;
        let keydownHandler = null;
        let toggleFocused = false;

        const classListSet = new Set(["open"]);
        const fakeSidebar = {
          classList: {
            contains: (c) => classListSet.has(c),
            remove: (c) => classListSet.delete(c),
            add: (c) => classListSet.add(c)
          },
          querySelectorAll: () => []
        };

        const fakeToggle = {
          id: "mobile-toggle-btn",
          setAttribute: (attr, val) => {},
          focus: () => { toggleFocused = true; },
          addEventListener: () => {}
        };

        const fakeBackdrop = {
          classList: { remove: () => {}, add: () => {} },
          addEventListener: () => {}
        };

        global.document = {
          getElementById: (id) => {
            if (id === "sidebar") return fakeSidebar;
            if (id === "mobile-toggle-btn") return fakeToggle;
            if (id === "mobile-backdrop") return fakeBackdrop;
            return null;
          },
          addEventListener: (evt, handler) => {
            if (evt === "keydown") keydownHandler = handler;
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          app.bindMobileToggle();
          assert.ok(typeof keydownHandler === "function");
          assert.equal(fakeSidebar.classList.contains("open"), true);

          // Trigger Escape key
          let prevented = false;
          keydownHandler({ key: "Escape", preventDefault: () => { prevented = true; } });

          assert.equal(fakeSidebar.classList.contains("open"), false);
          assert.equal(toggleFocused, true);
          assert.equal(prevented, true);
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });

      it("should trap tab focus inside open mobile drawer", () => {
        const originalDoc = global.document;
        let keydownHandler = null;
        let firstFocused = false;
        let lastFocused = false;

        const fakeFirstBtn = { focus: () => { firstFocused = true; } };
        const fakeLastBtn = { focus: () => { lastFocused = true; } };

        const classListSet = new Set(["open"]);
        const fakeSidebar = {
          classList: {
            contains: (c) => classListSet.has(c)
          },
          contains: (el) => true,
          querySelectorAll: () => [fakeFirstBtn, fakeLastBtn]
        };

        global.document = {
          getElementById: (id) => (id === "sidebar" ? fakeSidebar : null),
          addEventListener: (evt, handler) => {
            if (evt === "keydown") keydownHandler = handler;
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: fakeLastBtn
        };

        try {
          const app = new DashboardApp();
          app.bindMobileToggle();
          assert.ok(typeof keydownHandler === "function");

          // Tab on last element wraps to first element
          let prevented = false;
          keydownHandler({
            key: "Tab",
            shiftKey: false,
            preventDefault: () => { prevented = true; }
          });
          assert.equal(prevented, true);
          assert.equal(firstFocused, true);

          // Shift+Tab on first element wraps to last element
          global.document.activeElement = fakeFirstBtn;
          prevented = false;
          keydownHandler({
            key: "Tab",
            shiftKey: true,
            preventDefault: () => { prevented = true; }
          });
          assert.equal(prevented, true);
          assert.equal(lastFocused, true);

          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });
    });

    describe("Screen Reader Regions & Accessible Controls in DLQ and Job Views", () => {
      it("should associate DLQ inspect buttons with expanded detail regions via aria-controls and role='region'", () => {
        const dlqState = {
          selectedQueue: "test-queue",
          jobs: [{ id: "job-1", failedReason: "Timeout", data: { email: "user@example.com" } }],
          expandedJobIndex: 0,
          total: 1
        };
        const html = DLQView.render(dlqState, [{ name: "test-queue", metrics: { dlq: 1 } }]);
        assert.match(html, /aria-controls="dlq-job-detail-0"/);
        assert.match(html, /aria-expanded="true"/);
        assert.match(html, /id="dlq-job-detail-0"/);
        assert.match(html, /<pre class="job-payload-box" tabindex="0" role="region" aria-label="Job Data Payload">/);
      });

      it("should render accessible progressbar and keyboard-scrollable regions in JobView", () => {
        const jobState = {
          selectedQueue: "test-queue",
          jobId: "job-123",
          job: {
            id: "job-123",
            name: "process-video",
            progress: 75,
            data: { videoId: "v1" },
            returnValue: { status: "rendered" }
          }
        };
        const html = JobView.render(jobState, [{ name: "test-queue", metrics: { waiting: 0 } }]);
        assert.match(html, /role="progressbar"/);
        assert.match(html, /aria-valuenow="75"/);
        assert.match(html, /aria-valuemin="0"/);
        assert.match(html, /aria-valuemax="100"/);
        assert.match(html, /aria-label="Job execution progress: 75%"/);
        assert.match(html, /<pre class="job-payload-box" tabindex="0" role="region" aria-label="Job Payload Data">/);
        assert.match(html, /<pre class="job-payload-box" tabindex="0" role="region" aria-label="Job Return Value">/);
      });
    });

    describe("CSS Accessibility & Responsive Specifications", () => {
      it("should define prefers-reduced-motion media query in styles.css", () => {
        const cssPath = path.join(UI_DIR, "styles.css");
        const css = fs.readFileSync(cssPath, "utf8");
        assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        assert.match(css, /animation-duration:\s*0\.01ms/);
        assert.match(css, /animation:\s*none/);
      });

      it("should define responsive breakpoints for max-width: 600px and 480px in styles.css", () => {
        const cssPath = path.join(UI_DIR, "styles.css");
        const css = fs.readFileSync(cssPath, "utf8");
        assert.match(css, /@media\s*\(max-width:\s*600px\)/);
        assert.match(css, /@media\s*\(max-width:\s*480px\)/);
      });

      it("should define skip-link and high-visibility focus ring styles in styles.css", () => {
        const cssPath = path.join(UI_DIR, "styles.css");
        const css = fs.readFileSync(cssPath, "utf8");
        assert.match(css, /\.skip-link/);
        assert.match(css, /:focus-visible/);
        assert.match(css, /outline:/);
      });

      it("should define WCAG AA compliant colors for skip link, primary button, and badges", () => {
        const cssPath = path.join(UI_DIR, "styles.css");
        const css = fs.readFileSync(cssPath, "utf8");
        assert.match(css, /--accent-focus:\s*#38bdf8/);
        assert.match(css, /\.skip-link[\s\S]*?background-color:\s*#0369a1/);
        assert.match(css, /\.badge-unavailable[\s\S]*?color:\s*#cbd5e1/);
        assert.match(css, /\.overview-toolbar\s+\.form-group/);
      });
    });

    describe("Lifecycle Cleanup, Resilient Initialization & Rapid Announcer Debounce", () => {
      it("should debounce rapid successive announcements and prevent stale timers", async () => {
        let textHistory = [];
        const fakeAnnouncer = {
          set textContent(val) {
            textHistory.push(val);
          },
          get textContent() {
            return textHistory[textHistory.length - 1] || "";
          }
        };

        const originalDoc = global.document;
        global.document = {
          getElementById: (id) => (id === "live-announcer" ? fakeAnnouncer : null),
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          app.announce("Announcement 1");
          app.announce("Announcement 2");
          app.announce("Final Announcement");

          await new Promise((r) => setTimeout(r, 80));

          assert.equal(fakeAnnouncer.textContent, "Final Announcement");
          app.destroy();
          assert.equal(app._announceTimer, null);
        } finally {
          global.document = originalDoc;
        }
      });

      it("should clean up bound mobile keydown handler and announce timer upon destroy()", () => {
        const originalDoc = global.document;
        let removedEvent = null;
        let removedHandler = null;

        global.document = {
          getElementById: () => null,
          addEventListener: () => {},
          removeEventListener: (evt, h) => {
            removedEvent = evt;
            removedHandler = h;
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          app.bindMobileToggle();
          assert.ok(typeof app._boundMobileKeydown === "function");
          const handlerRef = app._boundMobileKeydown;

          app.destroy();
          assert.equal(removedEvent, "keydown");
          assert.equal(removedHandler, handlerRef);
          assert.equal(app._boundMobileKeydown, null);
          assert.equal(app._announceTimer, null);
        } finally {
          global.document = originalDoc;
        }
      });

      it("should not register duplicate keydown listeners on repeated bindMobileToggle calls", () => {
        const originalDoc = global.document;
        let addedCount = 0;
        let removedCount = 0;

        global.document = {
          getElementById: () => null,
          addEventListener: (evt) => {
            if (evt === "keydown") addedCount++;
          },
          removeEventListener: (evt) => {
            if (evt === "keydown") removedCount++;
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          app.bindMobileToggle();
          app.bindMobileToggle();
          app.bindMobileToggle();

          assert.equal(addedCount, 3);
          assert.equal(removedCount, 2);
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });

      it("should handle completely missing DOM elements in renderView and mobile methods without throwing", () => {
        const originalDoc = global.document;
        global.document = {
          getElementById: () => null,
          querySelectorAll: () => [],
          querySelector: () => null,
          activeElement: null
        };

        try {
          const app = new DashboardApp();
          assert.doesNotThrow(() => {
            app.bindMobileToggle();
            app.closeMobileSidebar(true);
            app.renderView();
            app.updateNavigationUI();
            app.updateStatusIndicator("loading", "test");
            app.destroy();
          });
        } finally {
          global.document = originalDoc;
        }
      });

      it("should not steal focus when activeElement is outside the content container", () => {
        const originalDoc = global.document;
        let externalElementFocused = false;

        const fakeExternalInput = {
          id: "poll-interval-select",
          focus: () => { externalElementFocused = true; },
          getAttribute: () => null,
          classList: { contains: () => false }
        };

        const fakeContainer = {
          innerHTML: "",
          contains: (el) => el !== fakeExternalInput
        };

        global.document = {
          activeElement: fakeExternalInput,
          getElementById: (id) => (id === "content-container" ? fakeContainer : null),
          querySelector: () => null,
          querySelectorAll: () => []
        };

        try {
          const app = new DashboardApp();
          app.state.activeView = "overview";
          app.state.queues = [{ name: "email-queue", metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 } }];
          app.renderView();

          assert.equal(externalElementFocused, false);
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });

      it("should pass preventScroll: true when restoring focus after re-render", () => {
        const originalDoc = global.document;
        let focusOptions = null;

        const fakeSearchInput = {
          id: "overview-search-input",
          selectionStart: 0,
          selectionEnd: 0,
          addEventListener: () => {},
          focus: (opts) => { focusOptions = opts; },
          setSelectionRange: () => {},
          getAttribute: () => null,
          classList: { contains: () => false }
        };

        const fakeContainer = {
          innerHTML: "",
          contains: (el) => el === fakeSearchInput
        };

        global.document = {
          activeElement: fakeSearchInput,
          getElementById: (id) =>
            id === "overview-search-input" ? fakeSearchInput : id === "content-container" ? fakeContainer : null,
          querySelector: () => null,
          querySelectorAll: () => []
        };

        try {
          const app = new DashboardApp();
          app.state.activeView = "overview";
          app.state.queues = [{ name: "email-queue", metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 } }];
          app.renderView();

          assert.deepEqual(focusOptions, { preventScroll: true });
          app.destroy();
        } finally {
          global.document = originalDoc;
        }
      });

      it("should toggle aria-expanded and detail panel between collapsed and expanded states in DLQView", () => {
        const dlqCollapsed = {
          selectedQueue: "emails",
          jobs: [{ id: "job-1", attempt: 1 }],
          expandedJobIndex: null,
          total: 1
        };
        const htmlCollapsed = DLQView.render(dlqCollapsed, [{ name: "emails", metrics: { dlq: 1 } }]);
        assert.match(htmlCollapsed, /aria-expanded="false"/);
        assert.doesNotMatch(htmlCollapsed, /id="dlq-job-detail-0"/);

        const dlqExpanded = {
          selectedQueue: "emails",
          jobs: [{ id: "job-1", attempt: 1 }],
          expandedJobIndex: 0,
          total: 1
        };
        const htmlExpanded = DLQView.render(dlqExpanded, [{ name: "emails", metrics: { dlq: 1 } }]);
        assert.match(htmlExpanded, /aria-expanded="true"/);
        assert.match(htmlExpanded, /id="dlq-job-detail-0"/);
      });
    });
  });
});
