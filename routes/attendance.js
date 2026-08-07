const express = require('express');
const AttendanceLog = require('../models/AttendanceLog');
const BreakLog = require('../models/BreakLog');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { isBranchScopedRole } = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const {
  sendSuccess,
  sendError,
  formatTime,
  formatDate,
  resolveAvatar,
} = require('../utils/helpers');
const { DEFAULT_SHIFT_START, DEFAULT_SHIFT_END } = require('../constants/shifts');
const { isLateCheckIn } = require('../utils/shiftTime');
const {
  ACTIVE_EMPLOYEE_FILTER,
  getTodayAbsentUsers,
} = require('../utils/absences');

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

function mapBreakSummary(log) {
  if (!log) return null;
  return {
    startTime: log.startTime || '',
    endTime: log.endTime || '',
    duration: log.duration || '',
    status: log.status,
  };
}

function mapStaffAttendance(log, breakLog) {
  return {
    ...mapAttendance(log),
    empName: log.userId?.name || 'Unknown',
    dept: log.userId?.dept || 'General',
    empId: log.userId?.employeeId || '',
    avatar: resolveAvatar(log.userId?.avatar, log.userId?.name),
    employeeStatus: log.userId?.status || 'Active',
    shiftStart: log.userId?.shiftStart || DEFAULT_SHIFT_START,
    shiftEnd: log.userId?.shiftEnd || DEFAULT_SHIFT_END,
    breakLog: mapBreakSummary(breakLog),
    branchId: log.userId?.branchId ? String(log.userId.branchId) : null,
    companyId: log.userId?.companyId ? String(log.userId.companyId) : null,
  };
}

// GET /api/attendance/overview — org live attendance dashboard
router.get('/overview', protect, authorize('view_all_attendance'), async (req, res) => {
  try {
    const today = formatDate();
    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, {
        date: today,
        dateLabel: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
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

    const userFilter = {
      ...ACTIVE_EMPLOYEE_FILTER,
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      userFilter.branchId = req.user.branchId;
    }

    const employees = await User.find(userFilter).select(
      'name dept employeeId avatar status branchId companyId systemRole shiftStart shiftEnd',
    );
    const empIds = employees.map((e) => e._id);

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
            status: { $in: ['active', 'completed'] },
          })
            .populate('userId', 'name dept employeeId avatar branchId')
            .sort({ updatedAt: -1 })
        : [],
      Branch.find({
        companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
        ...(isBranchScopedRole(req.user.systemRole) && req.user.branchId
          ? { _id: req.user.branchId }
          : {}),
      }).sort({ name: 1 }),
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

    const dateLabel = new Date().toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    return sendSuccess(res, {
      date: today,
      dateLabel,
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
});

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
          breakDuration: breakLog?.duration || '--',
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
      breakLog: mapBreakSummary(breakByDate.get(log.date)),
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
      breakLog: mapBreakSummary(breakLog),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/attendance/all — org-wide today (HR / Manager / Super Admin)
router.get('/all', protect, authorize('view_all_attendance'), async (req, res) => {
  try {
    const today = formatDate();
    const companyIds = await resolveCompanyIds(req.user);

    const userFilter = { ...ACTIVE_EMPLOYEE_FILTER };
    if (companyIds.length) {
      userFilter.companyId = {
        $in: companyIds.map((id) => toObjectId(id)).filter(Boolean),
      };
    }
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      userFilter.branchId = req.user.branchId;
    }

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
