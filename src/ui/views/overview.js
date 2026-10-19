"use strict";

/**
 * Queue Overview View Component (Milestones 8 & 9)
 * Renders loading, empty, error, and live queues table with aggregate telemetry cards,
 * client-side search/filtering, multi-column sorting, operational diagnostics,
 * and direct navigation to DLQ Explorer and Job Inspector.
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

function parseDate(ts) {
  if (!ts) return null;
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function formatTimestamp(ts) {
  const d = parseDate(ts);
  if (!d) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatIso(ts) {
  const d = parseDate(ts);
  if (!d) return "";
  return d.toISOString();
}

/**
 * Derives the operational status of a queue.
 * Never claims healthy based solely on zero counts.
 *
 * @param {object} q
 * @returns {"active"|"paused"|"closed"|"unavailable"|"error"}
 */
function getQueueStatus(q) {
  if (Boolean(q?.isClosed) || q?.status === "closed") {
    return "closed";
  }
  if (Boolean(q?.error) || q?.status === "error") {
    return "error";
  }
  if (q?.metrics == null || q?.status === "unavailable") {
    return "unavailable";
  }
  if (Boolean(q?.isPaused)) {
    return "paused";
  }
  return "active";
}

function sanitizeUiErrorMessage(msg) {
  if (typeof msg !== "string" || msg.trim().length === 0) {
    return "Failed to communicate with dashboard API.";
  }
  let cleaned = msg.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:[^:\s/@]+:)?([^@\s/]+)@/g,
    "$1[redacted]@"
  );
  cleaned = cleaned.replace(
    /\b(AUTH|Bearer)\s+['"]?[^\s'";&]+['"]?/gi,
    "$1 [redacted]"
  );
  cleaned = cleaned.replace(
    /\b(password|passwd|pwd|token|secret|apikey|api_key)(\s*[:=]\s*)['"]?[^\s'";&]+['"]?/gi,
    "$1$2[redacted]"
  );
  return cleaned;
}

/**
 * Produces actionable operational diagnostics for API error responses.
 *
 * @param {object} error
 * @returns {{ code: string, status: number, title: string, description: string, guidance: string, category: string }}
 */
function getDiagnosticInfo(error) {
  const code = error?.code || (error?.status === 404 ? "NOT_FOUND" : error?.status === 503 ? "SERVICE_UNAVAILABLE" : error?.status === 501 ? "NOT_SUPPORTED" : "INTERNAL_ERROR");
  const status = typeof error?.status === "number" ? error.status : typeof error?.statusCode === "number" ? error.statusCode : 0;
  const rawMessage = error?.message || "Failed to communicate with dashboard API.";

  let title = "Failed to Load Queues";
  let description = sanitizeUiErrorMessage(rawMessage);
  let guidance = "Check the host application logs and verify that the dashboard adapter is properly configured.";
  let category = "error";

  switch (code) {
    case "QUEUE_CLOSED":
      title = "Queue Closed";
      guidance = "The target ResilientQueue instance has been closed via queue.close(). Operations are suspended until the host application restarts or reinitializes the queue.";
      category = "warning";
      break;
    case "QUEUE_NOT_FOUND":
      title = "Queue Not Registered";
      guidance = "The requested queue is not registered with the dashboard adapter. Verify that it is included in the 'queues' configuration object during adapter initialization.";
      category = "warning";
      break;
    case "NOT_SUPPORTED":
      title = "Core Feature Not Supported";
      guidance = "The installed version of @mayurbhusare/resilient-queue does not expose this method. Live job inspection requires an updated core release or a compatible queue provider.";
      category = "warning";
      break;
    case "VALIDATION_ERROR":
      title = "Invalid Request Parameters";
      guidance = "One or more parameters were rejected by the adapter validation layer. Review requested query parameters and identifiers.";
      break;
    case "NETWORK_ERROR":
      title = "Network Communication Failure";
      guidance = "Unable to reach the dashboard API endpoint. Verify that the server is running, the host port is open, and no firewall is blocking HTTP requests.";
      break;
    case "INTERNAL_ERROR":
      title = "Internal Server Error";
      guidance = "An internal error occurred while communicating with Redis or executing queue commands. Check Redis connection health and host logs.";
      break;
    default:
      if (status === 503 || /queue is closed/i.test(rawMessage)) {
        title = "Queue Closed";
        guidance = "The target queue instance has been closed via queue.close().";
        category = "warning";
      } else if (status === 501) {
        title = "Core Feature Not Supported";
        guidance = "This capability is not supported by the currently installed core package release.";
        category = "warning";
      } else if (status === 404) {
        title = "Resource Not Found";
        guidance = "The requested queue or resource could not be found in the adapter registry.";
      }
      break;
  }

  return { code, status, title, description, guidance, category };
}

function renderMetricCell(val, label) {
  if (typeof val === "number" && !Number.isNaN(val)) {
    return `<td class="metric-number">${val}</td>`;
  }
  return `<td class="metric-number"><span class="metric-unavailable" title="${label || "Metric"} unavailable">—</span></td>`;
}

function renderDLQCell(dlq, name) {
  const encodedName = encodeURIComponent(name);
  if (typeof dlq !== "number" || Number.isNaN(dlq)) {
    return `<td><span class="metric-unavailable" title="DLQ count unavailable">—</span></td>`;
  }
  if (dlq > 0) {
    return `<td><a href="#/dlq?queue=${encodedName}" class="badge badge-dlq-alert view-dlq-link" data-queue="${escapeHtml(name)}" aria-label="View ${dlq} failed jobs in DLQ for queue ${escapeHtml(name)}">${dlq}</a></td>`;
  }
  return `<td><a href="#/dlq?queue=${encodedName}" class="view-dlq-link" data-queue="${escapeHtml(name)}" aria-label="View 0 failed jobs in DLQ for queue ${escapeHtml(name)}"><span class="metric-number badge-dlq-clean">0</span></a></td>`;
}

function renderStatusBadge(q) {
  const status = getQueueStatus(q);
  switch (status) {
    case "closed":
      return `<span class="badge badge-closed" role="status" aria-label="Status: Closed"><span aria-hidden="true">■</span> Closed</span>`;
    case "error":
      return `<span class="badge badge-error" role="status" aria-label="Status: Error"><span aria-hidden="true">⚠️</span> Error</span>`;
    case "unavailable":
      return `<span class="badge badge-unavailable" role="status" aria-label="Status: Unavailable"><span aria-hidden="true">—</span> Unavailable</span>`;
    case "paused":
      return `<span class="badge badge-paused" role="status" aria-label="Status: Paused"><span aria-hidden="true">⏸</span> Paused</span>`;
    case "active":
    default:
      return `<span class="badge badge-active" role="status" aria-label="Status: Active"><span aria-hidden="true">●</span> Active</span>`;
  }
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
  const diag = getDiagnosticInfo(error);

  return `
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="state-icon" aria-hidden="true">⚠️</div>
      <span class="error-code-badge">${escapeHtml(diag.code)}</span>
      <h3 class="state-title error-title">${escapeHtml(diag.title)}</h3>
      <p class="state-description">${escapeHtml(diag.description)}</p>
      <div class="diagnostic-guidance" style="margin-top: 0.75rem; max-width: 540px; text-align: left;">
        <div class="callout callout-warning">
          <div class="callout-header"><span>Operational Diagnostic</span></div>
          <div class="callout-body">${escapeHtml(diag.guidance)}</div>
        </div>
      </div>
      <button type="button" class="btn btn-primary" id="retry-overview-btn" aria-label="Retry loading queue metrics" style="margin-top: 1rem;">
        <span>Retry</span>
      </button>
    </div>
  `;
}

/**
 * Filters registered queues by client-side search query and status filter.
 *
 * @param {Array<object>} queues
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function filterQueues(queues, options = {}) {
  if (!Array.isArray(queues) || queues.length === 0) return [];

  const searchQuery = String(options.searchQuery || "").trim().toLowerCase();
  const statusFilter = String(options.statusFilter || "all").trim().toLowerCase();

  return queues.filter((q) => {
    // Search query matching against queue name
    if (searchQuery) {
      const name = String(q?.name || "").toLowerCase();
      if (!name.includes(searchQuery)) {
        return false;
      }
    }

    // Status filter matching
    if (statusFilter && statusFilter !== "all") {
      const status = getQueueStatus(q);
      if (status !== statusFilter) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Extracts a numeric metric value or null. Unavailable metrics are never treated as zero.
 *
 * @param {object} q
 * @param {string} key
 * @returns {number|null}
 */
function getMetricValue(q, key) {
  const metrics = q?.metrics;
  if (!metrics || typeof metrics !== "object") return null;
  const val = metrics[key];
  if (typeof val === "number" && !Number.isNaN(val)) {
    return val;
  }
  return null;
}

/**
 * Sorts registered queues.
 * Critically, unavailable metrics are handled without treating them as zero;
 * null/unavailable metrics are pushed to the end in both ascending and descending order.
 *
 * @param {Array<object>} queues
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function sortQueues(queues, options = {}) {
  if (!Array.isArray(queues) || queues.length <= 1) return Array.isArray(queues) ? [...queues] : [];

  const sortKey = options.sortKey || "name";
  const sortOrder = options.sortOrder === "desc" ? "desc" : "asc";

  return [...queues].sort((a, b) => {
    // Metric columns
    if (sortKey === "waiting" || sortKey === "active" || sortKey === "delayed" || sortKey === "dlq") {
      const valA = getMetricValue(a, sortKey);
      const valB = getMetricValue(b, sortKey);

      const aIsNull = valA === null;
      const bIsNull = valB === null;

      if (aIsNull && bIsNull) {
        return String(a?.name || "").localeCompare(String(b?.name || ""));
      }
      if (aIsNull) return 1; // unavailable always sorted last
      if (bIsNull) return -1; // unavailable always sorted last

      const diff = valA - valB;
      if (diff !== 0) {
        return sortOrder === "desc" ? -diff : diff;
      }
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    }

    // Status column
    if (sortKey === "status") {
      const statusA = getQueueStatus(a);
      const statusB = getQueueStatus(b);
      const cmp = statusA.localeCompare(statusB);
      if (cmp !== 0) {
        return sortOrder === "desc" ? -cmp : cmp;
      }
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    }

    // Last updated column
    if (sortKey === "lastUpdated") {
      const dateA = parseDate(a?.lastUpdated);
      const dateB = parseDate(b?.lastUpdated);
      const tsA = dateA ? dateA.getTime() : null;
      const tsB = dateB ? dateB.getTime() : null;

      const aIsNull = tsA === null;
      const bIsNull = tsB === null;

      if (aIsNull && bIsNull) {
        return String(a?.name || "").localeCompare(String(b?.name || ""));
      }
      if (aIsNull) return 1; // unavailable or invalid timestamps always sorted last
      if (bIsNull) return -1;

      const diff = tsA - tsB;
      if (diff !== 0) {
        return sortOrder === "desc" ? -diff : diff;
      }
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    }

    // Default: Queue name
    const nameA = String(a?.name || "").toLowerCase();
    const nameB = String(b?.name || "").toLowerCase();
    const cmp = nameA.localeCompare(nameB);
    return sortOrder === "desc" ? -cmp : cmp;
  });
}

function getAriaSort(colKey, currentKey, currentOrder) {
  if (colKey !== currentKey) return "none";
  return currentOrder === "asc" ? "ascending" : "descending";
}

function getSortIndicator(colKey, currentKey, currentOrder) {
  if (colKey !== currentKey) {
    return `<span class="sort-icon-idle" aria-hidden="true">↕</span>`;
  }
  return currentOrder === "asc" ? "▲" : "▼";
}

function renderOverviewData(queues, options = {}) {
  if (!Array.isArray(queues) || queues.length === 0) {
    return renderOverviewEmpty();
  }

  const searchQuery = typeof options.searchQuery === "string" ? options.searchQuery : "";
  const statusFilter = typeof options.statusFilter === "string" ? options.statusFilter : "all";
  const sortKey = options.sortKey || "name";
  const sortOrder = options.sortOrder || "asc";

  // Filter and sort queues
  const filteredQueues = filterQueues(queues, { searchQuery, statusFilter });
  const sortedQueues = sortQueues(filteredQueues, { sortKey, sortOrder });

  const hasActiveFilters = Boolean(searchQuery.trim().length > 0 || (statusFilter && statusFilter !== "all"));

  // Calculate totals across ALL registered queues
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
    const diag = getDiagnosticInfo(syncError);
    const lastSyncTime = options?.lastUpdated ? formatTimestamp(options.lastUpdated) : null;
    syncErrorBanner = `
      <div class="sync-error-banner" role="alert" aria-live="polite">
        <div class="sync-error-content">
          <span class="sync-error-icon" aria-hidden="true">⚠️</span>
          <div class="sync-error-text">
            <span class="sync-error-code">${escapeHtml(diag.code)}:</span>
            <strong>Temporary Sync Failure:</strong> ${escapeHtml(diag.description)}
            <span class="sync-error-guidance" style="font-size: 12px; opacity: 0.9;">${escapeHtml(diag.guidance)}</span>
            ${lastSyncTime ? `<span class="sync-error-sub">Displaying data from last successful update at ${escapeHtml(lastSyncTime)}.</span>` : ""}
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="retry-overview-sync-btn" aria-label="Retry syncing queue metrics">
          <span>Retry Now</span>
        </button>
      </div>
    `;
  }

  let tableContent = "";

  if (sortedQueues.length === 0) {
    tableContent = `
      <div class="state-container empty-filter-state" role="status" style="padding: 2.5rem 1rem;">
        <div class="state-icon" aria-hidden="true">🔍</div>
        <h3 class="state-title">No Matching Queues</h3>
        <p class="state-description">
          No registered queues match the current filter criteria${searchQuery ? ` ("${escapeHtml(searchQuery)}")` : ""}.
        </p>
        <button type="button" class="btn btn-secondary btn-sm overview-clear-btn" id="overview-reset-filters-btn" aria-label="Clear all queue filters">
          <span>Clear Filter</span>
        </button>
      </div>
    `;
  } else {
    const rows = sortedQueues
      .map((q) => {
        const name = q?.name || "unknown";
        const metrics = q?.metrics;
        const statusBadge = renderStatusBadge(q);
        const encodedName = encodeURIComponent(name);

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
            <td class="queue-actions-cell" style="text-align: right; white-space: nowrap;">
              <a
                href="#/dlq?queue=${encodedName}"
                class="btn btn-secondary btn-xs action-nav-btn overview-dlq-btn"
                data-queue="${escapeHtml(name)}"
                aria-label="Open DLQ Explorer for queue ${escapeHtml(name)}"
              >DLQ</a>
              <a
                href="#/job?queue=${encodedName}"
                class="btn btn-secondary btn-xs action-nav-btn overview-job-btn"
                data-queue="${escapeHtml(name)}"
                aria-label="Inspect jobs in queue ${escapeHtml(name)}"
              >Inspect</a>
            </td>
          </tr>
        `;
      })
      .join("");

    tableContent = `
      <div class="table-responsive">
        <table class="data-table" role="table" aria-label="Registered Queues Telemetry">
          <thead>
            <tr>
              <th scope="col" aria-sort="${getAriaSort("name", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-name" class="sort-header-btn" data-sort-key="name" aria-label="Sort by Queue Name">
                  <span>Queue Name</span>
                  <span class="sort-indicator">${getSortIndicator("name", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" aria-sort="${getAriaSort("status", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-status" class="sort-header-btn" data-sort-key="status" aria-label="Sort by Status">
                  <span>Status</span>
                  <span class="sort-indicator">${getSortIndicator("status", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" aria-sort="${getAriaSort("waiting", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-waiting" class="sort-header-btn" data-sort-key="waiting" aria-label="Sort by Waiting Count">
                  <span>Waiting</span>
                  <span class="sort-indicator">${getSortIndicator("waiting", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" aria-sort="${getAriaSort("active", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-active" class="sort-header-btn" data-sort-key="active" aria-label="Sort by Active Count">
                  <span>Active</span>
                  <span class="sort-indicator">${getSortIndicator("active", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" aria-sort="${getAriaSort("delayed", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-delayed" class="sort-header-btn" data-sort-key="delayed" aria-label="Sort by Delayed Count">
                  <span>Delayed</span>
                  <span class="sort-indicator">${getSortIndicator("delayed", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" aria-sort="${getAriaSort("dlq", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-dlq" class="sort-header-btn" data-sort-key="dlq" aria-label="Sort by DLQ Count">
                  <span>DLQ</span>
                  <span class="sort-indicator">${getSortIndicator("dlq", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" aria-sort="${getAriaSort("lastUpdated", sortKey, sortOrder)}">
                <button type="button" id="sort-btn-lastUpdated" class="sort-header-btn" data-sort-key="lastUpdated" aria-label="Sort by Last Updated">
                  <span>Last Updated</span>
                  <span class="sort-indicator">${getSortIndicator("lastUpdated", sortKey, sortOrder)}</span>
                </button>
              </th>
              <th scope="col" style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  const overallLastUpdated = options?.lastUpdated;
  const overallFormatted = formatTimestamp(overallLastUpdated);
  const overallIso = formatIso(overallLastUpdated);

  const filterSummaryBadge = hasActiveFilters
    ? `<span class="nav-badge">${filteredQueues.length} of ${queues.length} matching</span>`
    : `<span class="nav-badge">${queues.length} registered</span>`;

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

    <!-- Queue Management Controls: Search, Filter, and Sort -->
    <section class="dlq-toolbar overview-toolbar" aria-label="Queue Search and Filter Controls">
      <div class="form-group" style="flex: 1; min-width: 220px;">
        <label for="overview-search-input" class="form-label">Search:</label>
        <input
          type="text"
          id="overview-search-input"
          class="form-input"
          placeholder="Filter queues by name..."
          value="${escapeHtml(searchQuery)}"
          aria-label="Filter queues by name"
        />
      </div>

      <div class="form-group">
        <label for="overview-status-select" class="form-label">Status:</label>
        <select id="overview-status-select" class="form-select" aria-label="Filter by queue status">
          <option value="all" ${statusFilter === "all" ? "selected" : ""}>All Statuses</option>
          <option value="active" ${statusFilter === "active" ? "selected" : ""}>Active</option>
          <option value="paused" ${statusFilter === "paused" ? "selected" : ""}>Paused</option>
          <option value="closed" ${statusFilter === "closed" ? "selected" : ""}>Closed</option>
          <option value="unavailable" ${statusFilter === "unavailable" ? "selected" : ""}>Unavailable</option>
          <option value="error" ${statusFilter === "error" ? "selected" : ""}>Error</option>
        </select>
      </div>

      ${
        hasActiveFilters
          ? `
        <div style="display: flex; align-items: center;">
          <button
            type="button"
            id="overview-clear-filters-btn"
            class="btn btn-secondary btn-sm overview-clear-btn"
            aria-label="Clear active queue filters"
          >
            <span>Clear Filter</span>
          </button>
        </div>
      `
          : ""
      }
    </section>

    <div class="table-card">
      <div class="table-header">
        <div class="table-title-group">
          <h2 class="table-title">Registered Queues</h2>
          ${filterSummaryBadge}
        </div>
        ${overallIso ? `<div class="table-meta"><span class="last-sync-label">Last updated: <time datetime="${escapeHtml(overallIso)}">${escapeHtml(overallFormatted)}</time></span></div>` : ""}
      </div>
      ${tableContent}
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
  formatIso,
  getQueueStatus,
  getDiagnosticInfo,
  filterQueues,
  sortQueues,
  getMetricValue,
  sanitizeUiErrorMessage
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = OverviewView;
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueOverviewView = OverviewView;
}
