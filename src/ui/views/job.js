"use strict";

/**
 * Job Inspection View Component (Milestone 5 Foundation)
 *
 * COMPATIBILITY REQUIREMENT:
 * The published @mayurbhusare/resilient-queue@2.0.2 reportedly lacks `getJob()`.
 * This view explicitly displays this limitation and renders an appropriate unavailable state
 * until a compatible core release is available.
 */

function renderJobView() {
  return `
    <div class="callout callout-warning" role="alert">
      <div class="callout-header">
        <span>⚠️ Core Library Compatibility Notice: getJob() Unavailable in v2.0.2</span>
      </div>
      <div class="callout-body">
        The currently published release of <code>@mayurbhusare/resilient-queue@2.0.2</code> does not expose the <code>queue.getJob(id)</code> public method.
        Job diagnostics and execution telemetry require core library support for individual job lookups.
        <br /><br />
        <strong>Status:</strong> Job Inspection is rendered as a foundation placeholder and is <em>unavailable</em> when paired with <code>@mayurbhusare/resilient-queue@2.0.2</code>. This capability will be enabled automatically once a compatible core release providing <code>getJob()</code> is installed.
      </div>
    </div>

    <div class="table-card" style="margin-top: 1.5rem;">
      <div class="table-header">
        <h2 class="table-title">Job Diagnostics Preview</h2>
        <span class="nav-badge badge-amber">Unavailable in v2.0.2</span>
      </div>
      <div style="padding: 1.5rem;">
        <p style="color: var(--text-secondary); margin-bottom: 1.25rem; font-size: 13px;">
          Once a compatible core release is available, this view will allow inspecting individual job descriptors by unique ID:
        </p>

        <div style="display: flex; gap: 0.75rem; margin-bottom: 1.5rem; max-width: 600px;">
          <input
            type="text"
            id="job-id-search-input"
            class="code-snippet"
            placeholder="Enter Job ID (e.g. 550e8400-e29b-41d4...)"
            disabled
            aria-label="Job ID Search Input (Disabled due to core library limitation)"
            style="flex: 1; padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background-color: var(--bg-primary); color: var(--text-muted); cursor: not-allowed;"
          />
          <button
            type="button"
            class="btn btn-secondary"
            disabled
            style="cursor: not-allowed; opacity: 0.6;"
            aria-label="Search Job (Disabled)"
          >
            Inspect Job
          </button>
        </div>

        <div class="metrics-grid" style="margin-bottom: 0;">
          <div class="metric-card">
            <div class="metric-label">Execution States</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 0.35rem;">
              <code>waiting</code>, <code>active</code>, <code>delayed</code>, <code>completed</code>, <code>failed</code>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Telemetry Fields</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 0.35rem;">
              Progress (0-100%), Timestamps, Payloads, Results, Idempotency Keys
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

const JobView = {
  render: renderJobView
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = JobView;
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueJobView = JobView;
}
