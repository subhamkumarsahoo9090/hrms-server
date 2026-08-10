const express = require('express');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Team = require('../models/Team');
const AttendanceLog = require('../models/AttendanceLog');
const LeaveRequest = require('../models/LeaveRequest');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  isBranchScopedRole,
  isTeamScopedRole,
  hasPermission,
} = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, resolveAvatar } = require('../utils/helpers');
const { ATTENDANCE_SCOPE_FILTER } = require('../utils/absences');
const { getUserTeamIdList } = require('../utils/teamMembership');

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

function round1(n) {
  return Math.round(n * 10) / 10;
}

function ratingFromScore(score) {
  const rating = round1(Math.min(5, Math.max(1, score)));
  let band = 'Needs Focus';
  if (rating >= 4.3) band = 'Exceeds';
  else if (rating >= 3.5) band = 'Meets';
  return { rating, band };
}

function performanceScopeMeta(user) {
  const canViewStaff = hasPermission(user.systemRole, 'view_all_attendance');
  switch (user.systemRole) {
    case 'company_owner':
      return {
        scope: 'company',
        scopeLabel: 'All owned companies',
        isSelfService: false,
        canViewStaff: true,
      };
    case 'super_admin':
      return {
        scope: 'company',
        scopeLabel: 'Company-wide',
        isSelfService: false,
        canViewStaff: true,
      };
    case 'branch_head':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch',
        isSelfService: false,
        canViewStaff: true,
      };
    case 'hr':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch (HR)',
        isSelfService: false,
        canViewStaff: true,
      };
    case 'manager':
      return {
        scope: 'team',
        scopeLabel: 'Your team',
        isSelfService: false,
        canViewStaff: true,
      };
    default:
      return {
        scope: 'self',
        scopeLabel: 'Personal',
        isSelfService: true,
        canViewStaff: false,
      };
  }
}

async function resolveScopedEmployeeFilter(user) {
  if (!hasPermission(user.systemRole, 'view_all_attendance')) {
    return { ...ATTENDANCE_SCOPE_FILTER, _id: user._id };
  }

  const companyIds = await resolveCompanyIds(user);
  const filter = { ...ATTENDANCE_SCOPE_FILTER };

  if (companyIds.length) {
    filter.companyId = {
      $in: companyIds.map((id) => toObjectId(id)).filter(Boolean),
    };
  }

  if (isBranchScopedRole(user.systemRole) && user.branchId) {
    filter.branchId = user.branchId;
  }

  if (user.systemRole === 'manager' || isTeamScopedRole(user.systemRole)) {
    const teamIds = getUserTeamIdList(user);
    const managed = await Team.find({
      managerId: user._id,
      ...(user.companyId ? { companyId: user.companyId } : {}),
    }).select('_id');
    const allTeamIds = [
      ...new Set([...teamIds.map(String), ...managed.map((t) => String(t._id))]),
    ]
      .map((id) => toObjectId(id))
      .filter(Boolean);

    if (allTeamIds.length) {
      filter.$or = [
        { teamId: { $in: allTeamIds } },
        { teamIds: { $in: allTeamIds } },
        { managerId: user._id },
        { _id: user._id },
      ];
    } else {
      filter.$or = [{ managerId: user._id }, { _id: user._id }];
    }
  }

  return filter;
}

/**
 * GET /api/performance/overview
 * Role-scoped scorecard from attendance, leave and delays.
 * Employee → self · Manager → team · HR/BH → branch · SA/CEO → company
 */
router.get(
  '/overview',
  protect,
  authorize(
    'view_all_attendance',
    'view_team_attendance',
    'view_own_attendance',
    'edit_employees',
  ),
  async (req, res) => {
    try {
      const scopeMeta = performanceScopeMeta(req.user);
      const now = new Date();
      const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const cycleLabel = `H${now.getMonth() < 6 ? 1 : 2} ${now.getFullYear()}`;

      const filter = await resolveScopedEmployeeFilter(req.user);

      const employees = await User.find(filter)
        .select(
          'name role systemRole dept avatar employeeId delayCount branchId departmentId teamId',
        )
        .sort({ name: 1 });

      const empIds = employees.map((e) => e._id);

      const [monthLogs, leaves] = await Promise.all([
        empIds.length
          ? AttendanceLog.find({
              userId: { $in: empIds },
              date: { $regex: `^${monthPrefix}` },
            }).select('userId status')
          : [],
        empIds.length
          ? LeaveRequest.find({
              userId: { $in: empIds },
              status: 'Approved',
              startDate: { $regex: `^${now.getFullYear()}` },
            }).select('userId days')
          : [],
      ]);

      const logsByUser = new Map();
      monthLogs.forEach((l) => {
        const id = String(l.userId);
        const list = logsByUser.get(id) || [];
        list.push(l);
        logsByUser.set(id, list);
      });

      const leaveByUser = new Map();
      leaves.forEach((l) => {
        const id = String(l.userId);
        leaveByUser.set(id, (leaveByUser.get(id) || 0) + (Number(l.days) || 0));
      });

      const reviews = employees.map((e) => {
        const id = String(e._id);
        const logs = logsByUser.get(id) || [];
        const good = logs.filter((l) =>
          ['Present', 'Delayed'].includes(l.status),
        ).length;
        const attendancePct =
          logs.length > 0 ? round1((good / logs.length) * 100) : 90;
        const leaveDays = leaveByUser.get(id) || 0;
        const delays = Number(e.delayCount) || 0;

        let score =
          1 +
          (attendancePct / 100) * 3.5 -
          Math.min(1.2, delays * 0.08) -
          Math.min(0.8, Math.max(0, leaveDays - 6) * 0.05);
        score = Math.min(5, Math.max(1.5, score));

        const { rating, band } = ratingFromScore(score);
        const goals = 5;
        const done = Math.min(
          goals,
          Math.max(1, Math.round((attendancePct / 100) * goals)),
        );

        return {
          id,
          name: e.name,
          role: e.role || e.systemRole,
          systemRole: e.systemRole,
          dept: e.dept || '',
          employeeId: e.employeeId || '',
          avatar: resolveAvatar(e.avatar, e.name),
          goals,
          done,
          rating,
          band,
          attendancePct,
          leaveDays,
          delays,
          isSelf: String(e._id) === String(req.user._id),
        };
      });

      const avgRating =
        reviews.length > 0
          ? round1(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length)
          : 0;
      const completed = reviews.filter((r) => r.done >= r.goals * 0.8).length;
      const goalPct =
        reviews.length > 0
          ? Math.round(
              (reviews.reduce((s, r) => s + r.done / r.goals, 0) / reviews.length) *
                100,
            )
          : 0;
      const needsFocus = reviews.filter((r) => r.band === 'Needs Focus').length;

      const dist = {
        Exceeds: reviews.filter((r) => r.band === 'Exceeds').length,
        Meets: reviews.filter((r) => r.band === 'Meets').length,
        'Needs Focus': needsFocus,
      };

      return sendSuccess(res, {
        cycleLabel,
        ...scopeMeta,
        summary: {
          avgRating,
          reviewsCompleted: completed,
          reviewsTotal: reviews.length,
          goalCompletion: goalPct,
          needsFocus,
        },
        distribution: [
          { label: 'Exceeds', value: dist.Exceeds },
          { label: 'Meets', value: dist.Meets },
          { label: 'Needs Focus', value: dist['Needs Focus'] },
        ],
        reviews,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

module.exports = router;
