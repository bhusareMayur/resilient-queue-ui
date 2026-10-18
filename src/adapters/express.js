"use strict";

const {
  createDashboardDispatcher,
  createErrorResponse,
  sendJson
} = require("../dispatcher");

/**
 * Creates an Express / Connect middleware adapter for the dashboard.
 *
 * @param {import("../dispatcher").DashboardAdapterOptions} options
 * @returns {function(req: object, res: object, next: function): void}
 */
function createExpressAdapter(options) {
  const dispatcher = createDashboardDispatcher(options);

  return function expressAdapter(req, res, next) {
    dispatcher.dispatch(req, res, next).catch((err) => {
      if (typeof next === "function") {
        next(err);
      } else {
        sendJson(
          res,
          500,
          createErrorResponse(
            "INTERNAL_ERROR",
            err?.message || "Internal server error"
          )
        );
      }
    });
  };
}

module.exports = {
  createExpressAdapter
};
