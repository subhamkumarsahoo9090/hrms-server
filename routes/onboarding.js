const express = require('express');
const Onboarding = require('../models/Onboarding');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { isBranchScopedRole } = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, resolveAvatar, buildUserLookupFilter } = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');

const router = express.Router();

const DEFAULT_CHECKLIST = [
  { key: 'offer', label: 'Offer letter signed', mandatory: true },
  { key: 'identity', label: 'Identity documents (Aadhaar, PAN)', mandatory: true },
  { key: 'education', label: 'Education certificates', mandatory: true },
  { key: 'bank', label: 'Bank account details', mandatory: true },
  { key: 'assets', label: 'Asset allocation', mandatory: false },
  { key: 'induction', label: 'Induction session', mandatory: false },
];

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

function buildScopeFilter(user, companyIds) {
  const filter = { ...ACTIVE_EMPLOYEE_FILTER };
  if (companyIds.length) {
    filter.companyId = {
      $in: companyIds.map((id) => toObjectId(id)).filter(Boolean),
    };
  }
  if (isBranchScopedRole(user.systemRole) && user.branchId) {
    filter.branchId = user.branchId;
  }
  return filter;
}

function progressOf(checklist) {
  if (!checklist?.length) return 0;
  const done = checklist.filter((c) => c.done).length;
  return Math.round((done / checklist.length) * 100);
}

function pendingLabels(checklist) {
  return (checklist || []).filter((c) => !c.done).map((c) => c.label);
}

async function ensureOnboarding(user) {
  let record = await Onboarding.findOne({ userId: user._id });
  if (record) return record;

  const checklist = DEFAULT_CHECKLIST.map((c) => ({ ...c, done: false }));
  record = await Onboarding.create({
    userId: user._id,
    companyId: user.companyId || null,
    branchId: user.branchId || null,
    status: 'In Progress',
    checklist,
    joinedAt: user.createdAt || new Date(),
  });
  return record;
}

function mapJoinee(user, record) {
  const checklist = record.checklist || [];
  const progress = progressOf(checklist);
  const pending = pendingLabels(checklist);
  return {
    id: String(user._id),
    onboardingId: String(record._id),
    name: user.name,
    role: user.role || user.systemRole,
    systemRole: user.systemRole,
    dept: user.dept || '',
    employeeId: user.employeeId || '',
    avatar: resolveAvatar(user.avatar, user.name),
    joined: record.joinedAt
      ? new Date(record.joinedAt).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : '',
    joinedAt: record.joinedAt ? new Date(record.joinedAt).toISOString() : null,
    pending: pending.length,
    pendingItems: pending,
    progress,
    status: progress >= 100 ? 'Completed' : 'In Progress',
    checklist,
  };
}

// GET /api/onboarding/overview
router.get(
  '/overview',
  protect,
  authorize('create_employees', 'edit_employees'),
  async (req, res) => {
    try {
      const companyIds = await resolveCompanyIds(req.user);
      const since = new Date();
      since.setDate(since.getDate() - 90);

      const filter = {
        ...buildScopeFilter(req.user, companyIds),
        createdAt: { $gte: since },
      };

      const users = await User.find(filter)
        .select('name role systemRole dept avatar employeeId companyId branchId createdAt')
        .sort({ createdAt: -1 });

      const joinees = [];
      for (const u of users) {
        const record = await ensureOnboarding(u);
        if (record.status !== 'Completed' && progressOf(record.checklist) >= 100) {
          record.status = 'Completed';
          await record.save();
        }
        joinees.push(mapJoinee(u, record));
      }

      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const thisMonth = joinees.filter(
        (j) => j.joinedAt && new Date(j.joinedAt) >= monthStart,
      );

      const completed = joinees.filter((j) => j.status === 'Completed').length;
      const inProgress = joinees.filter((j) => j.status !== 'Completed').length;
      const pendingDocs = joinees.reduce((s, j) => s + j.pending, 0);

      const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const now = new Date();
      const growth = [];
      for (let i = 5; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const start = new Date(d.getFullYear(), d.getMonth(), 1);
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
        const count = users.filter((u) => {
          const c = u.createdAt ? new Date(u.createdAt) : null;
          return c && c >= start && c <= end;
        }).length;
        growth.push({ label: MONTH_SHORT[d.getMonth()], value: count });
      }

      return sendSuccess(res, {
        checklistTemplate: DEFAULT_CHECKLIST,
        summary: {
          newJoinees: thisMonth.length,
          fullyOnboarded: completed,
          inProgress,
          pendingDocuments: pendingDocs,
          total: joinees.length,
        },
        joinees,
        hiringTrend: growth,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// POST /api/onboarding/start — ensure checklist for a user
router.post(
  '/start',
  protect,
  authorize('create_employees', 'edit_employees'),
  async (req, res) => {
    try {
      const lookup = buildUserLookupFilter(req.body.userId || req.body.employeeId);
      const user = await User.findOne({ ...lookup, ...ACTIVE_EMPLOYEE_FILTER });
      if (!user) return sendError(res, 'Employee not found', 404);

      if (
        isBranchScopedRole(req.user.systemRole) &&
        req.user.branchId &&
        String(user.branchId) !== String(req.user.branchId)
      ) {
        return sendError(res, 'Employee is outside your branch', 403);
      }

      const record = await ensureOnboarding(user);
      return sendSuccess(res, { joinee: mapJoinee(user, record) }, 'Onboarding started');
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// PATCH /api/onboarding/:userId/items — toggle checklist item
router.patch(
  '/:userId/items',
  protect,
  authorize('create_employees', 'edit_employees'),
  async (req, res) => {
    try {
      const lookup = buildUserLookupFilter(req.params.userId);
      const user = await User.findOne(lookup);
      if (!user) return sendError(res, 'Employee not found', 404);

      if (
        isBranchScopedRole(req.user.systemRole) &&
        req.user.branchId &&
        String(user.branchId) !== String(req.user.branchId)
      ) {
        return sendError(res, 'Employee is outside your branch', 403);
      }

      const { key, done } = req.body;
      if (!key) return sendError(res, 'Checklist item key is required');

      const record = await ensureOnboarding(user);
      const item = record.checklist.find((c) => c.key === key);
      if (!item) return sendError(res, 'Checklist item not found', 404);

      item.done = done !== false;
      item.completedAt = item.done ? new Date() : null;
      record.status = progressOf(record.checklist) >= 100 ? 'Completed' : 'In Progress';
      await record.save();

      return sendSuccess(
        res,
        { joinee: mapJoinee(user, record) },
        item.done ? 'Checklist item completed' : 'Checklist item reopened',
      );
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

module.exports = router;
