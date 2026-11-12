'use strict';

/**
 * Interior Designer - engagement tracking and enquiries.
 *   ViewIDPViewCountsController ......... story 25
 *   ViewIDPShortlistCountsController .... story 26
 *   ViewPerformanceDashboardController .. story 27
 *   ViewEnquiriesController ............. story 34 (+ mark as read)
 */
const AppError = require('../../utils/AppError');
const v = require('../../utils/validate');
const IDP = require('../../entity/IDP');
const Enquiry = require('../../entity/Enquiry');

const DEFAULTS = { IDP, Enquiry };

class ViewIDPViewCountsController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor) {
    const rows = await this.e.IDP.viewCountsForDesigner(actor.accountId);
    return { results: rows, total_views: rows.reduce((s, r) => s + r.view_count, 0) };
  }
}

class ViewIDPShortlistCountsController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor) {
    const rows = await this.e.IDP.shortlistCountsForDesigner(actor.accountId);
    return { results: rows, total_favourites: rows.reduce((s, r) => s + r.favourite_count, 0) };
  }
}

class ViewPerformanceDashboardController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor) {
    const summary = await this.e.IDP.performanceSummary(actor.accountId);
    const top = await this.e.IDP.search({ ownerId: actor.accountId, publicOnly: false, sort: 'most_viewed', limit: 5 });
    const totalViews = summary.total_views || 0;
    return {
      ...summary,
      shortlist_rate: totalViews ? Math.round((summary.total_favourites / totalViews) * 1000) / 10 : 0,
      top_idps: top.rows,
    };
  }
}
// Story #34: ViewEnquiriesController - Kwan Wei
class ViewEnquiriesController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, query = {}) {
    const { page, pageSize, offset } = v.pagination(query, { defaultSize: 20, maxSize: 100 });
    const status = query.status ? v.oneOf(query.status, ['new', 'read'], 'Status') : null;
    const { rows, total } = await this.e.Enquiry.listByDesigner(actor.accountId, { status, limit: pageSize, offset });
    return { results: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async markRead(actor, enquiryId) {
    const ok = await this.e.Enquiry.markRead(v.id(enquiryId, 'Enquiry id'), actor.accountId);
    if (!ok) throw AppError.notFound('Enquiry not found.');
    return { message: 'Enquiry marked as read.' };
  }
}

module.exports = {
  ViewIDPViewCountsController,
  ViewIDPShortlistCountsController,
  ViewPerformanceDashboardController,
  ViewEnquiriesController,
};
