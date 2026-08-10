const express = require('express');
const Holiday = require('../models/Holiday');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { hasPermission, isBranchScopedRole } = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError } = require('../utils/helpers');
const { ensureDefaults, mapHoliday } = require('../utils/holidays');

const router = express.Router();

async function resolveCompanyIds(user) {
  if (user.systemRole === 'company_owner') {
    const memberships = await CompanyMembership.find({ userId: user._id });
    const owned = await Company.find({ ownerUserId: user._id });
    return [
      ...new Set([
        ...memberships.map((m) => String(m.companyId)),
        ...owned.map((c) => String(c._id)),
        user.companyId ? String(user.companyId) : null,
      ].filter(Boolean)),
    ];
  }
  if (user.companyId) return [String(user.companyId)];
  return [];
}

function buildListFilter(user, companyIds) {
  const filter = {
    companyId: {
      $in: companyIds.map((id) => toObjectId(id)).filter(Boolean),
    },
  };

  if (isBranchScopedRole(user.systemRole) && user.branchId) {
    filter.$or = [{ branchId: null }, { branchId: user.branchId }];
  }

  return filter;
}

router.get('/', protect, authorize('view_holidays'), async (req, res) => {
  try {
    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, { holidays: [], canManage: false });
    }

    await ensureDefaults(companyIds);

    const upcomingOnly = String(req.query.upcoming || '') === '1';
    const year = req.query.year ? String(req.query.year) : null;
    const filter = buildListFilter(req.user, companyIds);

    if (year) {
      filter.date = { $regex: `^${year}-` };
    }

    let holidays = await Holiday.find(filter).sort({ date: 1 });

    if (upcomingOnly) {
      const today = new Date().toISOString().slice(0, 10);
      holidays = holidays.filter((h) => h.date >= today).slice(0, 12);
    }

    return sendSuccess(res, {
      holidays: holidays.map(mapHoliday),
      canManage: hasPermission(req.user.systemRole, 'manage_holidays'),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/', protect, authorize('manage_holidays'), async (req, res) => {
  try {
    const { name, date, optional, branchId, companyId } = req.body;
    if (!name || !date) {
      return sendError(res, 'name and date (YYYY-MM-DD) are required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return sendError(res, 'date must be YYYY-MM-DD');
    }

    const companyIds = await resolveCompanyIds(req.user);
    let targetCompany = companyId ? String(companyId) : String(req.user.companyId || '');
    if (!targetCompany && companyIds.length === 1) targetCompany = companyIds[0];
    if (!targetCompany || !companyIds.includes(targetCompany)) {
      return sendError(res, 'Invalid or missing company scope', 403);
    }

    let targetBranch = null;
    if (isBranchScopedRole(req.user.systemRole)) {
      targetBranch = req.user.branchId || null;
    } else if (branchId) {
      targetBranch = toObjectId(branchId) || null;
    }

    const holiday = await Holiday.create({
      name: String(name).trim(),
      date: String(date),
      optional: Boolean(optional),
      companyId: toObjectId(targetCompany),
      branchId: targetBranch,
      createdBy: req.user._id,
    });

    return sendSuccess(res, { holiday: mapHoliday(holiday) }, 'Holiday added', 201);
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Holiday already exists for this date', 409);
    }
    return sendError(res, err.message, 500);
  }
});

router.patch('/:id', protect, authorize('manage_holidays'), async (req, res) => {
  try {
    const holiday = await Holiday.findById(req.params.id);
    if (!holiday) return sendError(res, 'Holiday not found', 404);

    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.includes(String(holiday.companyId))) {
      return sendError(res, 'Forbidden', 403);
    }

    if (
      isBranchScopedRole(req.user.systemRole) &&
      holiday.branchId &&
      req.user.branchId &&
      String(holiday.branchId) !== String(req.user.branchId)
    ) {
      return sendError(res, 'Holiday is outside your branch', 403);
    }

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return sendError(res, 'name cannot be empty');
      holiday.name = name;
    }
    if (req.body.date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date))) {
        return sendError(res, 'date must be YYYY-MM-DD');
      }
      holiday.date = String(req.body.date);
    }
    if (req.body.optional !== undefined) {
      holiday.optional = Boolean(req.body.optional);
    }

    await holiday.save();
    return sendSuccess(res, { holiday: mapHoliday(holiday) }, 'Holiday updated');
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Holiday already exists for this date', 409);
    }
    return sendError(res, err.message, 500);
  }
});

router.delete('/:id', protect, authorize('manage_holidays'), async (req, res) => {
  try {
    const holiday = await Holiday.findById(req.params.id);
    if (!holiday) return sendError(res, 'Holiday not found', 404);

    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.includes(String(holiday.companyId))) {
      return sendError(res, 'Forbidden', 403);
    }

    if (
      isBranchScopedRole(req.user.systemRole) &&
      holiday.branchId &&
      req.user.branchId &&
      String(holiday.branchId) !== String(req.user.branchId)
    ) {
      return sendError(res, 'Holiday is outside your branch', 403);
    }

    await holiday.deleteOne();
    return sendSuccess(res, null, 'Holiday deleted');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
