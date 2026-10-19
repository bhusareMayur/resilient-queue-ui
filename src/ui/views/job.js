"use strict";

/**
 * Job Inspection View Component (Milestone 7)
 *
 * Full functional, read-only Job Inspector for querying individual job descriptors,
 * lifecycle state, execution progress percentage, timing metadata, failure diagnostics,
 * user payload, and return value.
 *
 * Conforms to `GET /api/queues/:queueName/jobs/:jobId` in docs/api-contract.md.
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
    return "Failed to retrieve job descriptor.";
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
  if (!ts) return "-";
  const num = typeof ts === "number" ? ts : (ts instanceof Date ? ts.getTime() : Date.parse(ts));
  if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
    return "-";
  }
  try {
    const d = new Date(num);
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

function formatJson(val) {
  if (val === undefined) return "undefined";
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function formatRetention(retention) {
  if (retention === true) return "Remove immediately";
  if (retention === false) return "Keep indefinitely";
  if (typeof retention === "number") return `Keep latest ${retention} jobs`;
  if (typeof retention === "object" && retention !== null) {
    try {
      return JSON.stringify(retention);
    } catch {
      return String(retention);
    }
  }
  return "-";
}

function renderJobLoading(queueName, jobId) {
  return `
    <div class="state-container loading-state" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <h3 class="state-title">Inspecting Job...</h3>
      <p class="state-description">
        Fetching lifecycle descriptor and telemetry for job <code>${escapeHtml(jobId)}</code> from queue <code>${escapeHtml(queueName)}</code>.
      </p>
    </div>
  `;
}

function renderJobPromptSelect() {
  return `
    <div class="state-container" role="status">
      <div class="state-icon" aria-hidden="true">🔍</div>
      <h3 class="state-title">Inspect a Job</h3>
      <p class="state-description">
        Select a registered queue and enter a unique Job ID above to inspect its execution lifecycle, progress, timing, and payload.
      </p>
    </div>
  `;
}

function renderJobNoQueues() {
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

function renderJobNotFound(queueName, jobId) {
  return `
    <div class="state-container" role="status" aria-live="polite">
      <div class="state-icon" aria-hidden="true">🔎</div>
      <span class="error-code-badge badge-amber">JOB_NOT_FOUND</span>
      <h3 class="state-title">Job Not Found</h3>
      <p class="state-description">
        Job <code>${escapeHtml(jobId)}</code> was not found in queue <code>${escapeHtml(queueName)}</code>.
        It may never have existed or has expired under retention policy (<code>removeOnComplete</code> / <code>removeOnFail</code>).
      </p>
    </div>
  `;
}

function renderJobQueueNotFound(queueName) {
  return `
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="state-icon" aria-hidden="true">⚠️</div>
      <span class="error-code-badge">QUEUE_NOT_FOUND</span>
      <h3 class="state-title error-title">Queue Not Registered</h3>
      <p class="state-description">
        Queue <code>${escapeHtml(queueName)}</code> is not registered with the dashboard adapter.
      </p>
    </div>
  `;
}

function renderJobValidationError(error, queueName, jobId) {
  return `
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="state-icon" aria-hidden="true">⚠️</div>
      <span class="error-code-badge">VALIDATION_ERROR</span>
      <h3 class="state-title error-title">Invalid Search Parameter</h3>
      <p class="state-description">${escapeHtml(error?.message || "Please provide a valid queue and non-empty jobId.")}</p>
    </div>
  `;
}

function renderJobCompatibilityWarning(queueName) {
  return `
    <div class="callout callout-warning" role="alert">
      <div class="callout-header">
        <span>⚠️ Core Library Compatibility: getJob() Not Supported</span>
      </div>
      <div class="callout-body">
        Queue <code>${escapeHtml(queueName)}</code> does not implement the public <code>getJob(id)</code> API.
        Published <code>@mayurbhusare/resilient-queue@2.0.2</code> does not expose individual job lookups; live job inspection requires an updated core release or a compatible queue provider.
      </div>
    </div>
  `;
}

function getJobDiagnosticInfo(error, queueName, jobId) {
  const code = error?.code || (error?.status === 404 ? "JOB_NOT_FOUND" : error?.status === 503 ? "QUEUE_CLOSED" : error?.status === 501 ? "NOT_SUPPORTED" : "INTERNAL_ERROR");
  let guidance = "Check host server logs and verify Redis connectivity.";

  switch (code) {
    case "QUEUE_CLOSED":
      guidance = "The target queue instance has been closed via queue.close(). Operations are suspended until the application restarts the queue.";
      break;
    case "NOT_SUPPORTED":
      guidance = "The installed version of @mayurbhusare/resilient-queue does not expose getJob(). Upgrade to a compatible core package release.";
      break;
    case "JOB_NOT_FOUND":
      guidance = "Verify that the Job ID is correct. If the job was recently completed or failed, verify retention settings (removeOnComplete / removeOnFail).";
      break;
    case "QUEUE_NOT_FOUND":
      guidance = `Queue '${queueName || "unknown"}' is not registered with the dashboard adapter. Check your server adapter configuration.`;
      break;
    case "VALIDATION_ERROR":
      guidance = "Job ID must be a non-empty string. Verify search input parameters.";
      break;
    case "INTERNAL_ERROR":
      guidance = "An internal error occurred while retrieving the job from Redis. Check Redis connectivity and server logs.";
      break;
  }

  return { code, guidance };
}

function renderJobError(error, queueName, jobId) {
  const code = error?.code || "INTERNAL_ERROR";
  const message = sanitizeUiErrorMessage(error?.message || "Failed to retrieve job descriptor.");
  const diag = getJobDiagnosticInfo(error, queueName, jobId);

  return `
    <div class="state-container error-state" role="alert" aria-live="assertive">
      <div class="state-icon" aria-hidden="true">⚠️</div>
      <span class="error-code-badge">${escapeHtml(code)}</span>
      <h3 class="state-title error-title">Failed to Inspect Job</h3>
      <p class="state-description">${escapeHtml(message)}</p>
      <div class="diagnostic-guidance" style="margin-top: 0.75rem; max-width: 540px; text-align: left;">
        <div class="callout callout-warning">
          <div class="callout-header"><span>Operational Diagnostic</span></div>
          <div class="callout-body">${escapeHtml(diag.guidance)}</div>
        </div>
      </div>
      <button type="button" class="btn btn-primary" id="job-retry-btn" aria-label="Retry inspecting job" style="margin-top: 1rem;">
        <span>Retry</span>
      </button>
    </div>
  `;
}

function getStateBadgeClass(state) {
  switch (state) {
    case "completed":
      return "badge-completed";
    case "failed":
      return "badge-failed";
    case "active":
      return "badge-active";
    case "delayed":
      return "badge-delayed";
    case "waiting":
    default:
      return "badge-waiting";
  }
}

function renderJobDetails(job, queueName) {
  const state = job?.state || "unknown";
  const stateBadgeClass = getStateBadgeClass(state);
  const hasProgress = typeof job?.progress === "number" && Number.isFinite(job.progress) && job.progress >= 0;
  const progressClamped = hasProgress ? Math.min(100, Math.max(0, Math.round(job.progress))) : 0;

  const failureMessage = job?.failureReason || job?.lastError;
  const hasResult = job?.result !== undefined || job?.returnValue !== undefined;
  const resultValue = job?.result !== undefined ? job.result : job?.returnValue;

  return `
    <div class="table-card" role="region" aria-label="Job Inspection Details">
      <div class="table-header" style="flex-wrap: wrap; gap: 0.5rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
          <h2 class="table-title font-mono" style="margin: 0; font-size: 15px;">${escapeHtml(job?.id)}</h2>
          <span class="badge ${stateBadgeClass}" aria-label="State: ${escapeHtml(state)}">${escapeHtml(state)}</span>
        </div>
        <span class="nav-badge font-mono">Queue: ${escapeHtml(queueName)}</span>
      </div>

      <div style="padding: 1.25rem;">
        ${
          hasProgress
            ? `
          <div class="progress-container" aria-label="Job Execution Progress">
            <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 0.35rem;">
              <span class="detail-label">Execution Progress</span>
              <span class="font-mono" style="font-weight: 600; color: var(--text-primary);">${progressClamped}%</span>
            </div>
            <div class="progress-bar" role="progressbar" aria-valuenow="${progressClamped}" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-fill" style="width: ${progressClamped}%;"></div>
            </div>
          </div>
        `
            : ""
        }

        ${
          failureMessage
            ? `
          <div style="margin-bottom: 1.25rem;">
            <div class="detail-label" style="color: var(--status-error);">Failure Diagnostics:</div>
            <div class="failure-callout">${escapeHtml(failureMessage)}</div>
          </div>
        `
            : ""
        }

        <div class="detail-label" style="margin-bottom: 0.5rem;">Job Lifecycle & Timing Metadata</div>
        <div class="job-detail-grid">
          <div class="detail-item">
            <span class="detail-label">State</span>
            <span class="detail-value font-mono">${escapeHtml(state)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Attempts Made</span>
            <span class="detail-value font-mono">${typeof job?.attempt === "number" ? job.attempt : "-"}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Stalled Count</span>
            <span class="detail-value font-mono">${typeof job?.stalledCount === "number" ? job.stalledCount : "0"}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Created At</span>
            <span class="detail-value font-mono">${formatTimestamp(job?.createdAt)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Started At</span>
            <span class="detail-value font-mono">${formatTimestamp(job?.startedAt)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Completed At</span>
            <span class="detail-value font-mono">${formatTimestamp(job?.completedAt)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Failed At</span>
            <span class="detail-value font-mono">${formatTimestamp(job?.failedAt)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Last Retried At</span>
            <span class="detail-value font-mono">${formatTimestamp(job?.retriedAt)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Last Stalled At</span>
            <span class="detail-value font-mono">${formatTimestamp(job?.lastStalledAt)}</span>
          </div>
          ${
            job?.runAt
              ? `
            <div class="detail-item">
              <span class="detail-label">Scheduled Run At</span>
              <span class="detail-value font-mono">${formatTimestamp(job.runAt)}</span>
            </div>
          `
              : ""
          }
          ${
            typeof job?.delay === "number"
              ? `
            <div class="detail-item">
              <span class="detail-label">Configured Delay</span>
              <span class="detail-value font-mono">${job.delay}ms</span>
            </div>
          `
              : ""
          }
          ${
            job?.idempotencyKey
              ? `
            <div class="detail-item">
              <span class="detail-label">Idempotency Key</span>
              <span class="detail-value font-mono">${escapeHtml(job.idempotencyKey)}</span>
            </div>
          `
              : ""
          }
          ${
            typeof job?.ttlSeconds === "number"
              ? `
            <div class="detail-item">
              <span class="detail-label">Key TTL</span>
              <span class="detail-value font-mono">${job.ttlSeconds}s</span>
            </div>
          `
              : ""
          }
          ${
            job?.removeOnComplete !== undefined
              ? `
            <div class="detail-item">
              <span class="detail-label">Retention (Complete)</span>
              <span class="detail-value font-mono">${escapeHtml(formatRetention(job.removeOnComplete))}</span>
            </div>
          `
              : ""
          }
          ${
            job?.removeOnFail !== undefined
              ? `
            <div class="detail-item">
              <span class="detail-label">Retention (Fail)</span>
              <span class="detail-value font-mono">${escapeHtml(formatRetention(job.removeOnFail))}</span>
            </div>
          `
              : ""
          }
        </div>

        <div style="margin-top: 1.25rem;">
          <div class="detail-label">Job Payload (Data):</div>
          <pre class="job-payload-box"><code>${escapeHtml(formatJson(job?.data))}</code></pre>
        </div>

        ${
          hasResult
            ? `
          <div style="margin-top: 1.25rem;">
            <div class="detail-label">Result (Return Value):</div>
            <pre class="job-payload-box"><code>${escapeHtml(formatJson(resultValue))}</code></pre>
          </div>
        `
            : ""
        }
      </div>
    </div>
  `;
}

function renderJobSearchToolbar(state = {}, queues = [], selectedQueue = "") {
  const isSelectedInQueues = queues.some((q) => q?.name === selectedQueue);
  let queueOptions = queues
    .map((q) => {
      const name = q?.name || "unknown";
      const isSelected = name === selectedQueue;
      return `<option value="${escapeHtml(name)}" ${isSelected ? "selected" : ""}>${escapeHtml(name)}</option>`;
    })
    .join("");

  if (selectedQueue && !isSelectedInQueues) {
    queueOptions = `<option value="${escapeHtml(selectedQueue)}" selected>${escapeHtml(selectedQueue)} (Not in registry)</option>` + queueOptions;
  }

  const hasActiveSearch = Boolean(state.job || state.error || (state.jobId && state.jobId.trim().length > 0));

  return `
    <section class="dlq-toolbar job-search-toolbar" aria-label="Job Inspector Controls">
      <form id="job-search-form" class="job-search-form" role="search" aria-label="Job Search Form">
        <div class="form-group">
          <label for="job-queue-select" class="form-label">Queue:</label>
          <select id="job-queue-select" class="form-select" aria-label="Select registered queue">
            ${queueOptions}
          </select>
        </div>

        <div class="form-group" style="flex: 1; min-width: 240px;">
          <label for="job-id-input" class="form-label">Job ID:</label>
          <input
            type="text"
            id="job-id-input"
            class="form-input font-mono"
            placeholder="Enter Job ID (e.g. 550e8400-e29b-41d4...)"
            value="${escapeHtml(state.jobId || "")}"
            aria-label="Job ID to inspect"
            required
          />
        </div>

        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button
            type="submit"
            id="job-search-btn"
            class="btn btn-primary btn-sm"
            aria-label="Inspect Job"
          >
            <span>Inspect</span>
          </button>
          ${
            hasActiveSearch
              ? `
            <button
              type="button"
              id="job-clear-btn"
              class="btn btn-secondary btn-sm"
              aria-label="Clear active job search"
            >
              <span>Clear</span>
            </button>
          `
              : ""
          }
        </div>
      </form>
    </section>
  `;
}

function renderJobView(jobState = {}, queues = []) {
  if (!Array.isArray(queues) || queues.length === 0) {
    return renderJobNoQueues();
  }

  const selectedQueue = jobState.selectedQueue || (queues[0]?.name || "");
  const jobId = jobState.jobId || "";

  const toolbarHtml = renderJobSearchToolbar(jobState, queues, selectedQueue);

  let contentHtml = "";

  if (jobState.loading) {
    contentHtml = renderJobLoading(selectedQueue, jobId);
  } else if (jobState.error) {
    const error = jobState.error;
    const code = error?.code || "";
    const status = error?.status || error?.statusCode;

    if (code === "NOT_SUPPORTED" || status === 501) {
      contentHtml = renderJobCompatibilityWarning(selectedQueue);
    } else if (
      code === "QUEUE_NOT_FOUND" ||
      (typeof error?.message === "string" && /queue.*not registered/i.test(error.message))
    ) {
      contentHtml = renderJobQueueNotFound(selectedQueue);
    } else if (code === "JOB_NOT_FOUND" || status === 404) {
      contentHtml = renderJobNotFound(selectedQueue, jobId);
    } else if (code === "VALIDATION_ERROR" || status === 400) {
      contentHtml = renderJobValidationError(error, selectedQueue, jobId);
    } else {
      contentHtml = renderJobError(error, selectedQueue, jobId);
    }
  } else if (jobState.job) {
    contentHtml = renderJobDetails(jobState.job, selectedQueue);
  } else {
    contentHtml = renderJobPromptSelect();
  }

  return `
    ${toolbarHtml}
    ${contentHtml}
  `;
}

const JobView = {
  render: renderJobView,
  renderLoading: renderJobLoading,
  renderPromptSelect: renderJobPromptSelect,
  renderNoQueues: renderJobNoQueues,
  renderNotFound: renderJobNotFound,
  renderQueueNotFound: renderJobQueueNotFound,
  renderValidationError: renderJobValidationError,
  renderCompatibilityWarning: renderJobCompatibilityWarning,
  renderError: renderJobError,
  renderJobDetails,
  renderSearchToolbar: renderJobSearchToolbar,
  getJobDiagnosticInfo,
  sanitizeUiErrorMessage
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = JobView;
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueJobView = JobView;
}
