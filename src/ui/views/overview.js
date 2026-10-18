"use strict";

/**
 * Queue Overview View Component
 * Renders loading, empty, error, and live queues table with aggregate telemetry cards.
 */

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderOverviewLoading() {
  return `
    <div class="state-container loading-state" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <h3 class="state-title">Loading Queues...</h3>
      <p class="state-description">Fetching real-time queue telemetry from the adapter API.</p>
    </div>
  `;
}

function renderOverviewEmpty() {
  return `
    <div class="state-container empty-state" role="status">
      <div class="state-icon" aria-hidden="true">📭</div>
      <h3 class="state-title">No Queues Registered</h3>
      <p class="state-description">
        No <code>ResilientQueue</code> instances have been registered with the dashboard adapter yet.
        Register queues in your server configuration:
      </p>
      <div class="code-snippet">
        <code>createExpressAdapter({ queues: { "my-queue": myQueueInstance } })</code>
      </div>
    </div>
  `;
}

function renderOverviewError(error) {
  const code = error?.code || "INTERNAL_ERROR";
  const message = error?.message || "Failed to communicate with dashboard API.";

  return `
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="state-icon" aria-hidden="true">⚠️</div>
      <span class="error-code-badge">${escapeHtml(code)}</span>
      <h3 class="state-title error-title">Failed to Load Queues</h3>
      <p class="state-description">${escapeHtml(message)}</p>
      <button type="button" class="btn btn-primary" id="retry-overview-btn" aria-label="Retry loading queue metrics">
        <span>Retry</span>
      </button>
    </div>
  `;
}

function renderOverviewData(queues) {
  if (!Array.isArray(queues) || queues.length === 0) {
    return renderOverviewEmpty();
  }

  let totalWaiting = 0;
  let totalActive = 0;
  let totalDelayed = 0;
  let totalDLQ = 0;

  for (const q of queues) {
    const metrics = q?.metrics || {};
    totalWaiting += typeof metrics.waiting === "number" ? metrics.waiting : 0;
    totalActive += typeof metrics.active === "number" ? metrics.active : 0;
    totalDelayed += typeof metrics.delayed === "number" ? metrics.delayed : 0;
    totalDLQ += typeof metrics.dlq === "number" ? metrics.dlq : 0;
  }

  const rows = queues
    .map((q) => {
      const name = q?.name || "unknown";
      const isPaused = Boolean(q?.isPaused);
      const metrics = q?.metrics || {};
      const waiting = typeof metrics.waiting === "number" ? metrics.waiting : 0;
      const active = typeof metrics.active === "number" ? metrics.active : 0;
      const delayed = typeof metrics.delayed === "number" ? metrics.delayed : 0;
      const dlq = typeof metrics.dlq === "number" ? metrics.dlq : 0;

      const statusBadge = isPaused
        ? `<span class="badge badge-paused" aria-label="Status: Paused">Paused</span>`
        : `<span class="badge badge-active" aria-label="Status: Active">Active</span>`;

      const dlqBadge = dlq > 0
        ? `<span class="badge badge-dlq-alert" aria-label="${dlq} failed jobs in DLQ">${dlq}</span>`
        : `<span class="metric-number badge-dlq-clean">0</span>`;

      return `
        <tr>
          <td class="queue-name-cell">${escapeHtml(name)}</td>
          <td>${statusBadge}</td>
          <td class="metric-number">${waiting}</td>
          <td class="metric-number">${active}</td>
          <td class="metric-number">${delayed}</td>
          <td>${dlqBadge}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <section class="metrics-grid" aria-label="Aggregated Telemetry">
      <div class="metric-card">
        <div class="metric-label">Queues</div>
        <div class="metric-value">${queues.length}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Waiting</div>
        <div class="metric-value">${totalWaiting}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Active</div>
        <div class="metric-value">${totalActive}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Delayed</div>
        <div class="metric-value">${totalDelayed}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Dead-Letter</div>
        <div class="metric-value ${totalDLQ > 0 ? "has-dlq" : ""}">${totalDLQ}</div>
      </div>
    </section>

    <div class="table-card">
      <div class="table-header">
        <h2 class="table-title">Registered Queues</h2>
        <span class="nav-badge">${queues.length} registered</span>
      </div>
      <div class="table-responsive">
        <table class="data-table" role="table" aria-label="Registered Queues Telemetry">
          <thead>
            <tr>
              <th scope="col">Queue Name</th>
              <th scope="col">Status</th>
              <th scope="col">Waiting</th>
              <th scope="col">Active</th>
              <th scope="col">Delayed</th>
              <th scope="col">DLQ</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

const OverviewView = {
  renderLoading: renderOverviewLoading,
  renderEmpty: renderOverviewEmpty,
  renderError: renderOverviewError,
  renderData: renderOverviewData
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = OverviewView;
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueOverviewView = OverviewView;
}
