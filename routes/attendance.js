const express = require('express');
const AttendanceLog = require('../models/AttendanceLog');
const BreakLog = require('../models/BreakLog');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const Team = require('../models/Team');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  isBranchScopedRole,
  isTeamScopedRole,
  hasPermission,
} = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const {
  sendSuccess,
  sendError,
  formatTime,
  formatDate,
  formatBreakDuration,
  resolveAvatar,
} = require('../utils/helpers');
const { DEFAULT_SHIFT_START, DEFAULT_SHIFT_END } = require('../constants/shifts');
const { isLateCheckIn } = require('../utils/shiftTime');
const {
  ACTIVE_EMPLOYEE_FILTER,
  ATTENDANCE_SCOPE_FILTER,
  getTodayAbsentUsers,
} = require('../utils/absences');
const { getUserTeamIdList } = require('../utils/teamMembership');
const { computeBreakState } = require('../utils/breaks');

const router = express.Router();

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

function round1(n) {
  return Math.round(n * 10) / 10;
}

function mapAttendance(log) {
  return {
    date: log.date,
    status: log.status,
    timeIn: log.timeIn,
    timeOut: log.timeOut,
    delayReason: log.delayReason,
    userId: log.userId?._id?.toString?.() || log.userId?.toString?.() || log.userId,
  };
}

function mapBreakSummary(log, date = formatDate()) {
  if (!log) return null;
  const state = computeBreakState(log, date || log.date || formatDate());
  return {
    startTime: log.startTime || '',
    endTime: log.endTime || '',
    duration: log.duration || formatBreakDuration(state.usedSeconds),
    status: state.breakStatus,
    usedSeconds: state.usedSeconds,
    remainingSeconds: state.remainingSeconds,
    allowanceSeconds: state.allowanceSeconds,
    usedLabel: formatBreakDuration(state.usedSeconds),
    remainingLabel: formatBreakDuration(state.remainingSeconds),
    sessions: (log.sessions || []).map((s) => ({
      startTime: s.startTime,
      endTime: s.endTime,
      durationSeconds: s.durationSeconds,
      duration: formatBreakDuration(s.durationSeconds || 0),
    })),
  };
}

function attendanceScopeMeta(user) {
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
  // Employees / staff — only themselves
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

function mapStaffAttendance(log, breakLog) {
  const date = log.date || formatDate();
  return {
    ...mapAttendance(log),
    empName: log.userId?.name || 'Unknown',
    dept: log.userId?.dept || 'General',
    empId: log.userId?.employeeId || '',
    avatar: resolveAvatar(log.userId?.avatar, log.userId?.name),
    employeeStatus: log.userId?.status || 'Active',
    shiftStart: log.userId?.shiftStart || DEFAULT_SHIFT_START,
    shiftEnd: log.userId?.shiftEnd || DEFAULT_SHIFT_END,
    breakLog: mapBreakSummary(breakLog, date),
    branchId: log.userId?.branchId ? String(log.userId.branchId) : null,
    companyId: log.userId?.companyId ? String(log.userId.companyId) : null,
  };
}

// GET /api/attendance/overview — role-scoped live attendance dashboard
router.get(
  '/overview',
  protect,
  authorize('view_all_attendance', 'view_own_attendance'),
  async (req, res) => {
  try {
    const today = formatDate();
    const scopeMeta = attendanceScopeMeta(req.user);
    const companyIds = await resolveCompanyIds(req.user);
    const dateLabel = new Date().toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    if (!companyIds.length && !scopeMeta.isSelfService) {
      return sendSuccess(res, {
        date: today,
        dateLabel,
        ...scopeMeta,
        summary: {
          totalEmployees: 0,
          present: 0,
          absent: 0,
          late: 0,
          attendanceRate: 0,
          branchCount: 0,
        },
        split: [],
        trend: [],
        branches: [],
        recentActivity: [],
      });
    }

    const userFilter = await resolveScopedEmployeeFilter(req.user);

    const employees = await User.find(userFilter).select(
      'name dept employeeId avatar status branchId companyId systemRole shiftStart shiftEnd',
    );
    const empIds = employees.map((e) => e._id);

    const branchQuery = {
      companyId: {
        $in: (companyIds.length
          ? companyIds
          : req.user.companyId
            ? [String(req.user.companyId)]
            : []
        )
          .map((id) => toObjectId(id))
          .filter(Boolean),
      },
    };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      branchQuery._id = req.user.branchId;
    }
    // Managers / self — skip full branch list noise
    const loadBranches =
      !scopeMeta.isSelfService &&
      scopeMeta.scope !== 'team' &&
      branchQuery.companyId.$in.length > 0;

    const [logs, breakLogs, branches] = await Promise.all([
      empIds.length
        ? AttendanceLog.find({
            date: today,
            userId: { $in: empIds },
            timeIn: { $exists: true, $ne: '' },
          })
            .populate(
              'userId',
              'name dept employeeId avatar status branchId companyId shiftStart shiftEnd',
            )
            .sort({ updatedAt: -1 })
        : [],
      empIds.length
        ? BreakLog.find({
            date: today,
            userId: { $in: empIds },
            status: { $in: ['active', 'available', 'completed'] },
          })
            .populate('userId', 'name dept employeeId avatar branchId')
            .sort({ updatedAt: -1 })
        : [],
      loadBranches ? Branch.find(branchQuery).sort({ name: 1 }) : [],
    ]);

    const late = logs.filter((l) => l.status === 'Delayed').length;
    const present = logs.filter((l) => l.status !== 'Delayed').length;
    const onDuty = logs.length;
    const totalEmployees = employees.length;
    const absent = Math.max(0, totalEmployees - onDuty);
    const attendanceRate =
      totalEmployees > 0 ? round1((onDuty / totalEmployees) * 100) : 0;

    const breakByUser = new Map(
      breakLogs.map((b) => [String(b.userId?._id || b.userId), b]),
    );

    const logByUser = new Map(
      logs.map((l) => [String(l.userId?._id || l.userId), l]),
    );

    const branchRows = branches.map((b) => {
      const branchEmps = employees.filter(
        (e) => e.branchId && String(e.branchId) === String(b._id),
      );
      let presentCount = 0;
      let lateCount = 0;
      branchEmps.forEach((e) => {
        const log = logByUser.get(String(e._id));
        if (!log) return;
        if (log.status === 'Delayed') lateCount += 1;
        else presentCount += 1;
      });
      const empCount = branchEmps.length;
      const onDutyBranch = presentCount + lateCount;
      const absentCount = Math.max(0, empCount - onDutyBranch);
      const rate = empCount > 0 ? round1((onDutyBranch / empCount) * 100) : 0;
      return {
        id: String(b._id),
        name: b.name,
        code: b.code,
        employees: empCount,
        present: presentCount,
        absent: absentCount,
        late: lateCount,
        rate,
      };
    });

    const now = new Date();
    const trend = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth();
      const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
      const monthLogs = empIds.length
        ? await AttendanceLog.find({
            userId: { $in: empIds },
            date: { $regex: `^${prefix}` },
          }).select('status')
        : [];
      const good = monthLogs.filter((l) =>
        ['Present', 'Delayed'].includes(l.status),
      ).length;
      const rate =
        monthLogs.length > 0 ? round1((good / monthLogs.length) * 100) : attendanceRate;
      trend.push({ label: MONTH_SHORT[m], value: rate });
    }

    const activity = [];
    logs.slice(0, 20).forEach((log) => {
      const u = log.userId;
      if (!u) return;
      const branch = branches.find(
        (b) => u.branchId && String(b._id) === String(u.branchId),
      );
      if (log.timeIn) {
        activity.push({
          id: `${log._id}-in`,
          name: u.name,
          avatar: resolveAvatar(u.avatar, u.name),
          action: log.status === 'Delayed' ? 'checked in late' : 'checked in',
          branch: branch ? `${branch.name} (${branch.code})` : u.dept || '',
          time: log.timeIn,
          tone: log.status === 'Delayed' ? 'warning' : 'info',
          at: log.updatedAt || log.createdAt,
        });
      }
      if (log.timeOut) {
        activity.push({
          id: `${log._id}-out`,
          name: u.name,
          avatar: resolveAvatar(u.avatar, u.name),
          action: 'checked out',
          branch: branch ? `${branch.name} (${branch.code})` : u.dept || '',
          time: log.timeOut,
          tone: 'neutral',
          at: log.updatedAt || log.createdAt,
        });
      }
    });

    breakLogs.slice(0, 10).forEach((b) => {
      const u = b.userId;
      if (!u) return;
      const branch = branches.find(
        (br) => u.branchId && String(br._id) === String(u.branchId),
      );
      activity.push({
        id: `${b._id}-break`,
        name: u.name,
        avatar: resolveAvatar(u.avatar, u.name),
        action: b.status === 'active' ? 'started break' : 'ended break',
        branch: branch ? `${branch.name} (${branch.code})` : u.dept || '',
        time: b.endTime || b.startTime || '',
        tone: 'info',
        at: b.updatedAt || b.createdAt,
      });
    });

    activity.sort((a, b) => new Date(b.at) - new Date(a.at));

    return sendSuccess(res, {
      date: today,
      dateLabel,
      ...scopeMeta,
      summary: {
        totalEmployees,
        present,
        absent,
        late,
        attendanceRate,
        branchCount: branches.length,
        onDuty,
      },
      split: [
        { label: 'Present', value: present },
        { label: 'Absent', value: absent },
        { label: 'Late', value: late },
      ],
      trend,
      branches: branchRows,
      recentActivity: activity.slice(0, 12).map(({ at, ...rest }) => rest),
      attendance: logs.map((log) => {
        const userId = log.userId?._id?.toString?.() || log.userId?.toString?.();
        return mapStaffAttendance(log, breakByUser.get(userId));
      }),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
},
);

// GET /api/attendance/history/report — printable log for current user
router.get('/history/report', protect, async (req, res) => {
  try {
    const logs = await AttendanceLog.find({ userId: req.user._id })
      .sort({ date: -1 })
      .limit(30);

    const rows = await Promise.all(
      logs.map(async (log) => {
        const breakLog = await BreakLog.findOne({ userId: req.user._id, date: log.date });
        return {
          date: log.date,
          status: log.status,
          timeIn: log.timeIn || '--',
          timeOut: log.timeOut || '--',
          delayReason: log.delayReason || '',
          breakStart: breakLog?.startTime || '--',
          breakEnd: breakLog?.endTime || '--',
          breakDuration: breakLog
            ? mapBreakSummary(breakLog, log.date)?.usedLabel || breakLog.duration || '--'
            : '--',
          breakUsedSeconds: breakLog
            ? mapBreakSummary(breakLog, log.date)?.usedSeconds || 0
            : 0,
          breakRemainingSeconds: breakLog
            ? mapBreakSummary(breakLog, log.date)?.remainingSeconds || 0
            : 0,
        };
      }),
    );

    const period =
      rows.length > 0
        ? `${rows[rows.length - 1].date} to ${rows[0].date}`
        : formatDate();

    return sendSuccess(res, {
      report: {
        employeeName: req.user.name,
        employeeId: req.user.employeeId,
        department: req.user.dept,
        role: req.user.role,
        generatedAt: new Date().toISOString(),
        period,
        totalDays: rows.length,
        rows,
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/attendance/history — own history
router.get('/history', protect, async (req, res) => {
  try {
    const logs = await AttendanceLog.find({ userId: req.user._id }).sort({ date: -1 }).limit(30);
    const dates = logs.map((l) => l.date);
    const breaks = await BreakLog.find({ userId: req.user._id, date: { $in: dates } });
    const breakByDate = new Map(breaks.map((b) => [b.date, b]));

    const attendance = logs.map((log) => ({
      ...mapAttendance(log),
      breakLog: mapBreakSummary(breakByDate.get(log.date), log.date),
    }));

    return sendSuccess(res, { attendance });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/attendance/today — own today status
router.get('/today', protect, async (req, res) => {
  try {
    const today = formatDate();
    const log = await AttendanceLog.findOne({ userId: req.user._id, date: today });
    const breakLog = await BreakLog.findOne({ userId: req.user._id, date: today });
    return sendSuccess(res, {
      isCheckedIn: Boolean(log && log.timeIn && !log.timeOut),
      checkInTime: log?.timeIn || null,
      checkOutTime: log?.timeOut || null,
      shiftStart: req.user.shiftStart || DEFAULT_SHIFT_START,
      shiftEnd: req.user.shiftEnd || DEFAULT_SHIFT_END,
      attendance: log ? mapAttendance(log) : null,
      breakLog: mapBreakSummary(breakLog, today),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/attendance/all — scoped today (Owner / SA / BH / HR / Manager)
router.get('/all', protect, authorize('view_all_attendance'), async (req, res) => {
  try {
    const today = formatDate();
    const userFilter = await resolveScopedEmployeeFilter(req.user);

    const scopedUsers = await User.find(userFilter).select('_id');
    const scopedIds = scopedUsers.map((u) => u._id);

    const [logs, absentUsers, headcount, remoteCount, breakLogs] = await Promise.all([
      scopedIds.length
        ? AttendanceLog.find({
            date: today,
            userId: { $in: scopedIds },
            timeIn: { $exists: true, $ne: '' },
          }).populate(
            'userId',
            'name dept employeeId avatar systemRole status shiftStart shiftEnd branchId companyId',
          )
        : [],
      getTodayAbsentUsers(today),
      User.countDocuments(userFilter),
      User.countDocuments({ ...userFilter, status: 'Remote' }),
      scopedIds.length
        ? BreakLog.find({ date: today, userId: { $in: scopedIds } })
        : [],
    ]);

    const breakByUser = new Map(breakLogs.map((b) => [b.userId.toString(), b]));

    const attendance = logs.map((log) => {
      const userId = log.userId?._id?.toString?.() || log.userId?.toString?.();
      return mapStaffAttendance(log, breakByUser.get(userId));
    });

    return sendSuccess(res, {
      attendance,
      absentUsers,
      date: today,
      summary: {
        headcount,
        onDutyToday: attendance.length,
        absentToday: Math.max(0, headcount - attendance.length),
        remoteCount,
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/attendance/staff-history — scoped employee attendance + break history
router.get(
  '/staff-history',
  protect,
  authorize('view_all_attendance', 'view_team_attendance', 'view_own_attendance'),
  async (req, res) => {
    try {
      const scopeMeta = attendanceScopeMeta(req.user);
      const userFilter = await resolveScopedEmployeeFilter(req.user);
      const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
      const userIdParam = String(req.query.userId || '').trim();
      const today = formatDate();

      let employees = await User.find(userFilter)
        .select(
          'name dept employeeId avatar status branchId companyId role systemRole',
        )
        .sort({ name: 1 })
        .limit(500);

      if (userIdParam) {
        employees = employees.filter(
          (e) =>
            String(e._id) === userIdParam ||
            String(e.employeeId || '') === userIdParam,
        );
        if (!employees.length) {
          return sendError(res, 'Employee not in your scope', 403);
        }
      }

      const empIds = employees.map((e) => e._id);
      const since = new Date();
      since.setDate(since.getDate() - (days - 1));
      const sinceKey = formatDate(since);

      const [logs, breakLogs] = await Promise.all([
        empIds.length
          ? AttendanceLog.find({
              userId: { $in: empIds },
              date: { $gte: sinceKey },
              timeIn: { $exists: true, $ne: '' },
            })
              .populate(
                'userId',
                'name dept employeeId avatar status systemRole',
              )
              .sort({ date: -1, timeIn: -1 })
          : [],
        empIds.length
          ? BreakLog.find({
              userId: { $in: empIds },
              date: { $gte: sinceKey },
            })
          : [],
      ]);

      const breakByKey = new Map(
        breakLogs.map((b) => [`${String(b.userId)}:${b.date}`, b]),
      );

      const rows = logs.map((log) => {
        const populated = log.userId && typeof log.userId === 'object' ? log.userId : null;
        const uid = populated?._id
          ? String(populated._id)
          : String(log.userId || '');
        const brk = breakByKey.get(`${uid}:${log.date}`);
        const breakSummary = mapBreakSummary(brk, log.date);
        const breakTaken =
          Boolean(breakSummary) &&
          breakSummary.status &&
          breakSummary.status !== 'not_started';

        return {
          id: `${uid}-${log.date}`,
          userId: uid,
          date: log.date,
          isToday: log.date === today,
          empName: populated?.name || 'Unknown',
          empId: populated?.employeeId || '',
          dept: populated?.dept || '',
          systemRole: populated?.systemRole || '',
          avatar: resolveAvatar(populated?.avatar, populated?.name),
          status: log.status,
          timeIn: log.timeIn || '',
          timeOut: log.timeOut || '',
          delayReason: log.delayReason || null,
          breakLog: breakSummary,
          breakUsedLabel: breakTaken ? breakSummary.usedLabel : '—',
          breakRemainingLabel: breakTaken ? breakSummary.remainingLabel : '—',
        };
      });

      // Prefer today first, then newest dates
      rows.sort((a, b) => {
        if (a.isToday !== b.isToday) return a.isToday ? -1 : 1;
        return String(b.date).localeCompare(String(a.date));
      });

      return sendSuccess(res, {
        days,
        today,
        total: rows.length,
        todayCount: rows.filter((r) => r.isToday).length,
        ...scopeMeta,
        employees: employees.map((e) => ({
          id: String(e._id),
          name: e.name,
          employeeId: e.employeeId || '',
          dept: e.dept || '',
          systemRole: e.systemRole || '',
          avatar: resolveAvatar(e.avatar, e.name),
        })),
        rows,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// POST /api/attendance/check-in
router.post('/check-in', protect, authorize('clock_in'), async (req, res) => {
  try {
    const today = formatDate();
    let log = await AttendanceLog.findOne({ userId: req.user._id, date: today });

    if (log && log.timeIn) {
      return sendError(res, 'Already checked in today');
    }

    const timeIn = formatTime();
    const { delayReason } = req.body;
    const shiftStart = req.user.shiftStart || DEFAULT_SHIFT_START;
    const autoDelayed = isLateCheckIn(timeIn, shiftStart);
    const isDelayed = Boolean(delayReason) || autoDelayed;

    if (log) {
      log.timeIn = timeIn;
      log.status = isDelayed ? 'Delayed' : 'Present';
      log.delayReason = delayReason || null;
      await log.save();
    } else {
      log = await AttendanceLog.create({
        userId: req.user._id,
        date: today,
        status: isDelayed ? 'Delayed' : 'Present',
        timeIn,
        delayReason: delayReason || null,
      });
    }

    if (isDelayed) {
      await User.findByIdAndUpdate(req.user._id, { $inc: { delayCount: 1 } });
    }

    return sendSuccess(res, { attendance: mapAttendance(log), checkInTime: timeIn }, 'Checked in');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/attendance/check-out
router.post('/check-out', protect, authorize('clock_out'), async (req, res) => {
  try {
    const today = formatDate();
    const log = await AttendanceLog.findOne({ userId: req.user._id, date: today });

    if (!log || !log.timeIn) {
      return sendError(res, 'Not checked in today');
    }

    if (log.timeOut) {
      return sendError(res, 'Already checked out today');
    }

    log.timeOut = formatTime();
    await log.save();

    return sendSuccess(res, { attendance: mapAttendance(log) }, 'Checked out');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
