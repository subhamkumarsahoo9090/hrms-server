const express = require('express');
const LeaveRequest = require('../models/LeaveRequest');
const { LEAVE_TYPES } = require('../models/LeaveRequest');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Team = require('../models/Team');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  isBranchScopedRole,
  isTeamScopedRole,
  hasPermission,
} = require('../constants/permissions');
const { toObjectId, canAccessEmployee } = require('../utils/scope');
const { getUserTeamIdList } = require('../utils/teamMembership');
const {
  sendSuccess,
  sendError,
  resolveAvatar,
} = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');
const {
  APPROVER_ROLE_LABELS,
  approvalChainForRequester,
  nextApproverRole,
  workflowLabel,
  canActOnLeaveStage,
  ensureLeaveChainFields,
} = require('../utils/leaveApproval');

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

/** Accept YYYY-MM-DD (preferred) or parseable date strings → YYYY-MM-DD */
function normalizeDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function countDays(startDate, endDate) {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
  const ms = e.getTime() - s.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

function leaveScopeMeta(user) {
  switch (user.systemRole) {
    case 'company_owner':
      return {
        scope: 'company',
        scopeLabel: 'All owned companies',
        isSelfService: false,
      };
    case 'super_admin':
      return {
        scope: 'company',
        scopeLabel: 'Company-wide',
        isSelfService: false,
      };
    case 'branch_head':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch',
        isSelfService: false,
      };
    case 'hr':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch (HR)',
        isSelfService: false,
      };
    case 'manager':
      return {
        scope: 'team',
        scopeLabel: 'Your team',
        isSelfService: false,
      };
    default:
      return {
        scope: 'self',
        scopeLabel: 'Personal',
        isSelfService: true,
      };
  }
}

const APPLY_FOR_OTHERS_ROLES = ['company_owner', 'super_admin', 'branch_head', 'hr'];

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

function canViewOrgLeave(actor) {
  return hasPermission(actor.systemRole, 'view_leave');
}

function mapLeave(doc, userMap, opts = {}) {
  const u = userMap?.get(String(doc.userId)) || null;
  const stage = doc.currentApproverRole || null;
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
    requesterRole: doc.requesterRole || '',
    currentApproverRole: stage,
    currentApproverLabel: stage
      ? APPROVER_ROLE_LABELS[stage] || stage
      : doc.status === 'Approved'
        ? 'Completed'
        : '—',
    approvalChain: doc.approvalChain || [],
    awaitingMe: Boolean(opts.awaitingMe),
    canApprove: Boolean(opts.canApprove),
    approvalHistory: (doc.approvalHistory || []).map((h) => ({
      role: h.role,
      roleLabel: APPROVER_ROLE_LABELS[h.role] || h.role,
      action: h.action,
      note: h.note || '',
      at: h.at ? new Date(h.at).toISOString() : null,
    })),
  };
}

/**
 * Role-scoped leave visibility (same pattern as attendance / payslips):
 * employee → self · manager → team · HR/BH → branch · SA/owner → company
 */
async function buildScopeFilter(actor) {
  if (!canViewOrgLeave(actor)) {
    return {
      userId: actor._id,
      ...(actor.companyId ? { companyId: actor.companyId } : {}),
    };
  }

  const companyIds = await resolveCompanyIds(actor);
  if (!companyIds.length) return null;

  const filter = {
    companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
  };

  if (isBranchScopedRole(actor.systemRole)) {
    if (!actor.branchId) return { userId: actor._id, ...filter };
    filter.branchId = actor.branchId;
    return filter;
  }

  if (actor.systemRole === 'manager' || isTeamScopedRole(actor.systemRole)) {
    const teamIds = getUserTeamIdList(actor);
    const managed = await Team.find({
      managerId: actor._id,
      ...(actor.companyId ? { companyId: actor.companyId } : {}),
    }).select('_id');
    const allTeamIds = [
      ...new Set([...teamIds.map(String), ...managed.map((t) => String(t._id))]),
    ]
      .map((id) => toObjectId(id))
      .filter(Boolean);

    const teamOr = [{ managerId: actor._id }, { _id: actor._id }];
    if (allTeamIds.length) {
      teamOr.push({ teamId: { $in: allTeamIds } });
      teamOr.push({ teamIds: { $in: allTeamIds } });
    }

    const reportees = await User.find({
      companyId: actor.companyId,
      $or: teamOr,
    }).select('_id');

    filter.userId = { $in: reportees.map((u) => u._id) };
    return filter;
  }

  return filter;
}

/** True if target employee is inside actor's leave apply / view scope */
async function canApplyLeaveFor(actor, target) {
  if (!actor || !target) return false;
  if (String(actor._id) === String(target._id)) return true;

  if (!APPLY_FOR_OTHERS_ROLES.includes(actor.systemRole)) return false;

  if (actor.systemRole === 'company_owner') {
    const owned = await resolveOwnerCompanyIds(actor);
    return Boolean(target.companyId && owned.includes(String(target.companyId)));
  }

  return canAccessEmployee(actor, target);
}

async function annotateRequests(actor, requests) {
  const userIds = [...new Set(requests.map((r) => String(r.userId)))];
  const users = userIds.length
    ? await User.find({
        _id: { $in: userIds.map((id) => toObjectId(id)).filter(Boolean) },
      }).select('name avatar dept employeeId systemRole managerId teamId teamIds companyId branchId')
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const mapped = [];
  for (const r of requests) {
    const requester = userMap.get(String(r.userId));
    if (requester) {
      const dirty = await ensureLeaveChainFields(r, requester);
      if (dirty) {
        try {
          await r.save();
        } catch {
          /* ignore migration save races */
        }
      }
    }
    const canApprove =
      r.status === 'Pending' &&
      hasPermission(actor.systemRole, 'approve_leave') &&
      (await canActOnLeaveStage(actor, r, requester));
    mapped.push(
      mapLeave(r, userMap, {
        awaitingMe: canApprove,
        canApprove,
      }),
    );
  }
  return mapped;
}

// GET /api/leave/overview
router.get(
  '/overview',
  protect,
  authorize('view_leave', 'view_own_leave'),
  async (req, res) => {
    try {
      const scopeMeta = leaveScopeMeta(req.user);
      const filter = await buildScopeFilter(req.user);
      if (!filter) {
        return sendSuccess(res, {
          periodLabel: new Date().toLocaleString('en-US', {
            month: 'long',
            year: 'numeric',
          }),
          summary: { pending: 0, approved: 0, rejected: 0, total: 0, awaitingMe: 0 },
          split: [],
          balances: POLICY.map((p) => ({ ...p, used: 0 })),
          requests: [],
          leaveTypes: LEAVE_TYPES,
          workflow: workflowLabel(),
          canApprove: hasPermission(req.user.systemRole, 'approve_leave'),
          canApplyForOthers: APPLY_FOR_OTHERS_ROLES.includes(req.user.systemRole),
          isSelfService: scopeMeta.isSelfService,
          scope: scopeMeta.scope,
          scopeLabel: scopeMeta.scopeLabel,
        });
      }

      const prefix = monthPrefix();
      const monthStart = new Date(`${prefix}-01T00:00:00.000Z`);
      const yearStart = new Date(`${new Date().getFullYear()}-01-01T00:00:00.000Z`);

      const selfOnly = scopeMeta.isSelfService;
      const balanceFilter = selfOnly
        ? { userId: req.user._id }
        : filter;

      const [monthRequests, yearApproved, headcount] = await Promise.all([
        LeaveRequest.find({
          ...filter,
          appliedAt: { $gte: monthStart },
        }).sort({ appliedAt: -1 }),
        LeaveRequest.find({
          ...balanceFilter,
          status: 'Approved',
          appliedAt: { $gte: yearStart },
        }).select('leaveType days'),
        selfOnly
          ? Promise.resolve(1)
          : User.countDocuments({
              ...ACTIVE_EMPLOYEE_FILTER,
              companyId: filter.companyId,
              ...(filter.branchId ? { branchId: filter.branchId } : {}),
              ...(filter.userId ? { _id: filter.userId } : {}),
            }),
      ]);

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

      const requests = await annotateRequests(req.user, allVisible.slice(0, 80));
      const pending = requests.filter((r) => r.status === 'Pending').length;
      const approved = monthRequests.filter((r) => r.status === 'Approved').length;
      const rejected = monthRequests.filter((r) => r.status === 'Rejected').length;
      const total = monthRequests.length;
      const awaitingMe = requests.filter((r) => r.awaitingMe).length;

      const usedByType = new Map();
      yearApproved.forEach((r) => {
        usedByType.set(r.leaveType, (usedByType.get(r.leaveType) || 0) + (r.days || 0));
      });

      const denom = Math.max(1, headcount);
      const balances = POLICY.map((p) => {
        const orgUsed = usedByType.get(p.type) || 0;
        const used = selfOnly
          ? Math.min(p.allotted, orgUsed)
          : Math.min(p.allotted, Math.round((orgUsed / denom) * 10) / 10);
        return {
          type: p.type,
          allotted: p.allotted,
          used,
          orgUsed,
        };
      });

      return sendSuccess(res, {
        periodLabel: new Date().toLocaleString('en-US', {
          month: 'long',
          year: 'numeric',
        }),
        summary: { pending, approved, rejected, total, awaitingMe },
        split: [
          { label: 'Approved', value: approved },
          { label: 'Pending', value: pending },
          { label: 'Rejected', value: rejected },
        ],
        balances,
        requests,
        leaveTypes: LEAVE_TYPES,
        workflow: workflowLabel(),
        canApprove: hasPermission(req.user.systemRole, 'approve_leave'),
        canApplyForOthers: APPLY_FOR_OTHERS_ROLES.includes(req.user.systemRole),
        isSelfService: selfOnly,
        scope: scopeMeta.scope,
        scopeLabel: scopeMeta.scopeLabel,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// GET /api/leave — list (optional ?status=&awaitingMe=1)
router.get('/', protect, authorize('view_leave', 'view_own_leave'), async (req, res) => {
  try {
    const filter = await buildScopeFilter(req.user);
    if (!filter) return sendSuccess(res, { requests: [] });

    if (req.query.status) {
      filter.status = String(req.query.status);
    }

    const requests = await LeaveRequest.find(filter).sort({ appliedAt: -1 }).limit(100);
    let mapped = await annotateRequests(req.user, requests);

    if (String(req.query.awaitingMe || '') === '1') {
      mapped = mapped.filter((r) => r.awaitingMe);
    }

    return sendSuccess(res, { requests: mapped });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/leave — apply (self or for employee if privileged + in scope)
router.post('/', protect, authorize('apply_leave'), async (req, res) => {
  try {
    const {
      leaveType,
      startDate: startRaw,
      endDate: endRaw,
      reason,
      days: daysBody,
      userId: targetUserId,
    } = req.body;

    if (!leaveType || !startRaw || !endRaw) {
      return sendError(res, 'leaveType, startDate and endDate are required');
    }
    if (!LEAVE_TYPES.includes(leaveType)) {
      return sendError(res, `Invalid leaveType. Allowed: ${LEAVE_TYPES.join(', ')}`);
    }

    const startDate = normalizeDateKey(startRaw);
    const endDate = normalizeDateKey(endRaw);
    if (!startDate || !endDate) {
      return sendError(res, 'Dates must be valid (YYYY-MM-DD)');
    }
    if (endDate < startDate) {
      return sendError(res, 'Invalid date range — end date cannot be before start date');
    }

    let target = req.user;
    if (targetUserId && String(targetUserId) !== String(req.user._id)) {
      target = await User.findById(targetUserId);
      if (!target) return sendError(res, 'Employee not found', 404);

      const allowed = await canApplyLeaveFor(req.user, target);
      if (!allowed) {
        return sendError(res, 'Forbidden — employee is outside your role scope', 403);
      }
    }

    if (!target.companyId) {
      return sendError(res, 'Target user has no company assigned', 400);
    }

    const days = Number(daysBody) > 0 ? Number(daysBody) : countDays(startDate, endDate);
    if (!days || days <= 0) {
      return sendError(res, 'Invalid date range — end date cannot be before start date');
    }

    const chain = approvalChainForRequester(target.systemRole);
    if (!chain.length) {
      // CEO / no chain — auto approve
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
        status: 'Approved',
        requesterRole: target.systemRole,
        approvalChain: [],
        currentApproverRole: null,
        appliedAt: new Date(),
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        reviewNote: 'Auto-approved (no further approver)',
      });
      const mapped = mapLeave(leave, new Map([[String(target._id), target]]));
      return sendSuccess(res, { request: mapped }, 'Leave auto-approved', 201);
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
      requesterRole: target.systemRole,
      approvalChain: chain,
      currentApproverRole: chain[0],
      appliedAt: new Date(),
    });

    const mapped = mapLeave(leave, new Map([[String(target._id), target]]), {
      awaitingMe: false,
      canApprove: false,
    });
    return sendSuccess(
      res,
      { request: mapped },
      `Leave submitted — awaiting ${APPROVER_ROLE_LABELS[chain[0]] || chain[0]}`,
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

async function leaveInActorScope(actor, leave) {
  const filter = await buildScopeFilter(actor);
  if (!filter) return false;
  const match = await LeaveRequest.findOne({ _id: leave._id, ...filter }).select('_id');
  return Boolean(match);
}

async function reviewLeave(req, res, action) {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return sendError(res, 'Leave request not found', 404);
    if (leave.status !== 'Pending') {
      return sendError(res, `Cannot ${action} a ${leave.status.toLowerCase()} request`);
    }

    const inScope = await leaveInActorScope(req.user, leave);
    if (!inScope) {
      return sendError(res, 'Forbidden — leave request is outside your role scope', 403);
    }

    const requester = await User.findById(leave.userId).select(
      'name avatar dept employeeId systemRole managerId teamId teamIds companyId branchId',
    );
    if (!requester) return sendError(res, 'Employee not found', 404);

    await ensureLeaveChainFields(leave, requester);

    const allowed = await canActOnLeaveStage(req.user, leave, requester);
    if (!allowed) {
      return sendError(
        res,
        `Forbidden — waiting for ${APPROVER_ROLE_LABELS[leave.currentApproverRole] || leave.currentApproverRole || 'approver'}`,
        403,
      );
    }

    const note = req.body?.note || '';
    const stage = leave.currentApproverRole;

    leave.approvalHistory = [
      ...(leave.approvalHistory || []),
      {
        role: stage,
        userId: req.user._id,
        action: action === 'approve' ? 'approved' : 'rejected',
        note,
        at: new Date(),
      },
    ];

    if (action === 'reject') {
      leave.status = 'Rejected';
      leave.currentApproverRole = null;
      leave.reviewedBy = req.user._id;
      leave.reviewedAt = new Date();
      leave.reviewNote = note;
      await leave.save();
      return sendSuccess(
        res,
        {
          request: mapLeave(leave, new Map([[String(leave.userId), requester]]), {
            canApprove: false,
            awaitingMe: false,
          }),
        },
        'Leave rejected',
      );
    }

    const next = nextApproverRole(leave.approvalChain, stage);
    if (next) {
      leave.currentApproverRole = next;
      leave.reviewedBy = req.user._id;
      leave.reviewedAt = new Date();
      leave.reviewNote = note;
      await leave.save();
      return sendSuccess(
        res,
        {
          request: mapLeave(leave, new Map([[String(leave.userId), requester]]), {
            canApprove: false,
            awaitingMe: false,
          }),
        },
        `Approved at ${APPROVER_ROLE_LABELS[stage] || stage} — now awaiting ${APPROVER_ROLE_LABELS[next] || next}`,
      );
    }

    leave.status = 'Approved';
    leave.currentApproverRole = null;
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    leave.reviewNote = note;
    await leave.save();

    return sendSuccess(
      res,
      {
        request: mapLeave(leave, new Map([[String(leave.userId), requester]]), {
          canApprove: false,
          awaitingMe: false,
        }),
      },
      'Leave fully approved',
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
}

// PATCH /api/leave/:id/approve
router.patch('/:id/approve', protect, authorize('approve_leave'), (req, res) =>
  reviewLeave(req, res, 'approve'),
);

// PATCH /api/leave/:id/reject
router.patch('/:id/reject', protect, authorize('approve_leave'), (req, res) =>
  reviewLeave(req, res, 'reject'),
);

module.exports = router;
