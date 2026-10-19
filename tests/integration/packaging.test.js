"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

describe("Package Integrity & Subpath Exports Integration", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const pkgPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  it("should declare valid package.json manifest and metadata", () => {
    assert.equal(pkg.name, "@mayurbhusare/resilient-queue-ui");
    assert.equal(pkg.version, "0.1.0");
    assert.equal(pkg.type, "commonjs");
    assert.equal(pkg.main, "src/index.js");
    assert.equal(pkg.license, "MIT");
    assert.deepEqual(pkg.files, ["src"]);
    assert.ok(pkg.engines && pkg.engines.node === ">=18.0.0", "Expected node >= 18.0.0");
    assert.ok(pkg.peerDependencies && pkg.peerDependencies["@mayurbhusare/resilient-queue"], "Expected peerDependency on core");
  });

  it("should declare exact subpath exports matching package layout", () => {
    const exportsMap = pkg.exports;
    assert.ok(exportsMap, "package.json must contain exports map");
    assert.equal(exportsMap["."], "./src/index.js");
    assert.equal(exportsMap["./api-client"], "./src/ui/api-client.js");
    assert.equal(exportsMap["./ui/*"], "./src/ui/*");
    assert.equal(exportsMap["./package.json"], "./package.json");
  });

  it("should export all expected public symbols from root module entry point", () => {
    const rootModule = require("@mayurbhusare/resilient-queue-ui");

    assert.equal(typeof rootModule, "object");
    assert.equal(rootModule.VERSION, "0.1.0");

    const expectedFunctions = [
      "createExpressAdapter",
      "fastifyDashboardPlugin",
      "QueueRegistry",
      "createQueueRegistry",
      "handleGetMetrics",
      "handleGetDLQ",
      "handleGetJob",
      "handleGetQueues",
      "serializeJob",
      "DashboardDispatcher",
      "createDashboardDispatcher",
      "createErrorResponse",
      "parseDLQQueryParams",
      "ApiClient",
      "ApiError"
    ];

    for (const fn of expectedFunctions) {
      assert.equal(
        typeof rootModule[fn],
        "function",
        `Expected ${fn} to be a function in root exports`
      );
    }
  });

  it("should allow requiring ./api-client subpath export", () => {
    const apiClientModule = require("@mayurbhusare/resilient-queue-ui/api-client");
    assert.equal(typeof apiClientModule.ApiClient, "function");
    assert.equal(typeof apiClientModule.ApiError, "function");

    const client = new apiClientModule.ApiClient({ baseUrl: "/dashboard" });
    assert.equal(client.baseUrl, "/dashboard");
  });

  it("should package and resolve all required UI static assets and views via ./ui/* subpath", () => {
    const requiredAssets = [
      { name: "index.html", expectedPattern: /class="app-container"/ },
      { name: "styles.css", expectedPattern: /--bg-primary/ },
      { name: "app.js", expectedPattern: /class DashboardApp/ },
      { name: "api-client.js", expectedPattern: /class ApiClient/ },
      { name: "views/overview.js", expectedPattern: /OverviewView/ },
      { name: "views/dlq.js", expectedPattern: /DLQView/ },
      { name: "views/job.js", expectedPattern: /JobView/ }
    ];

    for (const asset of requiredAssets) {
      const resolvedPath = require.resolve(`@mayurbhusare/resilient-queue-ui/ui/${asset.name}`);
      assert.ok(fs.existsSync(resolvedPath), `Asset file missing: ${resolvedPath}`);

      const content = fs.readFileSync(resolvedPath, "utf-8");
      assert.ok(content.length > 0, `Asset file is empty: ${resolvedPath}`);
      assert.match(content, asset.expectedPattern, `Asset ${asset.name} content mismatch`);
    }
  });

  it("should instantiate createExpressAdapter with length 3 (req, res, next)", () => {
    const { createExpressAdapter } = require(path.join(rootDir, "src/index.js"));
    const middleware = createExpressAdapter({ queues: {} });
    assert.equal(typeof middleware, "function");
    assert.equal(middleware.length, 3);
  });

  it("should register fastifyDashboardPlugin and execute without throwing", async () => {
    const { fastifyDashboardPlugin } = require(path.join(rootDir, "src/index.js"));
    const routes = [];
    const mockFastify = {
      get(route, opts, handler) {
        routes.push(route);
      }
    };

    await new Promise((resolve) => {
      fastifyDashboardPlugin(mockFastify, { queues: {} }, resolve);
    });

    assert.ok(routes.includes("/api/queues"));
    assert.ok(routes.includes("/api/queues/:queueName/metrics"));
    assert.ok(routes.includes("/api/queues/:queueName/dlq"));
    assert.ok(routes.includes("/api/queues/:queueName/jobs/:jobId"));
    assert.ok(routes.includes("/"));
    assert.ok(routes.includes("/styles.css"));
  });
});
