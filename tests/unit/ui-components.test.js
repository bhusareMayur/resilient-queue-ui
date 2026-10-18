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
    });

    it("should fall back to empty state when data is empty array", () => {
      const html = OverviewView.renderData([]);
      assert.match(html, /No Queues Registered/);
    });
  });

  describe("Dead Letter Queue (DLQ) View Component", () => {
    it("should render placeholder explanation and highlight queues with DLQ items", () => {
      const queues = [
        {
          name: "orders",
          isPaused: false,
          metrics: { waiting: 5, active: 0, delayed: 0, dlq: 2 }
        },
        {
          name: "emails",
          isPaused: false,
          metrics: { waiting: 0, active: 0, delayed: 0, dlq: 0 }
        }
      ];

      const html = DLQView.render(queues);
      assert.match(html, /Dead-Letter Queue \(DLQ\) Explorer Foundation/);
      assert.match(html, /Milestone 6/);
      assert.match(html, /Queues with Dead-Letter Jobs/);
      assert.match(html, /orders/);
      assert.match(html, />2<\/span>/);
      // "emails" has 0 dlq, so should not be in the queues with dead letter jobs table
      assert.doesNotMatch(html, /emails<\/td>/);
    });

    it("should render clean state when no queues have DLQ jobs", () => {
      const queues = [
        {
          name: "emails",
          isPaused: false,
          metrics: { waiting: 10, active: 1, delayed: 0, dlq: 0 }
        }
      ];

      const html = DLQView.render(queues);
      assert.match(html, /No Dead-Letter Jobs Detected/);
    });
  });

  describe("Job Inspection View Component & Compatibility Disclosure", () => {
    it("should display explicit compatibility notice regarding @mayurbhusare/resilient-queue@2.0.2 lacking getJob()", () => {
      const html = JobView.render();

      assert.match(html, /Core Library Compatibility Notice/);
      assert.match(html, /getJob\(\) Unavailable in v2\.0\.2/);
      assert.match(html, /@mayurbhusare\/resilient-queue@2\.0\.2/);
      assert.match(html, /does not expose the <code>queue\.getJob\(id\)<\/code> public method/);
      assert.match(html, /Unavailable in v2\.0\.2/);
      assert.match(html, /disabled/i);
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
