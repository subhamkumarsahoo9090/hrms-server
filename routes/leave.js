const express = require('express');
const LeaveRequest = require('../models/LeaveRequest');
const { LEAVE_TYPES } = require('../models/LeaveRequest');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { isBranchScopedRole, isTeamScopedRole } = require('../constants/permissions');
const { toObjectId, canAccessEmployee } = require('../utils/scope');
const {
  sendSuccess,
  sendError,
  resolveAvatar,
} = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');

const router = express.Router();

const POLICY = [
  { type: 'Casual Leave', allotted: 12 },
  { type: 'Sick Leave', allotted: 10 },
  { type: 'Earned Leave', allotted: 15 },
  { type: 'Comp Off', allotted: 5 },
];

async function resolveOwnerCompanyIds(user) {
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

async function resolveCompanyIds(user) {
  if (user.systemRole === 'company_owner') {
    return resolveOwnerCompanyIds(user);
  }
  if (user.companyId) return [String(user.companyId)];
  return [];
}

function countDays(startDate, endDate) {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
  const ms = e.getTime() - s.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

function formatDuration(days) {
  if (days === 1) return '1 Day';
  if (days % 1 === 0.5 && days < 2) return '0.5 Day';
  return `${days} Days`;
}

function formatAppliedOn(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function monthPrefix(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function mapLeave(doc, userMap) {
  const u = userMap?.get(String(doc.userId)) || null;
  return {
    id: String(doc._id),
    companyId: String(doc.companyId),
    branchId: doc.branchId ? String(doc.branchId) : null,
    userId: String(doc.userId),
    employeeId: doc.employeeId,
    name: u?.name || doc.employeeId,
    avatar: resolveAvatar(u?.avatar, u?.name),
    dept: u?.dept || '',
    leaveType: doc.leaveType,
    startDate: doc.startDate,
    endDate: doc.endDate,
    days: doc.days,
    duration: formatDuration(doc.days),
    reason: doc.reason || '',
    status: doc.status,
    appliedOn: formatAppliedOn(doc.appliedAt || doc.createdAt),
    appliedAt: doc.appliedAt ? new Date(doc.appliedAt).toISOString() : null,
    reviewedAt: doc.reviewedAt ? new Date(doc.reviewedAt).toISOString() : null,
    reviewNote: doc.reviewNote || '',
  };
}

async function buildScopeFilter(actor) {
  const companyIds = await resolveCompanyIds(actor);
  if (!companyIds.length) return null;

  const filter = {
    companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
  };

  if (isBranchScopedRole(actor.systemRole) && actor.branchId) {
    filter.branchId = actor.branchId;
  } else if (isTeamScopedRole(actor.systemRole)) {
    const teamFilter = { companyId: actor.companyId };
    if (actor.teamId) {
      const reportees = await User.find({
        ...teamFilter,
        $or: [{ teamId: actor.teamId }, { managerId: actor._id }, { _id: actor._id }],
      }).select('_id');
      filter.userId = { $in: reportees.map((u) => u._id) };
    } else {
      filter.userId = { $in: [actor._id] };
    }
  }

  return filter;
}

// GET /api/leave/overview
router.get('/overview', protect, authorize('view_leave'), async (req, res) => {
  try {
    const filter = await buildScopeFilter(req.user);
    if (!filter) {
      return sendSuccess(res, {
        periodLabel: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        summary: { pending: 0, approved: 0, rejected: 0, total: 0 },
        split: [],
        balances: POLICY.map((p) => ({ ...p, used: 0 })),
        requests: [],
      });
    }

    const prefix = monthPrefix();
    const monthStart = new Date(`${prefix}-01T00:00:00.000Z`);
    const yearStart = new Date(`${new Date().getFullYear()}-01-01T00:00:00.000Z`);

    const [monthRequests, yearApproved, headcount] = await Promise.all([
      LeaveRequest.find({
        ...filter,
        appliedAt: { $gte: monthStart },
      }).sort({ appliedAt: -1 }),
      LeaveRequest.find({
        ...filter,
        status: 'Approved',
        appliedAt: { $gte: yearStart },
      }).select('leaveType days'),
      User.countDocuments({
        ...ACTIVE_EMPLOYEE_FILTER,
        companyId: filter.companyId,
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
      }),
    ]);

    // Also include pending from earlier months still open
    const openPending = await LeaveRequest.find({
      ...filter,
      status: 'Pending',
      appliedAt: { $lt: monthStart },
    }).sort({ appliedAt: -1 });

    const byId = new Map();
    [...monthRequests, ...openPending].forEach((r) => byId.set(String(r._id), r));
    const allVisible = [...byId.values()].sort(
      (a, b) => new Date(b.appliedAt) - new Date(a.appliedAt),
    );

    const pending = allVisible.filter((r) => r.status === 'Pending').length;
    const approved = monthRequests.filter((r) => r.status === 'Approved').length;
    const rejected = monthRequests.filter((r) => r.status === 'Rejected').length;
    const total = monthRequests.length;

    const usedByType = new Map();
    yearApproved.forEach((r) => {
      usedByType.set(r.leaveType, (usedByType.get(r.leaveType) || 0) + (r.days || 0));
    });

    const denom = Math.max(1, headcount);
    const balances = POLICY.map((p) => {
      const orgUsed = usedByType.get(p.type) || 0;
      const avgUsed = Math.min(p.allotted, Math.round((orgUsed / denom) * 10) / 10);
      return {
        type: p.type,
        allotted: p.allotted,
        used: avgUsed,
        orgUsed,
      };
    });

    const userIds = [...new Set(allVisible.map((r) => String(r.userId)))];
    const users = userIds.length
      ? await User.find({
          _id: { $in: userIds.map((id) => toObjectId(id)).filter(Boolean) },
        }).select('name avatar dept employeeId')
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    return sendSuccess(res, {
      periodLabel: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      summary: { pending, approved, rejected, total },
      split: [
        { label: 'Approved', value: approved },
        { label: 'Pending', value: pending },
        { label: 'Rejected', value: rejected },
      ],
      balances,
      requests: allVisible.slice(0, 50).map((r) => mapLeave(r, userMap)),
      leaveTypes: LEAVE_TYPES,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/leave — list (optional ?status=)
router.get('/', protect, authorize('view_leave'), async (req, res) => {
  try {
    const filter = await buildScopeFilter(req.user);
    if (!filter) return sendSuccess(res, { requests: [] });

    if (req.query.status) {
      filter.status = String(req.query.status);
    }

    const requests = await LeaveRequest.find(filter).sort({ appliedAt: -1 }).limit(100);
    const userIds = [...new Set(requests.map((r) => String(r.userId)))];
    const users = userIds.length
      ? await User.find({
          _id: { $in: userIds.map((id) => toObjectId(id)).filter(Boolean) },
        }).select('name avatar dept employeeId')
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    return sendSuccess(res, {
      requests: requests.map((r) => mapLeave(r, userMap)),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/leave — apply (self or for employee if privileged)
router.post('/', protect, authorize('apply_leave'), async (req, res) => {
  try {
    const {
      leaveType,
      startDate,
      endDate,
      reason,
      days: daysBody,
      userId: targetUserId,
    } = req.body;

    if (!leaveType || !startDate || !endDate) {
      return sendError(res, 'leaveType, startDate and endDate are required');
    }
    if (!LEAVE_TYPES.includes(leaveType)) {
      return sendError(res, `Invalid leaveType. Allowed: ${LEAVE_TYPES.join(', ')}`);
    }

    let target = req.user;
    if (targetUserId && String(targetUserId) !== String(req.user._id)) {
      if (!['company_owner', 'super_admin', 'branch_head', 'hr'].includes(req.user.systemRole)) {
        return sendError(res, 'Forbidden — cannot apply leave for another user', 403);
      }
      target = await User.findById(targetUserId);
      if (!target) return sendError(res, 'Employee not found', 404);

      if (req.user.systemRole === 'company_owner') {
        const owned = await resolveOwnerCompanyIds(req.user);
        if (!owned.includes(String(target.companyId))) {
          return sendError(res, 'Forbidden', 403);
        }
      } else if (!canAccessEmployee(req.user, target)) {
        return sendError(res, 'Forbidden', 403);
      }
    }

    if (!target.companyId) {
      return sendError(res, 'Target user has no company assigned', 400);
    }

    const days = Number(daysBody) > 0 ? Number(daysBody) : countDays(startDate, endDate);
    if (!days || days <= 0) {
      return sendError(res, 'Invalid date range');
    }

    const leave = await LeaveRequest.create({
      companyId: target.companyId,
      branchId: target.branchId || null,
      userId: target._id,
      employeeId: target.employeeId,
      leaveType,
      startDate,
      endDate,
      days,
      reason: reason || '',
      status: 'Pending',
      appliedAt: new Date(),
    });

    const mapped = mapLeave(leave, new Map([[String(target._id), target]]));
    return sendSuccess(res, { request: mapped }, 'Leave request submitted', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/leave/:id/approve
router.patch('/:id/approve', protect, authorize('approve_leave'), async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return sendError(res, 'Leave request not found', 404);
    if (leave.status !== 'Pending') {
      return sendError(res, `Cannot approve a ${leave.status.toLowerCase()} request`);
    }

    const filter = await buildScopeFilter(req.user);
    if (!filter) return sendError(res, 'Forbidden', 403);

    const inScope = await LeaveRequest.findOne({ _id: leave._id, ...filter });
    if (!inScope) return sendError(res, 'Forbidden', 403);

    leave.status = 'Approved';
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    leave.reviewNote = req.body?.note || '';
    await leave.save();

    const user = await User.findById(leave.userId).select('name avatar dept employeeId');
    return sendSuccess(
      res,
      { request: mapLeave(leave, new Map([[String(leave.userId), user]])) },
      'Leave approved',
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/leave/:id/reject
router.patch('/:id/reject', protect, authorize('approve_leave'), async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return sendError(res, 'Leave request not found', 404);
    if (leave.status !== 'Pending') {
      return sendError(res, `Cannot reject a ${leave.status.toLowerCase()} request`);
    }

    const filter = await buildScopeFilter(req.user);
    if (!filter) return sendError(res, 'Forbidden', 403);

    const inScope = await LeaveRequest.findOne({ _id: leave._id, ...filter });
    if (!inScope) return sendError(res, 'Forbidden', 403);

    leave.status = 'Rejected';
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    leave.reviewNote = req.body?.note || '';
    await leave.save();

    const user = await User.findById(leave.userId).select('name avatar dept employeeId');
    return sendSuccess(
      res,
      { request: mapLeave(leave, new Map([[String(leave.userId), user]])) },
      'Leave rejected',
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
