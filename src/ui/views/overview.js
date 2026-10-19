"use strict";

/**
 * Queue Overview View Component
 * Renders loading, empty, error, and live queues table with aggregate telemetry cards.
 */

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function formatIso(ts) {
  if (!ts) return "";
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString();
  } catch {
    return "";
  }
}

function renderMetricCell(val, label) {
  if (typeof val === "number" && !Number.isNaN(val)) {
    return `<td class="metric-number">${val}</td>`;
  }
  return `<td class="metric-number"><span class="metric-unavailable" title="${label || "Metric"} unavailable">—</span></td>`;
}

function renderDLQCell(dlq, name) {
  if (typeof dlq !== "number" || Number.isNaN(dlq)) {
    return `<td><span class="metric-unavailable" title="DLQ count unavailable">—</span></td>`;
  }
  if (dlq > 0) {
    return `<td><a href="#dlq" class="badge badge-dlq-alert view-dlq-link" data-queue="${escapeHtml(name)}" aria-label="View ${dlq} failed jobs in DLQ for queue ${escapeHtml(name)}">${dlq}</a></td>`;
  }
  return `<td><span class="metric-number badge-dlq-clean">0</span></td>`;
}

function renderStatusBadge(q) {
  if (Boolean(q?.isClosed) || q?.status === "closed") {
    return `<span class="badge badge-closed" aria-label="Status: Closed">Closed</span>`;
  }
  if (q?.error || q?.status === "error") {
    return `<span class="badge badge-error" aria-label="Status: Error">Error</span>`;
  }
  if (q?.metrics == null || q?.status === "unavailable") {
    return `<span class="badge badge-unavailable" aria-label="Status: Unavailable">Unavailable</span>`;
  }
  if (Boolean(q?.isPaused)) {
    return `<span class="badge badge-paused" aria-label="Status: Paused">Paused</span>`;
  }
  return `<span class="badge badge-active" aria-label="Status: Active">Active</span>`;
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

function renderOverviewData(queues, options = {}) {
  if (!Array.isArray(queues) || queues.length === 0) {
    return renderOverviewEmpty();
  }

  let totalWaiting = 0;
  let totalActive = 0;
  let totalDelayed = 0;
  let totalDLQ = 0;

  for (const q of queues) {
    const metrics = q?.metrics;
    if (metrics && typeof metrics === "object") {
      if (typeof metrics.waiting === "number" && !Number.isNaN(metrics.waiting)) {
        totalWaiting += metrics.waiting;
      }
      if (typeof metrics.active === "number" && !Number.isNaN(metrics.active)) {
        totalActive += metrics.active;
      }
      if (typeof metrics.delayed === "number" && !Number.isNaN(metrics.delayed)) {
        totalDelayed += metrics.delayed;
      }
      if (typeof metrics.dlq === "number" && !Number.isNaN(metrics.dlq)) {
        totalDLQ += metrics.dlq;
      }
    }
  }

  const syncError = options?.syncError;
  let syncErrorBanner = "";
  if (syncError) {
    const errorMsg = syncError?.message || "Failed to update queue telemetry";
    const errorCode = syncError?.code || "SYNC_ERROR";
    const lastSyncTime = options?.lastUpdated ? formatTimestamp(options.lastUpdated) : null;
    syncErrorBanner = `
      <div class="sync-error-banner" role="alert" aria-live="polite">
        <div class="sync-error-content">
          <span class="sync-error-icon" aria-hidden="true">⚠️</span>
          <div class="sync-error-text">
            <span class="sync-error-code">${escapeHtml(errorCode)}:</span>
            <strong>Temporary Sync Failure:</strong> ${escapeHtml(errorMsg)}
            ${lastSyncTime ? `<span class="sync-error-sub">Displaying data from last successful update at ${escapeHtml(lastSyncTime)}.</span>` : ""}
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="retry-overview-sync-btn" aria-label="Retry syncing queue metrics">
          <span>Retry Now</span>
        </button>
      </div>
    `;
  }

  const rows = queues
    .map((q) => {
      const name = q?.name || "unknown";
      const metrics = q?.metrics;
      const statusBadge = renderStatusBadge(q);

      const waiting = metrics && typeof metrics.waiting === "number" && !Number.isNaN(metrics.waiting) ? metrics.waiting : (metrics?.waiting ?? null);
      const active = metrics && typeof metrics.active === "number" && !Number.isNaN(metrics.active) ? metrics.active : (metrics?.active ?? null);
      const delayed = metrics && typeof metrics.delayed === "number" && !Number.isNaN(metrics.delayed) ? metrics.delayed : (metrics?.delayed ?? null);
      const dlq = metrics && typeof metrics.dlq === "number" && !Number.isNaN(metrics.dlq) ? metrics.dlq : (metrics?.dlq ?? null);

      const queueLastUpdated = q?.lastUpdated || (options?.queueLastUpdated && options.queueLastUpdated[name]) || options?.lastUpdated;
      const lastUpdatedFormatted = formatTimestamp(queueLastUpdated);
      const lastUpdatedIso = formatIso(queueLastUpdated);
      const lastUpdatedCell = lastUpdatedIso
        ? `<td class="last-updated-cell"><time datetime="${escapeHtml(lastUpdatedIso)}" title="${escapeHtml(lastUpdatedIso)}">${escapeHtml(lastUpdatedFormatted)}</time></td>`
        : `<td class="last-updated-cell text-muted">—</td>`;

      return `
        <tr>
          <td class="queue-name-cell">${escapeHtml(name)}</td>
          <td>${statusBadge}</td>
          ${renderMetricCell(waiting, "Waiting")}
          ${renderMetricCell(active, "Active")}
          ${renderMetricCell(delayed, "Delayed")}
          ${renderDLQCell(dlq, name)}
          ${lastUpdatedCell}
        </tr>
      `;
    })
    .join("");

  const overallLastUpdated = options?.lastUpdated;
  const overallFormatted = formatTimestamp(overallLastUpdated);
  const overallIso = formatIso(overallLastUpdated);

  return `
    ${syncErrorBanner}
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
        <div class="table-title-group">
          <h2 class="table-title">Registered Queues</h2>
          <span class="nav-badge">${queues.length} registered</span>
        </div>
        ${overallIso ? `<div class="table-meta"><span class="last-sync-label">Last updated: <time datetime="${escapeHtml(overallIso)}">${escapeHtml(overallFormatted)}</time></span></div>` : ""}
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
              <th scope="col">Last Updated</th>
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
  renderData: renderOverviewData,
  renderStatusBadge,
  renderMetricCell,
  renderDLQCell,
  formatTimestamp,
  formatIso
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = OverviewView;
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueOverviewView = OverviewView;
}
