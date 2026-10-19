"use strict";

/**
 * ResilientQueue Dashboard Application Controller
 * Handles routing, state management, API consumption, and view rendering.
 */

(function () {
  const ApiClientClass =
    (typeof ResilientQueueApiClient !== "undefined" && ResilientQueueApiClient.ApiClient) ||
    (typeof require === "function" ? require("./api-client").ApiClient : null);

  const OverviewView =
    (typeof ResilientQueueOverviewView !== "undefined" && ResilientQueueOverviewView) ||
    (typeof require === "function" ? require("./views/overview") : null);

  const DLQView =
    (typeof ResilientQueueDLQView !== "undefined" && ResilientQueueDLQView) ||
    (typeof require === "function" ? require("./views/dlq") : null);

  const JobView =
    (typeof ResilientQueueJobView !== "undefined" && ResilientQueueJobView) ||
    (typeof require === "function" ? require("./views/job") : null);

  class DashboardApp {
    constructor(options = {}) {
      this.containerId = options.containerId || "content-container";
      this.titleId = options.titleId || "view-title";
      this.statusDotId = options.statusDotId || "status-dot";
      this.statusTextId = options.statusTextId || "status-text";

      // Detect base URL from options, meta tag, or current URL
      let baseUrl = options.baseUrl || "";
      if (!baseUrl && typeof document !== "undefined" && typeof document.querySelector === "function") {
        const metaTag = document.querySelector('meta[name="api-base-url"]');
        if (metaTag && metaTag.content) {
          baseUrl = metaTag.content;
        } else if (typeof window !== "undefined" && window.location && typeof window.location.pathname === "string") {
          // If mounted under /admin/queues, detect basePath
          const pathname = window.location.pathname.replace(/\/ui(?:\/.*)?$/, "").replace(/\/index\.html$/, "");
          baseUrl = pathname.replace(/\/+$/, "");
        }
      }

      this.apiClient = options.apiClient || (ApiClientClass ? new ApiClientClass({ baseUrl }) : null);

      this.state = {
        activeView: "overview",
        queues: [],
        loading: false,
        error: null,
        syncError: null,
        lastUpdated: null,

        // Overview Management, Search, and Sorting State (Milestone 9)
        overview: {
          searchQuery: typeof options.searchQuery === "string" ? options.searchQuery : "",
          statusFilter: typeof options.statusFilter === "string" ? options.statusFilter : "all",
          sortKey: typeof options.sortKey === "string" ? options.sortKey : "name",
          sortOrder: typeof options.sortOrder === "string" ? options.sortOrder : "asc"
        },

        // Dead Letter Queue (DLQ) Explorer State
        dlq: {
          selectedQueue: null,
          start: 0,
          limit: 50,
          order: "desc",
          total: 0,
          jobs: [],
          loading: false,
          error: null,
          expandedJobIndex: null
        },

        // Job Inspection State
        job: {
          selectedQueue: null,
          jobId: "",
          job: null,
          loading: false,
          error: null
        }
      };

      this._queuesRequestId = 0;
      this._dlqRequestId = 0;
      this._jobRequestId = 0;

      this.pollInterval =
        options.pollInterval !== undefined
          ? options.pollInterval
          : options.pollingInterval !== undefined
          ? options.pollingInterval
          : 5000;
      if (options.autoRefresh === false) {
        this.pollInterval = 0;
      }

      this._pollTimer = null;
      this._isPolling = false;
      this._isFetchingQueues = false;
      this._inFlightQueuesCount = 0;
      this._currentQueuesPromise = null;
      this._boundBeforeUnload = null;
      this._isDestroyed = false;

      this.viewTitles = {
        overview: "Queue Overview",
        dlq: "Dead Letter Queue (DLQ)",
        job: "Job Inspection"
      };
    }

    /**
     * Initializes DOM bindings and loads initial data.
     */
    init() {
      this.bindNavigation();
      this.bindMobileToggle();
      this.bindRefresh();
      this.bindPollingControls();
      this.bindHashRouting();
      this.bindUnload();

      // Initial route from URL hash if present
      if (typeof window !== "undefined" && window.location.hash) {
        this.handleHashChange();
      }

      this.fetchQueues();

      // Start auto-refresh polling if on overview view and interval > 0
      if (this.state.activeView === "overview" && this.pollInterval > 0) {
        this.startPolling();
      }
    }

    /**
     * Starts background polling for overview metrics at the configured or specified interval.
     *
     * @param {number} [intervalMs]
     */
    startPolling(intervalMs) {
      if (typeof intervalMs === "number" && !Number.isNaN(intervalMs)) {
        this.pollInterval = Math.max(0, intervalMs);
      }
      if (this._isDestroyed || this.pollInterval <= 0 || this.state.activeView !== "overview") {
        this.stopPolling();
        return;
      }
      this._isPolling = true;
      this._scheduleNextPoll();
    }

    /**
     * Stops active background polling and clears any pending timers.
     */
    stopPolling() {
      this._isPolling = false;
      if (this._pollTimer) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
    }

    /**
     * Updates polling interval and adjusts timer state accordingly.
     *
     * @param {number|string} intervalMs
     */
    setPollInterval(intervalMs) {
      const num = parseInt(intervalMs, 10);
      this.pollInterval = !Number.isNaN(num) && num >= 0 ? num : 0;

      if (typeof document !== "undefined") {
        const select = document.getElementById("poll-interval-select");
        if (select && select.value !== String(this.pollInterval)) {
          select.value = String(this.pollInterval);
        }
      }

      if (this.pollInterval <= 0 || this.state.activeView !== "overview") {
        this.stopPolling();
      } else {
        this.startPolling();
      }
    }

    /**
     * Schedules the next polling tick using setTimeout to guarantee zero overlapping requests.
     * @private
     */
    _scheduleNextPoll() {
      if (this._pollTimer) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
      if (this._isDestroyed || !this._isPolling || this.pollInterval <= 0 || this.state.activeView !== "overview") {
        return;
      }
      this._pollTimer = setTimeout(async () => {
        this._pollTimer = null;
        await this._pollTick();
      }, this.pollInterval);

      if (this._pollTimer && typeof this._pollTimer.unref === "function") {
        this._pollTimer.unref();
      }
    }

    /**
     * Executes a single polling tick with overlap prevention.
     * @private
     */
    async _pollTick() {
      if (this._isDestroyed || !this._isPolling || this.state.activeView !== "overview") {
        return;
      }
      if (this._isFetchingQueues) {
        // Avoid overlapping requests if previous fetch is still running
        this._scheduleNextPoll();
        return;
      }

      try {
        await this.fetchQueues({ isAutoRefresh: true });
      } catch {
        // Handled inside fetchQueues
      } finally {
        if (!this._isDestroyed && this._isPolling && this.state.activeView === "overview") {
          this._scheduleNextPoll();
        }
      }
    }

    /**
     * Cleans up timers and event listeners when view or app is destroyed.
     */
    destroy() {
      this._isDestroyed = true;
      this.stopPolling();
      if (typeof window !== "undefined") {
        if (this._boundBeforeUnload) {
          window.removeEventListener("beforeunload", this._boundBeforeUnload);
          window.removeEventListener("pagehide", this._boundBeforeUnload);
          this._boundBeforeUnload = null;
        }
      }
    }

    /**
     * Fetches queue metrics from GET /api/queues and updates view.
     * Supports graceful error handling, stale response discarding, and overlap prevention.
     *
     * @param {object} [options={}]
     * @param {boolean} [options.isAutoRefresh=false]
     * @param {boolean} [options.skipIfBusy=false]
     * @param {boolean} [options.preventOverlap=false]
     */
    fetchQueues(options = {}) {
      if (!this.apiClient) {
        return Promise.resolve();
      }

      if ((options.skipIfBusy || options.preventOverlap) && this._isFetchingQueues && this._currentQueuesPromise) {
        return this._currentQueuesPromise;
      }

      this._isFetchingQueues = true;
      this._inFlightQueuesCount = (this._inFlightQueuesCount || 0) + 1;
      const requestId = ++this._queuesRequestId;
      const isAutoRefresh = Boolean(options.isAutoRefresh);

      this.state.loading = true;
      if (this.state.queues.length === 0) {
        this.state.error = null;
      }
      this.updateStatusIndicator("loading", isAutoRefresh ? "Refreshing metrics..." : "Fetching metrics...");

      if (this.state.activeView === "overview" && this.state.queues.length === 0) {
        this.renderView();
      }

      const promise = (async () => {
        try {
          const response = await this.apiClient.getQueues();
          if (this._isDestroyed || requestId !== this._queuesRequestId) {
            return; // Discard stale response or post-destruction
          }

          this.state.queues = Array.isArray(response?.queues) ? response.queues : [];
          this.state.loading = false;
          this.state.error = null;
          this.state.syncError = null;
          this.state.lastUpdated = new Date();
          this.updateStatusIndicator("online", `Connected (${this.state.queues.length} queues)`);

          // If on DLQ view without selected queue, pick a candidate (initial or manual load only, not auto-refresh)
          if (!isAutoRefresh && this.state.activeView === "dlq" && !this.state.dlq.selectedQueue && this.state.queues.length > 0) {
            const candidate = this.state.queues.find((q) => (q?.metrics?.dlq || 0) > 0) || this.state.queues[0];
            if (candidate?.name) {
              this.state.dlq.selectedQueue = candidate.name;
              this.fetchDLQ();
            }
          }

          // If on Job view without selected queue, pick a candidate (initial or manual load only)
          if (!isAutoRefresh && this.state.activeView === "job" && !this.state.job.selectedQueue && this.state.queues.length > 0) {
            this.state.job.selectedQueue = this.state.queues[0].name;
          }
        } catch (err) {
          if (this._isDestroyed || requestId !== this._queuesRequestId) {
            return; // Discard stale error or post-destruction
          }

          this.state.loading = false;
          this.state.error = err;

          if (this.state.queues.length > 0) {
            // Gracefully preserve existing data and report sync error
            this.state.syncError = err;
            this.updateStatusIndicator("offline", `Sync error: ${err.message || "Failed to refresh"}`);
          } else {
            this.updateStatusIndicator("offline", "API Error");
          }
        } finally {
          this._inFlightQueuesCount = Math.max(0, (this._inFlightQueuesCount || 1) - 1);
          if (this._inFlightQueuesCount === 0) {
            this._isFetchingQueues = false;
            this._currentQueuesPromise = null;
          }
        }

        // If an auto-refresh finishes after navigating away from overview, do not re-render the other view
        if (!this._isDestroyed && (!isAutoRefresh || this.state.activeView === "overview")) {
          this.renderView();
        }
      })();

      this._currentQueuesPromise = promise;
      return promise;
    }


    /**
     * Fetches Dead Letter Queue items for the currently selected queue.
     */
    async fetchDLQ() {
      if (this._isDestroyed || !this.apiClient || !this.state.dlq.selectedQueue) {
        return;
      }

      const requestId = ++this._dlqRequestId;
      const requestedQueue = this.state.dlq.selectedQueue;

      this.state.dlq.loading = true;
      this.state.dlq.error = null;
      if (!this._isDestroyed && this.state.activeView === "dlq") {
        this.renderView();
      }

      try {
        const response = await this.apiClient.getQueueDLQ(requestedQueue, {
          start: this.state.dlq.start,
          limit: this.state.dlq.limit,
          order: this.state.dlq.order
        });

        if (
          this._isDestroyed ||
          requestId !== this._dlqRequestId ||
          this.state.dlq.selectedQueue !== requestedQueue
        ) {
          return;
        }

        this.state.dlq.loading = false;
        this.state.dlq.jobs = Array.isArray(response?.jobs) ? response.jobs : [];
        this.state.dlq.total = typeof response?.total === "number" ? response.total : this.state.dlq.jobs.length;
        this.state.dlq.start = typeof response?.start === "number" ? response.start : this.state.dlq.start;
        this.state.dlq.limit = typeof response?.limit === "number" ? response.limit : this.state.dlq.limit;
        this.state.dlq.order = response?.order || this.state.dlq.order;
      } catch (err) {
        if (
          this._isDestroyed ||
          requestId !== this._dlqRequestId ||
          this.state.dlq.selectedQueue !== requestedQueue
        ) {
          return;
        }

        this.state.dlq.loading = false;
        this.state.dlq.error = err;
        this.state.dlq.jobs = [];
      }

      if (!this._isDestroyed && this.state.activeView === "dlq") {
        this.renderView();
      }
    }

    /**
     * Fetches job descriptor by queue and jobId from GET /api/queues/:queueName/jobs/:jobId.
     *
     * @param {string} [queueName]
     * @param {string} [jobId]
     */
    async fetchJob(queueName, jobId) {
      if (this._isDestroyed || !this.apiClient) return;

      const trimmedQueue = (typeof queueName === "string" ? queueName : (this.state.job.selectedQueue || "")).trim();
      const trimmedJobId = (typeof jobId === "string" ? jobId : (this.state.job.jobId || "")).trim();

      if (!trimmedQueue || !trimmedJobId) {
        this.state.job.selectedQueue = trimmedQueue || null;
        this.state.job.jobId = trimmedJobId;
        this.state.job.job = null;
        this.state.job.error = {
          code: "VALIDATION_ERROR",
          message: !trimmedQueue ? "Please select a registered queue." : "jobId must be a non-empty string.",
          status: 400
        };
        if (!this._isDestroyed && this.state.activeView === "job") {
          this.renderView();
        }
        return;
      }

      this.state.job.selectedQueue = trimmedQueue;
      this.state.job.jobId = trimmedJobId;
      this.state.job.loading = true;
      this.state.job.error = null;
      if (!this._isDestroyed && this.state.activeView === "job") {
        this.renderView();
      }

      const requestId = ++this._jobRequestId;

      try {
        const response = await this.apiClient.getJob(trimmedQueue, trimmedJobId);

        if (
          this._isDestroyed ||
          requestId !== this._jobRequestId ||
          this.state.job.selectedQueue !== trimmedQueue ||
          this.state.job.jobId !== trimmedJobId
        ) {
          return; // Discard stale response or post-destruction
        }

        this.state.job.loading = false;
        this.state.job.job = response?.job || null;
        this.state.job.error = null;
      } catch (err) {
        if (
          this._isDestroyed ||
          requestId !== this._jobRequestId ||
          this.state.job.selectedQueue !== trimmedQueue ||
          this.state.job.jobId !== trimmedJobId
        ) {
          return; // Discard stale error or post-destruction
        }

        this.state.job.loading = false;
        this.state.job.job = null;
        this.state.job.error = err;
      }

      if (!this._isDestroyed && this.state.activeView === "job") {
        this.renderView();
      }
    }

    /**
     * Updates top-bar status dot and text.
     */
    updateStatusIndicator(state, text) {
      if (typeof document === "undefined") return;

      const dot = document.getElementById(this.statusDotId);
      const label = document.getElementById(this.statusTextId);

      if (dot) {
        dot.className = "status-dot";
        if (state === "loading") dot.classList.add("loading");
        if (state === "offline") dot.classList.add("offline");
      }

      if (label && text) {
        label.textContent = text;
      }
    }

    /**
     * Switches the active navigation view.
     *
     * @param {"overview"|"dlq"|"job"} viewName
     * @param {object} [params={}] Optional routing parameters (e.g. { queue: "emails" })
     */
    navigate(viewName, params = {}) {
      if (!this.viewTitles[viewName]) {
        viewName = "overview";
      }

      const previousView = this.state.activeView;
      this.state.activeView = viewName;

      // Timer cleanup when navigating away from overview monitoring view
      if (previousView === "overview" && viewName !== "overview") {
        this.stopPolling();
      } else if (viewName === "overview" && previousView !== "overview" && this.pollInterval > 0) {
        this.startPolling();
      }

      if (viewName === "dlq") {
        if (params.queue) {
          this.state.dlq.selectedQueue = params.queue;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        } else if (!this.state.dlq.selectedQueue && this.state.queues.length > 0) {
          const candidate = this.state.queues.find((q) => (q?.metrics?.dlq || 0) > 0) || this.state.queues[0];
          if (candidate?.name) {
            this.state.dlq.selectedQueue = candidate.name;
            this.state.dlq.start = 0;
            this.state.dlq.expandedJobIndex = null;
            this.fetchDLQ();
          }
        }
      }

      if (viewName === "job") {
        if (params.queue) {
          this.state.job.selectedQueue = params.queue;
        } else if (!this.state.job.selectedQueue && this.state.queues.length > 0) {
          this.state.job.selectedQueue = this.state.queues[0].name;
        }

        if (params.jobId) {
          this.state.job.jobId = params.jobId;
          this.fetchJob(this.state.job.selectedQueue, params.jobId);
        }
      }

      if (typeof window !== "undefined" && window.location) {
        let hash = `#/${viewName}`;
        if (viewName === "dlq" && this.state.dlq.selectedQueue) {
          hash += `?queue=${encodeURIComponent(this.state.dlq.selectedQueue)}`;
        } else if (viewName === "job" && this.state.job.selectedQueue) {
          hash += `?queue=${encodeURIComponent(this.state.job.selectedQueue)}`;
          if (this.state.job.jobId) {
            hash += `&jobId=${encodeURIComponent(this.state.job.jobId)}`;
          }
        }
        window.location.hash = hash;
      }

      this.updateNavigationUI();
      this.renderView();
      this.closeMobileSidebar();
    }

    /**
     * Updates active styling and ARIA attributes on sidebar links.
     */
    updateNavigationUI() {
      if (typeof document === "undefined") return;

      const navButtons = document.querySelectorAll(".sidebar-nav .nav-link");
      navButtons.forEach((btn) => {
        const targetView = btn.getAttribute("data-view");
        if (targetView === this.state.activeView) {
          btn.classList.add("active");
          btn.setAttribute("aria-current", "page");
        } else {
          btn.classList.remove("active");
          btn.removeAttribute("aria-current");
        }
      });

      const titleEl = document.getElementById(this.titleId);
      if (titleEl) {
        titleEl.textContent = this.viewTitles[this.state.activeView] || "Dashboard";
      }
    }

    /**
     * Renders active view into content container.
     */
    renderView() {
      if (this._isDestroyed || typeof document === "undefined") return;

      const container = document.getElementById(this.containerId);
      if (!container) return;

      const activeElementId = document.activeElement ? document.activeElement.id : null;
      const cursorStart =
        activeElementId === "overview-search-input" && typeof document.activeElement.selectionStart === "number"
          ? document.activeElement.selectionStart
          : null;
      const cursorEnd =
        activeElementId === "overview-search-input" && typeof document.activeElement.selectionEnd === "number"
          ? document.activeElement.selectionEnd
          : null;
      const activeJobIndex = document.activeElement && document.activeElement.classList?.contains("dlq-inspect-btn")
        ? document.activeElement.getAttribute("data-job-index")
        : null;

      let html = "";

      if (this.state.activeView === "overview") {
        if (this.state.loading && this.state.queues.length === 0) {
          html = OverviewView.renderLoading();
        } else if (this.state.error && this.state.queues.length === 0) {
          html = OverviewView.renderError(this.state.error);
        } else {
          html = OverviewView.renderData(this.state.queues, {
            lastUpdated: this.state.lastUpdated,
            syncError: this.state.syncError,
            pollInterval: this.pollInterval,
            isPolling: this._isPolling,
            loading: this.state.loading,
            searchQuery: this.state.overview?.searchQuery || "",
            statusFilter: this.state.overview?.statusFilter || "all",
            sortKey: this.state.overview?.sortKey || "name",
            sortOrder: this.state.overview?.sortOrder || "asc"
          });
        }
      } else if (this.state.activeView === "dlq") {
        html = DLQView.render(this.state.dlq, this.state.queues);
      } else if (this.state.activeView === "job") {
        html = JobView.render(this.state.job, this.state.queues);
      }

      container.innerHTML = html;
      this.bindViewEvents();

      // Restore active focus and cursor position if the element was re-rendered
      if (activeElementId) {
        const el = document.getElementById(activeElementId);
        if (el && typeof el.focus === "function") {
          el.focus();
          if (cursorStart !== null && typeof el.setSelectionRange === "function") {
            try {
              el.setSelectionRange(cursorStart, cursorEnd);
            } catch {
              // ignore
            }
          }
        }
      } else if (activeJobIndex !== null) {
        const el = document.querySelector(`.dlq-inspect-btn[data-job-index="${activeJobIndex}"]`);
        if (el && typeof el.focus === "function") {
          el.focus();
        }
      }
    }

    /**
     * Attaches interactive event handlers to currently rendered view elements.
     */
    bindViewEvents() {
      if (typeof document === "undefined") return;

      // Overview search input
      const searchInput = document.getElementById("overview-search-input");
      if (searchInput) {
        searchInput.addEventListener("input", (e) => {
          this.state.overview.searchQuery = e.target.value;
          this.renderView();
        });
      }

      // Overview status select
      const statusSelect = document.getElementById("overview-status-select");
      if (statusSelect) {
        statusSelect.addEventListener("change", (e) => {
          this.state.overview.statusFilter = e.target.value;
          this.renderView();
        });
      }

      // Overview clear filters buttons (toolbar and empty-filter state card)
      const clearFilterBtns = document.querySelectorAll(
        ".overview-clear-btn, #overview-clear-filters-btn, #overview-reset-filters-btn"
      );
      clearFilterBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          this.state.overview.searchQuery = "";
          this.state.overview.statusFilter = "all";
          this.renderView();
        });
      });

      // Overview sort header buttons
      const sortBtns = document.querySelectorAll(".sort-header-btn");
      sortBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-sort-key");
          if (!key) return;
          if (this.state.overview.sortKey === key) {
            this.state.overview.sortOrder = this.state.overview.sortOrder === "asc" ? "desc" : "asc";
          } else {
            this.state.overview.sortKey = key;
            this.state.overview.sortOrder = (key === "waiting" || key === "active" || key === "delayed" || key === "dlq") ? "desc" : "asc";
          }
          this.renderView();
        });
      });

      // Overview table direct navigation action buttons
      const overviewDlqBtns = document.querySelectorAll(".overview-dlq-btn");
      overviewDlqBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const queueName = btn.getAttribute("data-queue");
          if (queueName) {
            this.navigate("dlq", { queue: queueName });
          }
        });
      });

      const overviewJobBtns = document.querySelectorAll(".overview-job-btn");
      overviewJobBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const queueName = btn.getAttribute("data-queue");
          if (queueName) {
            this.navigate("job", { queue: queueName });
          }
        });
      });

      // Retry overview button (initial error state)
      const retryOverviewBtn = document.getElementById("retry-overview-btn");
      if (retryOverviewBtn) {
        retryOverviewBtn.addEventListener("click", () => {
          this.fetchQueues();
        });
      }

      // Retry overview sync button (temporary failure banner)
      const retryOverviewSyncBtn = document.getElementById("retry-overview-sync-btn");
      if (retryOverviewSyncBtn) {
        retryOverviewSyncBtn.addEventListener("click", () => {
          this.fetchQueues();
        });
      }

      // Overview table "View DLQ" badges
      const dlqLinks = document.querySelectorAll(".view-dlq-link");
      dlqLinks.forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const queueName = link.getAttribute("data-queue");
          if (queueName) {
            this.navigate("dlq", { queue: queueName });
          }
        });
      });

      // DLQ Explorer Queue Select
      const queueSelect = document.getElementById("dlq-queue-select");
      if (queueSelect) {
        queueSelect.addEventListener("change", (e) => {
          const val = e.target.value.trim();
          this.state.dlq.selectedQueue = val || null;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          if (typeof window !== "undefined" && window.location) {
            window.location.hash = this.state.dlq.selectedQueue
              ? `#/dlq?queue=${encodeURIComponent(this.state.dlq.selectedQueue)}`
              : "#/dlq";
          }
          if (this.state.dlq.selectedQueue) {
            this.fetchDLQ();
          } else {
            this.renderView();
          }
        });
      }

      // DLQ Explorer Order Select
      const orderSelect = document.getElementById("dlq-order-select");
      if (orderSelect) {
        orderSelect.addEventListener("change", (e) => {
          this.state.dlq.order = e.target.value;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Limit Select
      const limitSelect = document.getElementById("dlq-limit-select");
      if (limitSelect) {
        limitSelect.addEventListener("change", (e) => {
          this.state.dlq.limit = parseInt(e.target.value, 10) || 50;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Refresh Button
      const dlqRefreshBtn = document.getElementById("dlq-refresh-btn");
      if (dlqRefreshBtn) {
        dlqRefreshBtn.addEventListener("click", () => {
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Retry Button
      const dlqRetryBtn = document.getElementById("dlq-retry-btn");
      if (dlqRetryBtn) {
        dlqRetryBtn.addEventListener("click", () => {
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Previous Page Button
      const dlqPrevBtn = document.getElementById("dlq-prev-btn");
      if (dlqPrevBtn) {
        dlqPrevBtn.addEventListener("click", () => {
          if (this.state.dlq.start > 0) {
            this.state.dlq.start = Math.max(0, this.state.dlq.start - this.state.dlq.limit);
            this.state.dlq.expandedJobIndex = null;
            this.fetchDLQ();
          }
        });
      }

      // DLQ Explorer Next Page Button
      const dlqNextBtn = document.getElementById("dlq-next-btn");
      if (dlqNextBtn) {
        dlqNextBtn.addEventListener("click", () => {
          this.state.dlq.start = this.state.dlq.start + this.state.dlq.limit;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Job Detail Toggle Buttons
      const inspectBtns = document.querySelectorAll(".dlq-inspect-btn");
      inspectBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const idxStr = btn.getAttribute("data-job-index");
          const idx = parseInt(idxStr, 10);
          if (!Number.isNaN(idx)) {
            this.state.dlq.expandedJobIndex = this.state.dlq.expandedJobIndex === idx ? null : idx;
            this.renderView();
          }
        });
      });

      // Job Inspector Search Form
      const jobSearchForm = document.getElementById("job-search-form");
      if (jobSearchForm) {
        jobSearchForm.addEventListener("submit", (e) => {
          e.preventDefault();
          const queueSelect = document.getElementById("job-queue-select");
          const jobIdInput = document.getElementById("job-id-input");
          const queueName = queueSelect ? queueSelect.value.trim() : (this.state.job.selectedQueue || "");
          const jobId = jobIdInput ? jobIdInput.value.trim() : "";
          if (typeof window !== "undefined" && window.location && queueName && jobId) {
            window.location.hash = `#/job?queue=${encodeURIComponent(queueName)}&jobId=${encodeURIComponent(jobId)}`;
          }
          this.fetchJob(queueName, jobId);
        });
      }

      // Job Inspector Queue Select change
      const jobQueueSelect = document.getElementById("job-queue-select");
      if (jobQueueSelect) {
        jobQueueSelect.addEventListener("change", (e) => {
          this.state.job.selectedQueue = e.target.value.trim() || null;
          this.state.job.job = null;
          this.state.job.error = null;
          if (typeof window !== "undefined" && window.location) {
            window.location.hash = this.state.job.selectedQueue
              ? `#/job?queue=${encodeURIComponent(this.state.job.selectedQueue)}`
              : `#/job`;
          }
          this.renderView();
        });
      }

      // Job Inspector Retry Button
      const jobRetryBtn = document.getElementById("job-retry-btn");
      if (jobRetryBtn) {
        jobRetryBtn.addEventListener("click", () => {
          this.fetchJob(this.state.job.selectedQueue, this.state.job.jobId);
        });
      }

      // Job Inspector Clear Search Button
      const jobClearBtn = document.getElementById("job-clear-btn");
      if (jobClearBtn) {
        jobClearBtn.addEventListener("click", () => {
          this.state.job.jobId = "";
          this.state.job.job = null;
          this.state.job.error = null;
          if (typeof window !== "undefined" && window.location) {
            window.location.hash = `#/job?queue=${encodeURIComponent(this.state.job.selectedQueue || "")}`;
          }
          this.renderView();
        });
      }

      // Cross-link from DLQ Explorer to Job Inspector
      const inspectInJobBtns = document.querySelectorAll(".inspect-in-job-view-btn");
      inspectInJobBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const qName = btn.getAttribute("data-queue");
          const jId = btn.getAttribute("data-job-id");
          if (qName && jId) {
            this.navigate("job", { queue: qName, jobId: jId });
          }
        });
      });
    }

    /**
     * Binds click events on sidebar navigation links.
     */
    bindNavigation() {
      if (typeof document === "undefined") return;

      const navLinks = document.querySelectorAll(".sidebar-nav .nav-link");
      navLinks.forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const view = link.getAttribute("data-view");
          if (view) {
            this.navigate(view);
          }
        });
      });
    }

    /**
     * Binds mobile hamburger toggle and backdrop overlay.
     */
    bindMobileToggle() {
      if (typeof document === "undefined") return;

      const toggle = document.getElementById("mobile-toggle-btn");
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("mobile-backdrop");

      if (toggle && sidebar) {
        toggle.addEventListener("click", () => {
          const isOpen = sidebar.classList.contains("open");
          if (isOpen) {
            this.closeMobileSidebar();
          } else {
            sidebar.classList.add("open");
            toggle.setAttribute("aria-expanded", "true");
            if (backdrop) backdrop.classList.add("open");
          }
        });
      }

      if (backdrop) {
        backdrop.addEventListener("click", () => {
          this.closeMobileSidebar();
        });
      }

      // Escape key to close mobile menu
      if (typeof document.addEventListener === "function") {
        document.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            this.closeMobileSidebar();
          }
        });
      }
    }

    closeMobileSidebar() {
      if (typeof document === "undefined") return;
      const sidebar = document.getElementById("sidebar");
      const toggle = document.getElementById("mobile-toggle-btn");
      const backdrop = document.getElementById("mobile-backdrop");

      if (sidebar) sidebar.classList.remove("open");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
      if (backdrop) backdrop.classList.remove("open");
    }

    /**
     * Binds top-bar refresh button.
     */
    bindRefresh() {
      if (typeof document === "undefined") return;

      const refreshBtn = document.getElementById("refresh-btn");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          this.fetchQueues();
          if (this.state.activeView === "dlq" && this.state.dlq.selectedQueue) {
            this.fetchDLQ();
          } else if (this.state.activeView === "job" && this.state.job.selectedQueue && this.state.job.jobId) {
            this.fetchJob(this.state.job.selectedQueue, this.state.job.jobId);
          }
        });
      }
    }

    /**
     * Parses and handles browser URL hash navigation (e.g. #/dlq?queue=emails or #/job?queue=emails&jobId=...).
     */
    handleHashChange() {
      if (typeof window === "undefined" || !window.location.hash) return;

      const raw = window.location.hash.replace(/^#\/?/, "");
      let view = raw;
      let queueParam = null;
      let jobIdParam = null;

      if (raw.startsWith("dlq/")) {
        view = "dlq";
        try {
          queueParam = decodeURIComponent(raw.slice(4));
        } catch {
          queueParam = raw.slice(4);
        }
      } else if (raw.startsWith("job/")) {
        view = "job";
        const parts = raw.slice(4).split("/");
        try {
          queueParam = decodeURIComponent(parts[0] || "");
        } catch {
          queueParam = parts[0] || "";
        }
        try {
          jobIdParam = decodeURIComponent(parts.slice(1).join("/") || "");
        } catch {
          jobIdParam = parts.slice(1).join("/") || "";
        }
      } else if (raw.includes("?")) {
        const [viewPart, queryPart] = raw.split("?");
        view = viewPart;
        try {
          const params = new URLSearchParams(queryPart);
          queueParam = params.get("queue");
          jobIdParam = params.get("jobId");
        } catch {
          // ignore malformed query
        }
      }

      if (view && this.viewTitles[view]) {
        // Avoid redundant navigations if view and queue/jobId already match current state
        if (
          this.state.activeView === view &&
          (view === "overview" ||
            (view === "dlq" && (!queueParam || this.state.dlq.selectedQueue === queueParam)) ||
            (view === "job" &&
              (!queueParam || this.state.job.selectedQueue === queueParam) &&
              (!jobIdParam || this.state.job.jobId === jobIdParam)))
        ) {
          return;
        }
        this.navigate(view, { queue: queueParam, jobId: jobIdParam });
      }
    }

    /**
     * Binds change events on the auto-refresh interval select element.
     */
    bindPollingControls() {
      if (typeof document === "undefined") return;

      const select = document.getElementById("poll-interval-select");
      if (select) {
        select.value = String(this.pollInterval);
        select.addEventListener("change", (e) => {
          this.setPollInterval(e.target.value);
        });
      }
    }

    /**
     * Listens for browser URL hash changes for lightweight SPA routing.
     */
    bindHashRouting() {
      if (typeof window === "undefined") return;

      window.addEventListener("hashchange", () => {
        this.handleHashChange();
      });
    }

    /**
     * Binds beforeunload and pagehide events to ensure timers are cleared on teardown.
     */
    bindUnload() {
      if (typeof window === "undefined") return;

      this._boundBeforeUnload = () => {
        this.destroy();
      };
      window.addEventListener("beforeunload", this._boundBeforeUnload);
      window.addEventListener("pagehide", this._boundBeforeUnload);
    }
  }

  // Universal export
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { DashboardApp };
  }

  if (typeof globalThis !== "undefined") {
    globalThis.ResilientQueueDashboardApp = DashboardApp;
  }

  // Auto-initialize when running in browser document
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        const app = new DashboardApp();
        app.init();
        globalThis.__rqDashboardApp = app;
      });
    } else {
      const app = new DashboardApp();
      app.init();
      globalThis.__rqDashboardApp = app;
    }
  }
})();
