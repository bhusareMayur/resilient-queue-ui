"use strict";

/**
 * Dead Letter Queue (DLQ) View Component (Milestone 6)
 *
 * Full functional, read-only Dead Letter Queue Explorer.
 * Supports:
 * - Queue selection among registered queues
 * - Real-time DLQ browsing via GET /api/queues/:queueName/dlq
 * - Pagination via start, limit, and order parameters
 * - Safe handling of corrupted records with id: null
 * - Inline safe payload inspection
 * - Loading, empty, error, retry, and queue-not-found states
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

function sanitizeUiErrorMessage(msg) {
  if (typeof msg !== "string" || msg.trim().length === 0) {
    return "Failed to retrieve DLQ jobs.";
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

function formatTimestamp(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return "-";
  }
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "-";
  }
}

function renderDLQLoading(queueName) {
  return `
    <div class="state-container loading-state" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <h3 class="state-title">Loading Dead-Letter Jobs...</h3>
      <p class="state-description">Fetching failed jobs for queue <code>${escapeHtml(queueName)}</code>.</p>
    </div>
  `;
}

function renderDLQEmpty(queueName) {
  return `
    <div class="state-container empty-state" role="status">
      <div class="state-icon" aria-hidden="true">✨</div>
      <h3 class="state-title">No Dead-Letter Jobs</h3>
      <p class="state-description">
        Queue <code>${escapeHtml(queueName)}</code> has 0 dead-letter jobs.
        All enqueued tasks have either completed successfully or have not exceeded retry limits.
      </p>
    </div>
  `;
}

function renderDLQNoQueues() {
  return `
    <div class="state-container empty-state" role="status">
      <div class="state-icon" aria-hidden="true">📭</div>
      <h3 class="state-title">No Queues Registered</h3>
      <p class="state-description">
        No queues were found in the adapter registry. Register queue instances in your server configuration:
      </p>
      <div class="code-snippet">
        <code>createExpressAdapter({ queues: { "emails": emailQueue } })</code>
      </div>
    </div>
  `;
}

function renderDLQPromptSelect() {
  return `
    <div class="state-container" role="status">
      <div class="state-icon" aria-hidden="true">📋</div>
      <h3 class="state-title">Select a Queue</h3>
      <p class="state-description">
        Choose a registered queue from the dropdown above to inspect its Dead Letter Queue (DLQ).
      </p>
    </div>
  `;
}

function getDLQDiagnosticInfo(error, queueName) {
  const code = error?.code || (error?.status === 404 ? "QUEUE_NOT_FOUND" : error?.status === 503 ? "QUEUE_CLOSED" : "INTERNAL_ERROR");
  let guidance = "Check host application logs and verify Redis connectivity.";

  switch (code) {
    case "QUEUE_CLOSED":
      guidance = "The target ResilientQueue instance has been closed via queue.close(). DLQ inspection cannot proceed until the queue is restarted.";
      break;
    case "QUEUE_NOT_FOUND":
      guidance = `Queue '${queueName || "unknown"}' is not registered with the dashboard adapter. Ensure it is included in the 'queues' configuration object during adapter initialization.`;
      break;
    case "INTERNAL_ERROR":
      guidance = "An internal error occurred while querying Redis for dead-letter jobs. Check Redis status and server logs.";
      break;
    case "NETWORK_ERROR":
      guidance = "Unable to reach the dashboard API. Check your network connection and server status.";
      break;
  }

  return { code, guidance };
}

function renderDLQError(error, queueName) {
  const code = error?.code || "INTERNAL_ERROR";
  const message = sanitizeUiErrorMessage(error?.message || "Failed to retrieve DLQ jobs.");
  const isNotFound = code === "QUEUE_NOT_FOUND" || error?.status === 404;
  const diag = getDLQDiagnosticInfo(error, queueName);

  return `
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="state-icon" aria-hidden="true">⚠️</div>
      <span class="error-code-badge">${escapeHtml(code)}</span>
      <h3 class="state-title error-title">${isNotFound ? "Queue Not Found" : "Failed to Load DLQ"}</h3>
      <p class="state-description">
        ${isNotFound ? `Queue <code>${escapeHtml(queueName)}</code> is not registered with the dashboard adapter.` : escapeHtml(message)}
      </p>
      <div class="diagnostic-guidance" style="margin-top: 0.75rem; max-width: 540px; text-align: left;">
        <div class="callout callout-warning">
          <div class="callout-header"><span>Operational Diagnostic</span></div>
          <div class="callout-body">${escapeHtml(diag.guidance)}</div>
        </div>
      </div>
      <button type="button" class="btn btn-primary" id="dlq-retry-btn" aria-label="Retry loading DLQ" style="margin-top: 1rem;">
        <span>Retry</span>
      </button>
    </div>
  `;
}

function renderJobDetail(job, isCorrupted, queueName = null, index = 0) {
  const detailId = `dlq-job-detail-${index}`;
  if (isCorrupted) {
    return `
      <div id="${detailId}" class="job-detail-box" role="region" aria-label="Corrupted Job Details">
        <div class="callout callout-warning" style="margin-bottom: 0.75rem;">
          <div class="callout-header">
            <span>⚠️ Corrupted Payload Record</span>
          </div>
          <div class="callout-body">
            This entry in Redis could not be parsed as valid JSON: <code>${escapeHtml(job?.error || "Invalid JSON")}</code>.
            The raw string payload has been preserved safely below.
          </div>
        </div>
        <div class="form-label" style="margin-bottom: 0.35rem;">Raw Unparsed Content:</div>
        <pre class="job-payload-box" tabindex="0" role="region" aria-label="Raw Unparsed Content"><code>${escapeHtml(job?.raw || "")}</code></pre>
      </div>
    `;
  }

  let dataFormatted = "null";
  try {
    dataFormatted = job?.data !== undefined ? JSON.stringify(job.data, null, 2) : "null";
    if (dataFormatted === undefined) {
      dataFormatted = "undefined";
    }
  } catch {
    dataFormatted = String(job?.data);
  }

  return `
    <div id="${detailId}" class="job-detail-box" role="region" aria-label="Job Diagnostics">
      <div class="job-detail-grid">
        <div class="detail-item">
          <span class="detail-label">Job ID</span>
          <span class="detail-value font-mono">${escapeHtml(job?.id || "-")}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Attempts Made</span>
          <span class="detail-value">${typeof job?.attempt === "number" ? job.attempt : "-"}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Stalled Count</span>
          <span class="detail-value">${typeof job?.stalledCount === "number" ? job.stalledCount : "0"}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Created At</span>
          <span class="detail-value font-mono">${formatTimestamp(job?.createdAt)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Failed At</span>
          <span class="detail-value font-mono">${formatTimestamp(job?.failedAt)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Last Retried At</span>
          <span class="detail-value font-mono">${formatTimestamp(job?.retriedAt)}</span>
        </div>
      </div>

      ${
        job?.failureReason
          ? `
        <div style="margin-top: 0.75rem;">
          <div class="detail-label">Failure Diagnostics:</div>
          <div class="failure-callout">${escapeHtml(job.failureReason)}</div>
        </div>
      `
          : ""
      }

      <div style="margin-top: 0.75rem;">
        <div class="detail-label">Job Data Payload:</div>
        <pre class="job-payload-box" tabindex="0" role="region" aria-label="Job Data Payload"><code>${escapeHtml(dataFormatted)}</code></pre>
      </div>

      ${
        !isCorrupted && job?.id && queueName
          ? `
        <div style="margin-top: 0.75rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
          <span class="text-muted" style="font-size: 11px;">Record diagnostics loaded from Dead Letter Queue payload.</span>
          <a
            href="#/job?queue=${encodeURIComponent(queueName)}&jobId=${encodeURIComponent(job.id)}"
            class="btn btn-secondary btn-sm inspect-in-job-view-btn"
            data-queue="${escapeHtml(queueName)}"
            data-job-id="${escapeHtml(job.id)}"
            style="font-size: 12px;"
          >
            Inspect in Job Inspector &rarr;
          </a>
        </div>
      `
          : `
        <div class="callout callout-info" style="margin-top: 0.75rem; margin-bottom: 0;">
          <div class="callout-body" style="font-size: 11px;">
            All diagnostics above are retrieved directly from the Dead Letter Queue record.
          </div>
        </div>
      `
      }
    </div>
  `;
}

function renderDLQTable(state) {
  const { jobs = [], total = 0, start = 0, limit = 50, order = "desc", expandedJobIndex = null } = state;

  const rows = jobs.map((job, index) => {
    const isCorrupted = Boolean(!job || typeof job !== "object" || job.corrupted || job.id == null);
    const isExpanded = expandedJobIndex === index;

    let idHtml = "";
    let reasonHtml = "";
    let attemptsHtml = "";
    let failedAtHtml = "";

    if (isCorrupted) {
      idHtml = `<span class="badge badge-corrupted" title="Corrupted JSON entry">CORRUPTED</span>`;
      reasonHtml = `<span class="failure-reason-text text-danger" title="${escapeHtml(job?.error)}">${escapeHtml(job?.error || "Corrupted JSON")}</span>`;
      attemptsHtml = `<span class="text-muted">-</span>`;
      failedAtHtml = `<span class="text-muted">-</span>`;
    } else {
      idHtml = `<span class="font-mono text-primary" title="${escapeHtml(job?.id)}">${escapeHtml(job?.id)}</span>`;
      reasonHtml = `<span class="failure-reason-text" title="${escapeHtml(job?.failureReason)}">${escapeHtml(job?.failureReason || "-")}</span>`;
      const stalls = typeof job?.stalledCount === "number" && job.stalledCount > 0 ? ` (${job.stalledCount} stalls)` : "";
      const attempts = typeof job?.attempt === "number" ? job.attempt : "-";
      attemptsHtml = `<span class="metric-number">${attempts}${stalls}</span>`;
      failedAtHtml = `<span class="font-mono text-muted">${formatTimestamp(job?.failedAt)}</span>`;
    }

    const actionText = isExpanded ? "Hide Details" : isCorrupted ? "View Raw" : "Inspect";

    return `
      <tr>
        <td class="queue-name-cell">${idHtml}</td>
        <td>${attemptsHtml}</td>
        <td>${failedAtHtml}</td>
        <td>${reasonHtml}</td>
        <td style="text-align: right;">
          <button
            type="button"
            class="btn btn-secondary btn-sm dlq-inspect-btn"
            data-job-index="${index}"
            aria-expanded="${isExpanded ? "true" : "false"}"
            aria-controls="dlq-job-detail-${index}"
            aria-label="${isExpanded ? "Collapse job details" : "Inspect job details for " + escapeHtml(job?.id || "corrupted job")}"
          >
            ${actionText}
          </button>
        </td>
      </tr>
      ${
        isExpanded
          ? `
        <tr class="job-expanded-row">
          <td colspan="5" style="padding: 0;">
            ${renderJobDetail(job, isCorrupted, state.selectedQueue, index)}
          </td>
        </tr>
      `
          : ""
      }
    `;
  }).join("");

  const safeTotal = typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : jobs.length;
  const safeLimit = Math.max(1, parseInt(limit, 10) || 50);
  const safeStart = Math.max(0, parseInt(start, 10) || 0);

  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
  const currentPage = Math.floor(safeStart / safeLimit) + 1;
  const startItem = safeTotal === 0 ? 0 : Math.min(safeStart + 1, safeTotal);
  const endItem = Math.min(safeStart + jobs.length, safeTotal);

  const prevDisabled = safeStart <= 0;
  const nextDisabled = safeStart + safeLimit >= safeTotal || jobs.length < safeLimit;

  return `
    <div class="table-card">
      <div class="table-header">
        <h2 class="table-title">Dead-Letter Jobs</h2>
        <span class="nav-badge badge-amber">${total} total failed</span>
      </div>
      <div class="table-responsive">
        <table class="data-table" role="table" aria-label="Dead Letter Queue Jobs">
          <thead>
            <tr>
              <th scope="col" style="min-width: 180px;">Job ID</th>
              <th scope="col">Attempts</th>
              <th scope="col">Failed At</th>
              <th scope="col">Failure Reason</th>
              <th scope="col" style="text-align: right;">Inspection</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

      <!-- Pagination Bar -->
      <nav class="pagination-container" aria-label="DLQ Pagination Navigation">
        <div class="pagination-summary">
          Showing <strong>${startItem}–${endItem}</strong> of <strong>${total}</strong> jobs
        </div>
        <div class="pagination-actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            id="dlq-prev-btn"
            ${prevDisabled ? "disabled" : ""}
            aria-label="Go to previous page of DLQ jobs"
          >
            &larr; Previous
          </button>
          <span class="pagination-page-indicator font-mono">
            Page ${currentPage} of ${totalPages}
          </span>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            id="dlq-next-btn"
            ${nextDisabled ? "disabled" : ""}
            aria-label="Go to next page of DLQ jobs"
          >
            Next &rarr;
          </button>
        </div>
      </nav>
    </div>
  `;
}

function renderDLQView(dlqState = {}, queues = []) {
  if (!Array.isArray(queues) || queues.length === 0) {
    return renderDLQNoQueues();
  }

  const selectedQueue = dlqState.selectedQueue || "";
  const order = dlqState.order || "desc";
  const limit = dlqState.limit || 50;

  // Build queue options
  const isSelectedInQueues = queues.some((q) => q?.name === selectedQueue);
  let queueOptions = queues
    .map((q) => {
      const name = q?.name || "unknown";
      const count = q?.metrics?.dlq || 0;
      const isSelected = name === selectedQueue;
      return `<option value="${escapeHtml(name)}" ${isSelected ? "selected" : ""}>${escapeHtml(name)} (DLQ: ${count})</option>`;
    })
    .join("");

  if (selectedQueue && !isSelectedInQueues) {
    queueOptions = `<option value="${escapeHtml(selectedQueue)}" selected>${escapeHtml(selectedQueue)} (Not in registry)</option>` + queueOptions;
  }

  const toolbarHtml = `
    <section class="dlq-toolbar" aria-label="DLQ Explorer Controls">
      <div class="form-group">
        <label for="dlq-queue-select" class="form-label">Queue:</label>
        <select id="dlq-queue-select" class="form-select" aria-label="Select registered queue">
          <option value="" ${!selectedQueue ? "selected" : ""}>-- Select a Queue --</option>
          ${queueOptions}
        </select>
      </div>

      <div class="form-group">
        <label for="dlq-order-select" class="form-label">Order:</label>
        <select id="dlq-order-select" class="form-select" aria-label="Sort Order" ${!selectedQueue ? "disabled" : ""}>
          <option value="desc" ${order === "desc" ? "selected" : ""}>Newest First (desc)</option>
          <option value="asc" ${order === "asc" ? "selected" : ""}>Oldest First (asc)</option>
        </select>
      </div>

      <div class="form-group">
        <label for="dlq-limit-select" class="form-label">Per Page:</label>
        <select id="dlq-limit-select" class="form-select" aria-label="Page Size" ${!selectedQueue ? "disabled" : ""}>
          <option value="10" ${limit === 10 ? "selected" : ""}>10</option>
          <option value="25" ${limit === 25 ? "selected" : ""}>25</option>
          <option value="50" ${limit === 50 ? "selected" : ""}>50</option>
          <option value="100" ${limit === 100 ? "selected" : ""}>100</option>
        </select>
      </div>

      <div style="margin-left: auto;">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          id="dlq-refresh-btn"
          ${!selectedQueue ? "disabled" : ""}
          aria-label="Refresh current DLQ"
        >
          <span>↻ Refresh</span>
        </button>
      </div>
    </section>
  `;

  let contentHtml = "";

  if (!selectedQueue) {
    contentHtml = renderDLQPromptSelect();
  } else if (dlqState.loading) {
    contentHtml = renderDLQLoading(selectedQueue);
  } else if (dlqState.error) {
    contentHtml = renderDLQError(dlqState.error, selectedQueue);
  } else if (!Array.isArray(dlqState.jobs) || dlqState.jobs.length === 0) {
    contentHtml = renderDLQEmpty(selectedQueue);
  } else {
    contentHtml = renderDLQTable(dlqState);
  }

  return `
    ${toolbarHtml}
    ${contentHtml}
  `;
}

const DLQView = {
  render: renderDLQView,
  renderLoading: renderDLQLoading,
  renderEmpty: renderDLQEmpty,
  renderError: renderDLQError,
  renderNoQueues: renderDLQNoQueues,
  renderPromptSelect: renderDLQPromptSelect,
  renderTable: renderDLQTable,
  renderJobDetail,
  getDLQDiagnosticInfo,
  sanitizeUiErrorMessage
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = DLQView;
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueDLQView = DLQView;
}
