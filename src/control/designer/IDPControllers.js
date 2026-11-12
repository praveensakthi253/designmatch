// Story #21: CreateIDPListingController - Sean Low
'use strict';

/**
 * Interior Designer - portfolio (IDP) use cases. Every operation enforces
 * ownership: a designer can only touch IDPs whose designer_id is their own.
 *   CreateIDPListingController .. story 21
 *   MarkIDPStatusController ..... story 22
 *   UpdateIDPListingController .. story 23 (edit)
 *   DeleteIDPListingController .. story 23 (delete)
 *   CategoriseIDPController ..... story 24
 *   ViewOwnIDPController ........ story 31
 *   SearchOwnIDPsController ..... story 32
 *   TagIDPController ............ story 33
 */
const db = require('../../config/db');
const AppError = require('../../utils/AppError');
const v = require('../../utils/validate');
const FileStorage = require('../../services/FileStorage');
const IDP = require('../../entity/IDP');
const IDPPhoto = require('../../entity/IDPPhoto');
const IDPCategory = require('../../entity/IDPCategory');
const DesignStyle = require('../../entity/DesignStyle');
const PropertyType = require('../../entity/PropertyType');

const DEFAULTS = { IDP, IDPPhoto, IDPCategory, DesignStyle, PropertyType, FileStorage, db };
const STATUSES = ['current', 'past'];
const MAX_PHOTOS = 10;
const MAX_BUDGET = 10000000;
// External image links, uploaded files, or the bundled sample renders
const PHOTO_URL_RE = /^(https?:\/\/[^\s]+|\/uploads\/[\w.-]+|\/img\/rooms\/[\w-]+\.jpg)$/i;

/** Throws 404 if the IDP does not exist and 403 if another designer owns it. */
async function assertOwnership(e, actor, idpId) {
  const ownerId = await e.IDP.findOwnerId(idpId);
  if (ownerId === null) throw AppError.notFound('IDP not found.');
  if (ownerId !== actor.accountId) throw AppError.forbidden('You can only manage IDPs in your own portfolio.');
}

async function validateCategory(e, categoryId, required) {
  const id = v.int(categoryId, 'Category', { required, min: 1 });
  if (id && !(await e.IDPCategory.findById(id))) throw AppError.badRequest('Selected category does not exist.');
  return id;
}

async function validateTags(e, { styleIds, propertyTypeId }) {
  const out = {};
  if (styleIds !== undefined) {
    out.styleIds = v.idList(styleIds, 'Design style');
    if (out.styleIds.length > 5) throw AppError.badRequest('An IDP can have at most 5 design styles.');
    if (!(await e.DesignStyle.allExist(out.styleIds))) throw AppError.badRequest('One or more design styles do not exist.');
  }
  if (propertyTypeId !== undefined) {
    out.propertyTypeId = v.int(propertyTypeId, 'Property type', { required: false, min: 1 });
    if (out.propertyTypeId && !(await e.PropertyType.exists(out.propertyTypeId))) {
      throw AppError.badRequest('Selected property type does not exist.');
    }
  }
  return out;
}

function validatePhotoUrls(urls) {
  const list = v.strList(urls, 'Photo URLs', { max: 500, maxItems: MAX_PHOTOS });
  list.forEach((u) => { if (!PHOTO_URL_RE.test(u)) throw AppError.badRequest(`Invalid photo URL: ${u}`); });
  return list;
}

function validateBudget(min, max) {
  const budgetMin = v.int(min, 'Minimum budget', { min: 0, max: MAX_BUDGET });
  const budgetMax = v.int(max, 'Maximum budget', { min: 0, max: MAX_BUDGET });
  if (budgetMax < budgetMin) throw AppError.badRequest('Maximum budget must be greater than or equal to the minimum budget.');
  return { budgetMin, budgetMax };
}

class CreateIDPListingController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  /** input.photos: [{url, caption}] from uploads; input.photoUrls: external image URLs. */
  async execute(actor, input) {
    const data = {
      title: v.str(input.title, 'Title', { min: 5, max: 150 }),
      description: v.str(input.description, 'Description', { min: 20, max: 5000 }),
      location: v.str(input.location, 'Location', { min: 2, max: 80 }),
      status: v.oneOf(input.status || 'current', STATUSES, 'Status'),
      categoryId: await validateCategory(this.e, input.categoryId, true),
      ...validateBudget(input.budgetMin, input.budgetMax),
      ...(await validateTags(this.e, {
        styleIds: input.styleIds === undefined ? [] : input.styleIds,
        propertyTypeId: input.propertyTypeId,
      })),
    };
    const photos = [...(input.photos || []), ...validatePhotoUrls(input.photoUrls).map((url) => ({ url }))];
    if (!photos.length) throw AppError.badRequest('Please add at least one photo of the project.');
    if (photos.length > MAX_PHOTOS) throw AppError.badRequest(`An IDP can have at most ${MAX_PHOTOS} photos.`);

    const idpId = await this.e.db.withTransaction(async (client) => {
      const id = await this.e.IDP.create(actor.accountId, data, client);
      await this.e.IDPPhoto.addMany(id, photos, client);
      return id;
    });
    return { idp: await this.e.IDP.findById(idpId), message: 'IDP listing created successfully.' };
  }
}

class UpdateIDPListingController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, idpId, input) {
    const id = v.id(idpId, 'IDP id');
    await assertOwnership(this.e, actor, id);
    const current = await this.e.IDP.findById(id);
    const data = {};
    if (input.title !== undefined) data.title = v.str(input.title, 'Title', { min: 5, max: 150 });
    if (input.description !== undefined) data.description = v.str(input.description, 'Description', { min: 20, max: 5000 });
    if (input.location !== undefined) data.location = v.str(input.location, 'Location', { min: 2, max: 80 });
    if (input.status !== undefined) data.status = v.oneOf(input.status, STATUSES, 'Status');
    if (input.categoryId !== undefined) data.categoryId = await validateCategory(this.e, input.categoryId, true);
    if (input.budgetMin !== undefined || input.budgetMax !== undefined) {
      Object.assign(data, validateBudget(input.budgetMin ?? current.budget_min, input.budgetMax ?? current.budget_max));
    }
    Object.assign(data, await validateTags(this.e, { styleIds: input.styleIds, propertyTypeId: input.propertyTypeId }));

    const removeIds = v.idList(input.removePhotoIds, 'Photo id');
    const newPhotos = [...(input.photos || []), ...validatePhotoUrls(input.photoUrls).map((url) => ({ url }))];
    const remaining = current.photos.filter((p) => !removeIds.includes(p.photo_id)).length;
    if (remaining + newPhotos.length < 1) throw AppError.badRequest('An IDP must keep at least one photo.');
    if (remaining + newPhotos.length > MAX_PHOTOS) throw AppError.badRequest(`An IDP can have at most ${MAX_PHOTOS} photos.`);
    if (!Object.keys(data).length && !removeIds.length && !newPhotos.length) {
      throw AppError.badRequest('No changes were provided.');
    }

    const removedUrls = await this.e.db.withTransaction(async (client) => {
      await this.e.IDP.update(id, data, client);
      const urls = await this.e.IDPPhoto.deleteMany(id, removeIds, client);
      await this.e.IDPPhoto.addMany(id, newPhotos, client);
      return urls;
    });
    this.e.FileStorage.removeLocal(removedUrls);
    return { idp: await this.e.IDP.findById(id), message: 'IDP listing updated successfully.' };
  }
}

class DeleteIDPListingController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  /** Photos, favourites, views and enquiries are removed by ON DELETE CASCADE. */
  async execute(actor, idpId) {
    const id = v.id(idpId, 'IDP id');
    await assertOwnership(this.e, actor, id);
    const urls = await this.e.IDPPhoto.urlsForIdp(id);
    await this.e.IDP.delete(id);
    this.e.FileStorage.removeLocal(urls);
    return { message: 'IDP listing deleted.' };
  }
}

class MarkIDPStatusController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, idpId, status) {
    const id = v.id(idpId, 'IDP id');
    v.oneOf(status, STATUSES, 'Status');
    await assertOwnership(this.e, actor, id);
    await this.e.IDP.update(id, { status });
    return { idp: await this.e.IDP.findById(id), message: `IDP marked as ${status}.` };
  }
}

class CategoriseIDPController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, idpId, categoryId) {
    const id = v.id(idpId, 'IDP id');
    await assertOwnership(this.e, actor, id);
    const cat = await validateCategory(this.e, categoryId, true);
    await this.e.IDP.update(id, { categoryId: cat });
    return { idp: await this.e.IDP.findById(id), message: 'IDP category updated.' };
  }
}

// Story #33: TagIDPController - Kwan Wei
class TagIDPController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, idpId, { styleIds, propertyTypeId }) {
    const id = v.id(idpId, 'IDP id');
    await assertOwnership(this.e, actor, id);
    const tags = await validateTags(this.e, { styleIds: styleIds ?? [], propertyTypeId: propertyTypeId ?? null });
    await this.e.IDP.update(id, tags);
    return { idp: await this.e.IDP.findById(id), message: 'Design styles and property type saved.' };
  }
}

class ViewOwnIDPController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, idpId) {
    const id = v.id(idpId, 'IDP id');
    await assertOwnership(this.e, actor, id);
    return this.e.IDP.findById(id);
  }
}

class SearchOwnIDPsController {
  constructor(deps = {}) { this.e = { ...DEFAULTS, ...deps }; }

  async execute(actor, query = {}) {
    const { page, pageSize, offset } = v.pagination(query, { defaultSize: 12, maxSize: 50 });
    const criteria = {
      ownerId: actor.accountId,
      publicOnly: false,
      keyword: v.str(query.q, 'Search', { required: false, max: 100 }),
      status: query.status ? v.oneOf(query.status, STATUSES, 'Status') : null,
      sort: IDP.SORTS.includes(query.sort) ? query.sort : 'newest',
      limit: pageSize,
      offset,
    };
    if (query.categoryId === 'none') criteria.uncategorised = true;
    else if (query.categoryId) criteria.categoryId = v.id(query.categoryId, 'Category');
    const { rows, total } = await this.e.IDP.search(criteria);
    return { results: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }
}

module.exports = {
  CreateIDPListingController,
  UpdateIDPListingController,
  DeleteIDPListingController,
  MarkIDPStatusController,
  CategoriseIDPController,
  TagIDPController,
  ViewOwnIDPController,
  SearchOwnIDPsController,
  MAX_PHOTOS,
};
