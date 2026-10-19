"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createExpressAdapter } = require("../../src/adapters/express");
const { HeadlessBrowserSession, isBrowserAvailable } = require("./browser-runner");

describe("Browser End-to-End Workflows", () => {
  let server;
  let serverUrl;
  let browser;
  let browserAvailable = false;

  let dynamicWaitingCount = 25;
  let slowRequestPromiseResolver = null;
  let shouldDelayDLQ = false;
  let failDlqRequest = false;

  const mockJobsDatabase = {
    "ord-job-101": {
      id: "ord-job-101",
      state: "active",
      progress: 64,
      attempt: 2,
      stalledCount: 1,
      createdAt: 1770000000000,
      startedAt: 1770000010000,
      completedAt: null,
      failedAt: null,
      failureReason: null,
      idempotencyKey: "idem-ord-101",
      delay: 0,
      ttlSeconds: 3600,
      removeOnComplete: true,
      removeOnFail: 20,
      data: { orderId: "ord-101", customer: "Alice", items: 3 },
      returnValue: null
    },
    "ord-job-102": {
      id: "ord-job-102",
      state: "completed",
      progress: 100,
      attempt: 1,
      stalledCount: 0,
      createdAt: 1770000000000,
      startedAt: 1770000005000,
      completedAt: 1770000015000,
      data: { orderId: "ord-102", customer: "Bob" },
      returnValue: { receipt: "rcpt-999", authorized: true }
    },
    "dlq-ord-901": {
      id: "dlq-ord-901",
      state: "failed",
      progress: 0,
      attempt: 4,
      stalledCount: 2,
      createdAt: 1770000000000,
      failedAt: 1770000050000,
      failureReason: "InventoryAllocationError: Item out of stock",
      data: { orderId: "ord-901", reason: "Insufficient inventory" }
    }
  };

  const dlqJobsList = [
    {
      id: "dlq-ord-901",
      data: { orderId: "ord-901", reason: "Insufficient inventory" },
      attempt: 4,
      stalledCount: 2,
      createdAt: 1770000000000,
      failedAt: 1770000050000,
      failureReason: "InventoryAllocationError: Item out of stock"
    },
    {
      id: "dlq-ord-902",
      data: { orderId: "ord-902", reason: "Card declined" },
      attempt: 3,
      stalledCount: 0,
      createdAt: 1770000010000,
      failedAt: 1770000060000,
      failureReason: "PaymentError: Insufficient funds"
    },
    {
      id: null,
      corrupted: true,
      raw: "{broken:json:payload...",
      error: "SyntaxError: Unexpected token b"
    }
  ];

  const queues = {
    "orders-queue": {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({
        waiting: dynamicWaitingCount,
        active: 3,
        delayed: 1,
        dlq: 3
      }),
      getDLQ: async ({ start = 0, limit = 50, order = "desc" } = {}) => {
        if (shouldDelayDLQ && slowRequestPromiseResolver) {
          await new Promise((resolve) => {
            slowRequestPromiseResolver = resolve;
          });
        }
        if (failDlqRequest) {
          throw new Error("DLQ storage partition unreachable");
        }
        const sorted = order === "asc" ? [...dlqJobsList].reverse() : [...dlqJobsList];
        const paged = sorted.slice(start, start + limit);
        return { total: dlqJobsList.length, jobs: paged, start, limit, order };
      },
      getJob: async (jobId) => {
        return mockJobsDatabase[jobId] || null;
      }
    },
    "emails-queue": {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 5, active: 1, delayed: 0, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [], start: 0, limit: 50, order: "desc" }),
      getJob: async () => null
    },
    "legacy-queue": {
      // Represents published @mayurbhusare/resilient-queue@2.0.2 where getJob is not implemented
      isClosed: false,
      isPaused: async () => true,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] })
      // No getJob property
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
        t.skip("No Chromium browser available; skipping browser workflows");
      }
      return;
    }

    const adapter = createExpressAdapter({
      queues,
      pollingInterval: 0 // Manual refresh during workflow tests to prevent background race conditions
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

  it("Journey 1: Open dashboard and verify telemetry cards and registered queues", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table tbody tr", 5000);

    // Verify 3 registered queues: orders-queue, emails-queue, legacy-queue
    const renderedQueues = await browser.evaluate(() => {
      const rows = document.querySelectorAll(".data-table tbody tr");
      return Array.from(rows).map((r) => r.querySelector(".queue-name-cell")?.textContent?.trim());
    });

    assert.equal(renderedQueues.length, 3);
    assert.ok(renderedQueues.includes("orders-queue"));
    assert.ok(renderedQueues.includes("emails-queue"));
    assert.ok(renderedQueues.includes("legacy-queue"));

    // Verify aggregate telemetry values
    const metricsMap = await browser.evaluate(() => {
      const cards = document.querySelectorAll(".metric-card");
      const res = {};
      cards.forEach((c) => {
        const label = c.querySelector(".metric-label")?.textContent?.trim();
        const value = c.querySelector(".metric-value")?.textContent?.trim();
        if (label) res[label] = value;
      });
      return res;
    });

    // orders (25, 3, 1, 3) + emails (5, 1, 0, 0) + legacy (0, 0, 0, 0)
    assert.equal(metricsMap["Queues"], "3");
    assert.equal(metricsMap["Waiting"], "30");
    assert.equal(metricsMap["Active"], "4");
    assert.equal(metricsMap["Delayed"], "1");
    assert.equal(metricsMap["Dead-Letter"], "3");
  });

  it("Journey 2: Refresh metrics and verify displayed values update", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table", 5000);

    // Increase waiting count on orders-queue from 25 to 80
    dynamicWaitingCount = 80;

    await browser.click("#refresh-btn");

    // Wait for the new waiting sum (80 + 5 = 85) to appear in metric card
    await browser.waitForFunction(() => {
      const cards = document.querySelectorAll(".metric-card");
      for (const c of cards) {
        if (c.querySelector(".metric-label")?.textContent?.trim() === "Waiting") {
          return c.querySelector(".metric-value")?.textContent?.trim() === "85";
        }
      }
      return false;
    }, 5000);

    const waitingInTable = await browser.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".data-table tbody tr"));
      const orderRow = rows.find((r) => r.querySelector(".queue-name-cell")?.textContent?.trim() === "orders-queue");
      return orderRow?.children[2]?.textContent?.trim();
    });

    assert.equal(waitingInTable, "80");
  });

  it("Journey 3: Search, filter, and sort queues in overview table", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table", 5000);

    // 1. Search for "emails"
    await browser.type("#overview-search-input", "emails");
    await browser.waitForFunction(() => {
      const rows = document.querySelectorAll(".data-table tbody tr");
      return rows.length === 1 && rows[0].textContent.includes("emails-queue");
    }, 5000);

    // 2. Search for non-existent queue -> shows empty filter state
    await browser.type("#overview-search-input", "no-such-queue-match");
    await browser.waitForSelector(".empty-filter-state", 5000);

    // 3. Clear filter via clear button
    await browser.click("#overview-clear-filters-btn");
    await browser.waitForFunction(() => {
      return document.querySelectorAll(".data-table tbody tr").length === 3;
    }, 5000);

    // 4. Status filter: "paused"
    await browser.selectOption("#overview-status-select", "paused");
    await browser.waitForFunction(() => {
      const rows = document.querySelectorAll(".data-table tbody tr");
      return rows.length === 1 && rows[0].textContent.includes("legacy-queue");
    }, 5000);

    // Reset status filter back to "all"
    await browser.selectOption("#overview-status-select", "all");
    await browser.waitForFunction(() => {
      return document.querySelectorAll(".data-table tbody tr").length === 3;
    }, 5000);

    // 5. Multi-column sort: sort by Waiting
    await browser.click("#sort-btn-waiting");
    // Default initial sort for numeric metric is descending: orders (80) -> emails (5) -> legacy (0)
    let firstRow = await browser.evaluate(() => {
      return document.querySelector(".data-table tbody tr .queue-name-cell")?.textContent?.trim();
    });
    assert.equal(firstRow, "orders-queue");

    // Click again: Ascending: legacy (0) -> emails (5) -> orders (80)
    await browser.click("#sort-btn-waiting");
    firstRow = await browser.evaluate(() => {
      return document.querySelector(".data-table tbody tr .queue-name-cell")?.textContent?.trim();
    });
    assert.equal(firstRow, "legacy-queue");
  });

  it("Journey 4: Navigate from queue row to its DLQ Explorer", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table", 5000);

    // Click the DLQ action button on the orders-queue row
    await browser.click('.overview-dlq-btn[data-queue="orders-queue"]');
    await browser.waitForSelector("#dlq-queue-select", 5000);

    const hash = await browser.evaluate(() => window.location.hash);
    assert.equal(hash, "#/dlq?queue=orders-queue");

    const selectedQueue = await browser.evaluate(() => document.getElementById("dlq-queue-select")?.value);
    assert.equal(selectedQueue, "orders-queue");

    // Verify DLQ jobs loaded
    await browser.waitForSelector(".data-table tbody tr", 5000);
    const dlqRowsCount = await browser.evaluate(() => document.querySelectorAll(".data-table tbody tr").length);
    assert.ok(dlqRowsCount >= 2);
  });

  it("Journey 5: Change DLQ ordering and pagination, then inspect job", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(`${serverUrl}#/dlq?queue=orders-queue`);
    await browser.waitForSelector(".data-table tbody tr", 5000);

    // 1. Change DLQ ordering
    await browser.selectOption("#dlq-order-select", "asc");
    await browser.waitForFunction(() => {
      const select = document.getElementById("dlq-order-select");
      return select && select.value === "asc";
    }, 5000);

    // Switch back to desc
    await browser.selectOption("#dlq-order-select", "desc");
    await browser.waitForSelector(".data-table tbody tr", 5000);

    // 2. Click "Inspect" on first job row (dlq-ord-901)
    await browser.click(".dlq-inspect-btn");
    await browser.waitForSelector(".job-expanded-row", 5000);

    const detailText = await browser.evaluate(() => {
      return document.querySelector(".job-expanded-row")?.textContent || "";
    });
    assert.match(detailText, /InventoryAllocationError: Item out of stock/);
    assert.match(detailText, /ord-901/);

    // 3. Cross-navigate to Job Inspector via "Inspect in Job Inspector" button inside expanded panel
    await browser.click(".inspect-in-job-view-btn");
    await browser.waitForSelector('.table-card[aria-label="Job Inspection Details"]', 5000);

    const hash = await browser.evaluate(() => window.location.hash);
    assert.match(hash, /^#\/job/);
    assert.match(hash, /queue=orders-queue/);
    assert.match(hash, /jobId=dlq-ord-901/);
  });

  it("Journey 6: Open Job Inspector and verify success, not-found, malformed, and unsupported states", async (t) => {
    if (!browserAvailable) return t.skip();

    // State 1: Success state for existing job ord-job-101
    await browser.navigate(`${serverUrl}#/job?queue=orders-queue&jobId=ord-job-101`);
    await browser.waitForSelector('.table-card[aria-label="Job Inspection Details"]', 5000);

    let titleText = await browser.evaluate(() => document.querySelector(".table-title.font-mono")?.textContent?.trim());
    assert.equal(titleText, "ord-job-101");

    let progressValue = await browser.evaluate(() => {
      const bar = document.querySelector('.progress-bar[role="progressbar"]');
      return bar?.getAttribute("aria-valuenow");
    });
    assert.equal(progressValue, "64");

    // State 2: Not-found state (404 JOB_NOT_FOUND)
    await browser.type("#job-id-input", "missing-job-xyz-404");
    await browser.submitForm("#job-search-form");
    await browser.waitForSelector(".error-code-badge", 5000);

    let errorText = await browser.evaluate(() => document.querySelector(".state-container")?.textContent || "");
    assert.match(errorText, /JOB_NOT_FOUND/);
    assert.match(errorText, /Job Not Found|Verify that the Job ID is correct/);

    // State 3: Malformed input state (400 VALIDATION_ERROR)
    await browser.type("#job-id-input", "   ");
    await browser.submitForm("#job-search-form");
    await browser.waitForSelector(".error-state", 5000);

    errorText = await browser.evaluate(() => document.querySelector(".error-state")?.textContent || "");
    assert.match(errorText, /VALIDATION_ERROR/);
    assert.match(errorText, /jobId must be a non-empty string/);

    // State 4: Unsupported-core state (501 NOT_SUPPORTED)
    // Select legacy-queue which lacks getJob()
    await browser.selectOption("#job-queue-select", "legacy-queue");
    await browser.type("#job-id-input", "some-job-id");
    await browser.submitForm("#job-search-form");
    await browser.waitForSelector(".callout-warning", 5000);

    errorText = await browser.evaluate(() => document.querySelector(".callout-warning")?.textContent || "");
    assert.match(errorText, /getJob/);
    assert.match(errorText, /Core Library Compatibility/);
  });

  it("Journey 7: Navigate between views while requests are pending and verify stale responses do not overwrite state", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(`${serverUrl}#/dlq?queue=orders-queue`);
    await browser.waitForSelector("#dlq-queue-select", 5000);

    // Set up delayed DLQ response
    shouldDelayDLQ = true;
    let promiseResolved = false;
    slowRequestPromiseResolver = () => {
      promiseResolved = true;
    };

    // Trigger a refresh/fetch on DLQ view
    await browser.selectOption("#dlq-order-select", "asc");

    // Immediately navigate away to Queue Overview before DLQ request finishes
    await browser.click('.nav-link[data-view="overview"]');
    await browser.waitForSelector(".data-table", 5000);

    const activeViewBeforeResolve = await browser.evaluate(() => window.__rqDashboardApp.state.activeView);
    assert.equal(activeViewBeforeResolve, "overview");

    // Now resolve the pending slow DLQ request
    shouldDelayDLQ = false;
    if (typeof slowRequestPromiseResolver === "function") {
      slowRequestPromiseResolver();
    }
    await new Promise((r) => setTimeout(r, 200));

    // Active view must still be overview and content-container must NOT have been overwritten by DLQ
    const activeViewAfterResolve = await browser.evaluate(() => window.__rqDashboardApp.state.activeView);
    assert.equal(activeViewAfterResolve, "overview");

    const isOverviewTablePresent = await browser.evaluate(() => {
      return document.querySelector(".overview-toolbar") !== null;
    });
    assert.equal(isOverviewTablePresent, true);
  });

  it("Journey 8: Exercise DLQ API failure and retry state", async (t) => {
    if (!browserAvailable) return t.skip();

    failDlqRequest = true;
    await browser.navigate(`${serverUrl}#/dlq?queue=orders-queue`);
    await browser.waitForSelector("#dlq-retry-btn", 5000);

    const errorMsg = await browser.evaluate(() => document.querySelector(".error-state")?.textContent || "");
    assert.match(errorMsg, /DLQ storage partition unreachable/);
    assert.match(errorMsg, /Retry/);

    // Unbreak DLQ and click retry button
    failDlqRequest = false;
    await browser.click("#dlq-retry-btn");
    await browser.waitForSelector(".data-table tbody tr", 5000);

    const jobsCount = await browser.evaluate(() => document.querySelectorAll(".data-table tbody tr").length);
    assert.ok(jobsCount >= 2);
  });

  it("Journey 9: Test keyboard accessibility, skip links, and focus restoration", async (t) => {
    if (!browserAvailable) return t.skip();

    await browser.navigate(serverUrl);
    await browser.waitForSelector(".data-table", 5000);

    // 1. Skip-to-content link
    const hasSkipLink = await browser.evaluate(() => {
      const link = document.querySelector("a.skip-link");
      return link && link.getAttribute("href") === "#content-container";
    });
    assert.equal(hasSkipLink, true);

    // 2. Focus preservation across search input re-renders
    await browser.click("#overview-search-input");
    await browser.type("#overview-search-input", "orders");

    const isInputStillFocused = await browser.evaluate(() => {
      return document.activeElement === document.getElementById("overview-search-input");
    });
    assert.equal(isInputStillFocused, true);

    // 3. Clear search and test sorting focus
    await browser.click("#overview-clear-filters-btn");
    await browser.waitForSelector("#sort-btn-waiting", 5000);

    await browser.click("#sort-btn-waiting");
    const isSortBtnFocused = await browser.evaluate(() => {
      return document.activeElement?.id === "sort-btn-waiting";
    });
    assert.equal(isSortBtnFocused, true);
  });
});
