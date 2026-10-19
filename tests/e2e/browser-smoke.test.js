"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createExpressAdapter } = require("../../src/adapters/express");
const { HeadlessBrowserSession, isBrowserAvailable } = require("./browser-runner");

describe("Browser Smoke Tests", () => {
  let server;
  let serverUrl;
  let browser;
  let browserAvailable = false;

  const mockQueues = {
    "notifications-queue": {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 18, active: 4, delayed: 2, dlq: 1 }),
      getDLQ: async () => ({
        total: 1,
        jobs: [
          {
            id: "failed-notif-1",
            data: { to: "user@example.com" },
            attempt: 3,
            stalledCount: 0,
            createdAt: Date.now() - 60000,
            failedAt: Date.now() - 10000,
            failureReason: "Gateway Timeout"
          }
        ]
      }),
      getJob: async (jobId) => {
        if (jobId === "notif-job-1") {
          return {
            id: "notif-job-1",
            state: "completed",
            progress: 100,
            attempt: 1,
            stalledCount: 0,
            createdAt: Date.now() - 120000,
            startedAt: Date.now() - 60000,
            completedAt: Date.now() - 1000,
            data: { to: "user@example.com", template: "welcome" },
            returnValue: { sent: true }
          };
        }
        return null;
      }
    },
    "billing-queue": {
      isClosed: false,
      isPaused: async () => true,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] }),
      getJob: async () => null
    }
  };

  before(async (t) => {
    browserAvailable = isBrowserAvailable();
    if (!browserAvailable) {
      if (process.env.CI && !process.env.ALLOW_SKIP_BROWSER_TESTS) {
        throw new Error(
          "Browser tests required in CI environment, but no Chromium or Chrome binary was found. " +
            "Ensure google-chrome or chromium is installed or configure CHROME_BIN."
        );
      }
      if (typeof t?.skip === "function") {
        t.skip("No Chromium or Chrome browser executable found; skipping browser smoke tests");
      }
      return;
    }

    const adapter = createExpressAdapter({
      queues: mockQueues,
      pollingInterval: 5000
    });

    server = http.createServer((req, res) => {
      adapter(req, res, () => {
        res.statusCode = 404;
        res.end("Not Found");
      });
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}/ui/`;
        resolve();
      });
    });

    browser = new HeadlessBrowserSession();
    await browser.launch();
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should load dashboard without uncaught JavaScript errors or console errors", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table tbody tr", 5000);

    const title = await browser.evaluate(() => document.title);
    assert.equal(title, "ResilientQueue Dashboard");

    // Verify zero uncaught page errors and zero console errors
    assert.equal(browser.pageErrors.length, 0, `Page errors encountered: ${browser.pageErrors.join("; ")}`);
    assert.equal(browser.consoleErrors.length, 0, `Console errors encountered: ${browser.consoleErrors.join("; ")}`);
  });

  it("should render overview telemetry metrics and queue rows", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".metrics-grid", 5000);

    const metricsText = await browser.evaluate(() => {
      const cards = document.querySelectorAll(".metric-card");
      return Array.from(cards).map((c) => ({
        label: c.querySelector(".metric-label")?.textContent?.trim(),
        value: c.querySelector(".metric-value")?.textContent?.trim()
      }));
    });

    // 2 queues: notifications (w:18, a:4, d:2, dlq:1) + billing (w:0, a:0, d:0, dlq:0)
    const queuesCard = metricsText.find((m) => m.label === "Queues");
    const waitingCard = metricsText.find((m) => m.label === "Waiting");
    const activeCard = metricsText.find((m) => m.label === "Active");
    const delayedCard = metricsText.find((m) => m.label === "Delayed");
    const dlqCard = metricsText.find((m) => m.label === "Dead-Letter");

    assert.equal(queuesCard?.value, "2");
    assert.equal(waitingCard?.value, "18");
    assert.equal(activeCard?.value, "4");
    assert.equal(delayedCard?.value, "2");
    assert.equal(dlqCard?.value, "1");

    // Check rows in table
    const rows = await browser.evaluate(() => {
      const trs = document.querySelectorAll(".data-table tbody tr");
      return Array.from(trs).map((tr) => ({
        name: tr.querySelector(".queue-name-cell")?.textContent?.trim(),
        waiting: tr.children[2]?.textContent?.trim(),
        active: tr.children[3]?.textContent?.trim(),
        delayed: tr.children[4]?.textContent?.trim(),
        dlq: tr.children[5]?.textContent?.trim()
      }));
    });

    assert.equal(rows.length, 2);
    const notifRow = rows.find((r) => r.name === "notifications-queue");
    assert.ok(notifRow);
    assert.equal(notifRow.waiting, "18");
    assert.equal(notifRow.active, "4");
    assert.equal(notifRow.delayed, "2");
    assert.equal(notifRow.dlq, "1");
  });

  it("should render empty state when no queues are registered", async (t) => {
    if (!browserAvailable) return t.skip();

    // Create an empty adapter on ephemeral server
    const emptyAdapter = createExpressAdapter({ queues: {} });
    const emptyServer = http.createServer((req, res) => {
      emptyAdapter(req, res, () => {
        res.statusCode = 404;
        res.end("Not Found");
      });
    });

    await new Promise((resolve) => emptyServer.listen(0, "127.0.0.1", resolve));
    const emptyUrl = `http://127.0.0.1:${emptyServer.address().port}/ui/`;

    try {
      await browser.navigate(emptyUrl);
      await browser.waitForSelector(".empty-state", 5000);

      const emptyText = await browser.evaluate(() => {
        return document.querySelector(".empty-state")?.textContent || "";
      });

      assert.match(emptyText, /No Queues Registered/);
      assert.match(emptyText, /createExpressAdapter/);
    } finally {
      await new Promise((resolve) => emptyServer.close(resolve));
    }
  });

  it("should render error state with retry button when API returns error", async (t) => {
    if (!browserAvailable) return t.skip();

    let failRequest = true;
    const errorAdapter = createExpressAdapter({
      queues: {
        "flake-queue": {
          isClosed: false,
          isPaused: async () => false,
          getMetrics: async () => {
            if (failRequest) {
              const err = new Error("Database connection dropped");
              throw err;
            }
            return { waiting: 0, active: 0, delayed: 0, dlq: 0 };
          }
        }
      }
    });

    const errorServer = http.createServer((req, res) => {
      errorAdapter(req, res, () => {
        res.statusCode = 404;
        res.end("Not Found");
      });
    });

    await new Promise((resolve) => errorServer.listen(0, "127.0.0.1", resolve));
    const errorUrl = `http://127.0.0.1:${errorServer.address().port}/ui/`;

    try {
      await browser.navigate(errorUrl);
      await browser.waitForSelector("#retry-overview-btn", 5000);

      const errorText = await browser.evaluate(() => {
        return document.querySelector(".error-state")?.textContent || "";
      });
      assert.match(errorText, /Internal Server Error|Database connection dropped/);
      assert.match(errorText, /Retry/);

      // Now unbreak server and click retry
      failRequest = false;
      await browser.click("#retry-overview-btn");
      await browser.waitForSelector(".data-table tbody tr", 5000);

      const rowText = await browser.evaluate(() => {
        return document.querySelector(".data-table tbody tr .queue-name-cell")?.textContent?.trim();
      });
      assert.equal(rowText, "flake-queue");
    } finally {
      await new Promise((resolve) => errorServer.close(resolve));
    }
  });

  it("should navigate between Overview, DLQ Explorer, and Job Inspector via navigation links", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector('.nav-link[data-view="dlq"]', 5000);

    // 1. Click Dead Letter Queue nav link
    await browser.click('.nav-link[data-view="dlq"]');
    await browser.waitForSelector("#dlq-queue-select", 5000);

    let currentHash = await browser.evaluate(() => window.location.hash);
    let viewTitle = await browser.evaluate(() => document.getElementById("view-title")?.textContent?.trim());
    assert.match(currentHash, /^#\/dlq/);
    assert.equal(viewTitle, "Dead Letter Queue (DLQ)");

    // 2. Click Job Inspection nav link
    await browser.click('.nav-link[data-view="job"]');
    await browser.waitForSelector("#job-id-input", 5000);

    currentHash = await browser.evaluate(() => window.location.hash);
    viewTitle = await browser.evaluate(() => document.getElementById("view-title")?.textContent?.trim());
    assert.match(currentHash, /^#\/job/);
    assert.equal(viewTitle, "Job Inspection");

    // 3. Click Queue Overview nav link
    await browser.click('.nav-link[data-view="overview"]');
    await browser.waitForSelector(".data-table", 5000);

    currentHash = await browser.evaluate(() => window.location.hash);
    viewTitle = await browser.evaluate(() => document.getElementById("view-title")?.textContent?.trim());
    assert.equal(currentHash, "#/overview");
    assert.equal(viewTitle, "Queue Overview");
  });

  it("should directly navigate to supported hash routes", async (t) => {
    if (!browserAvailable) return t.skip();

    // 1. Direct navigation to #/dlq
    await browser.navigate(`${serverUrl}#/dlq`);
    await browser.waitForSelector("#dlq-queue-select", 5000);
    let viewTitle = await browser.evaluate(() => document.getElementById("view-title")?.textContent?.trim());
    assert.equal(viewTitle, "Dead Letter Queue (DLQ)");

    // 2. Direct navigation to #/dlq?queue=notifications-queue
    await browser.navigate(`${serverUrl}#/dlq?queue=notifications-queue`);
    await browser.waitForSelector(".data-table tbody tr", 5000);
    const selectedQueue = await browser.evaluate(() => document.getElementById("dlq-queue-select")?.value);
    assert.equal(selectedQueue, "notifications-queue");

    // 3. Direct navigation to #/job
    await browser.navigate(`${serverUrl}#/job`);
    await browser.waitForSelector("#job-id-input", 5000);
    viewTitle = await browser.evaluate(() => document.getElementById("view-title")?.textContent?.trim());
    assert.equal(viewTitle, "Job Inspection");

    // 4. Direct navigation to #/job?queue=notifications-queue&jobId=notif-job-1
    await browser.navigate(`${serverUrl}#/job?queue=notifications-queue&jobId=notif-job-1`);
    await browser.waitForSelector('.table-card[aria-label="Job Inspection Details"]', 5000);
    const jobTitle = await browser.evaluate(() => document.querySelector(".table-title.font-mono")?.textContent?.trim());
    assert.match(jobTitle, /notif-job-1/);

    // 5. Direct navigation to #/overview
    await browser.navigate(`${serverUrl}#/overview`);
    await browser.waitForSelector(".data-table", 5000);
    viewTitle = await browser.evaluate(() => document.getElementById("view-title")?.textContent?.trim());
    assert.equal(viewTitle, "Queue Overview");
  });

  it("should render responsive layouts and support mobile drawer interaction", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table", 5000);

    // Desktop viewport (1280x800)
    await browser.setViewport(1280, 800);
    let isDesktopSidebarVisible = await browser.evaluate(() => {
      const sidebar = document.getElementById("sidebar");
      const style = window.getComputedStyle(sidebar);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    assert.equal(isDesktopSidebarVisible, true);

    // Mobile viewport (375x667)
    await browser.setViewport(375, 667);

    // On mobile, mobile-toggle-btn is visible and sidebar is initially closed
    const isMobileToggleVisible = await browser.evaluate(() => {
      const btn = document.getElementById("mobile-toggle-btn");
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    assert.equal(isMobileToggleVisible, true);

    const isSidebarOpenInitially = await browser.evaluate(() => {
      return document.getElementById("sidebar")?.classList.contains("open");
    });
    assert.equal(isSidebarOpenInitially, false);

    // Click mobile toggle button to open drawer
    await browser.click("#mobile-toggle-btn");
    const isSidebarOpenAfterClick = await browser.evaluate(() => {
      return document.getElementById("sidebar")?.classList.contains("open");
    });
    assert.equal(isSidebarOpenAfterClick, true);

    const isBackdropActive = await browser.evaluate(() => {
      return document.getElementById("mobile-backdrop")?.classList.contains("open");
    });
    assert.equal(isBackdropActive, true);

    // Press Escape to close drawer
    await browser.pressKey("Escape", "Escape");
    const isSidebarClosedAfterEscape = await browser.evaluate(() => {
      return !document.getElementById("sidebar")?.classList.contains("open");
    });
    assert.equal(isSidebarClosedAfterEscape, true);

    // Reset viewport to desktop
    await browser.setViewport(1280, 800);
  });

  it("should control polling lifecycle and stop timer when leaving overview or selecting Off", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table", 5000);

    // Verify polling timer exists in window.__rqDashboardApp
    let hasTimer = await browser.evaluate(() => {
      return window.__rqDashboardApp && window.__rqDashboardApp._pollTimer !== null;
    });
    assert.equal(hasTimer, true);

    // Change auto-refresh interval to 0 (Off)
    await browser.selectOption("#poll-interval-select", "0");
    hasTimer = await browser.evaluate(() => {
      return window.__rqDashboardApp && window.__rqDashboardApp._pollTimer !== null;
    });
    assert.equal(hasTimer, false);

    // Re-enable polling (5000ms)
    await browser.selectOption("#poll-interval-select", "5000");
    hasTimer = await browser.evaluate(() => {
      return window.__rqDashboardApp && window.__rqDashboardApp._pollTimer !== null;
    });
    assert.equal(hasTimer, true);

    // Navigate to DLQ view -> polling must stop
    await browser.click('.nav-link[data-view="dlq"]');
    await browser.waitForSelector("#dlq-queue-select", 5000);

    hasTimer = await browser.evaluate(() => {
      return window.__rqDashboardApp && window.__rqDashboardApp._pollTimer !== null;
    });
    assert.equal(hasTimer, false);

    // Navigate back to overview -> polling timer restarts
    await browser.click('.nav-link[data-view="overview"]');
    await browser.waitForSelector(".data-table", 5000);

    hasTimer = await browser.evaluate(() => {
      return window.__rqDashboardApp && window.__rqDashboardApp._pollTimer !== null;
    });
    assert.equal(hasTimer, true);
  });
});
