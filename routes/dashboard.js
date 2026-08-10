const express = require('express');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const AttendanceLog = require('../models/AttendanceLog');
const SalarySlip = require('../models/SalarySlip');
const LeaveRequest = require('../models/LeaveRequest');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, formatDate, resolveAvatar } = require('../utils/helpers');
const {
  ACTIVE_EMPLOYEE_FILTER,
  getTodayAbsentUsers,
} = require('../utils/absences');
const { buildNotifications } = require('../utils/notifications');
const { teamMemberFilter } = require('../utils/teamMembership');
const Holiday = require('../models/Holiday');
const { formatHolidayDate, ensureDefaults } = require('../utils/holidays');

const router = express.Router();

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getMonthPrefix(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function formatInr(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 10000000) return `₹${round1(v / 10000000)} Cr`;
  if (v >= 100000) return `₹${round1(v / 100000)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
}

function salaryMonthKey(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function monthEnd(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
}

function monthStart(year, monthIndex) {
  return new Date(year, monthIndex, 1, 0, 0, 0, 0);
}

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

// GET /api/dashboard/stats
router.get('/stats', protect, async (_req, res) => {
  try {
    const today = formatDate();
    const monthPrefix = getMonthPrefix();

    const headcount = await User.countDocuments(ACTIVE_EMPLOYEE_FILTER);

    const onDutyToday = await AttendanceLog.countDocuments({
      date: today,
      timeIn: { $exists: true, $ne: '' },
    });

    const remoteCount = await User.countDocuments({
      ...ACTIVE_EMPLOYEE_FILTER,
      status: 'Remote',
    });

    const onLeaveCount = await User.countDocuments({
      ...ACTIVE_EMPLOYEE_FILTER,
      status: 'On Leave',
    });

    const absentUsers = await getTodayAbsentUsers(today);
    const absentToday = absentUsers.length;
    const absentEmpIds = absentUsers.map((user) => user.id);

    const remoteOrOut = await User.countDocuments({
      ...ACTIVE_EMPLOYEE_FILTER,
      $or: [
        { status: { $in: ['Remote', 'On Leave'] } },
        { employeeId: { $in: absentEmpIds } },
      ],
    });

    const notOnDuty = Math.max(0, headcount - onDutyToday);

    const monthStartDt = new Date();
    monthStartDt.setDate(1);
    monthStartDt.setHours(0, 0, 0, 0);

    const newJoinersThisMonth = await User.countDocuments({
      ...ACTIVE_EMPLOYEE_FILTER,
      createdAt: { $gte: monthStartDt },
    });

    const monthLogs = await AttendanceLog.find({
      date: { $regex: `^${monthPrefix}` },
    }).select('status');

    const presentOrDelayed = monthLogs.filter((log) =>
      ['Present', 'Delayed'].includes(log.status),
    ).length;

    const attendanceRateThisMonth =
      monthLogs.length > 0
        ? Math.round((presentOrDelayed / monthLogs.length) * 1000) / 10
        : 100;

    const activeEmployees = await User.countDocuments({
      ...ACTIVE_EMPLOYEE_FILTER,
      status: 'Active',
    });

    const onDutyLogs = await AttendanceLog.find({
      date: today,
      timeIn: { $exists: true, $ne: '' },
    }).populate('userId', 'name dept systemRole status employeeId');

    const deptOnDuty = {};
    onDutyLogs.forEach((log) => {
      const dept = log.userId?.dept || 'General';
      deptOnDuty[dept] = (deptOnDuty[dept] || 0) + 1;
    });

    return sendSuccess(res, {
      stats: {
        headcount,
        onDutyToday,
        remoteOrOut,
        remoteCount,
        onLeaveCount,
        absentToday,
        notOnDuty,
        newJoinersThisMonth,
        attendanceRateThisMonth,
        activeEmployees,
        date: today,
        deptOnDuty,
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/dashboard/owner — company owner console home
router.get('/owner', protect, authorize('manage_companies'), async (req, res) => {
  try {
    const companyIds = await resolveOwnerCompanyIds(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, {
        owner: {
          name: req.user.name,
          role: req.user.role,
          email: req.user.email,
        },
        dateLabel: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        summary: {
          companies: 0,
          branches: 0,
          employees: 0,
          payrollMtd: 0,
          payrollMtdLabel: '₹0',
          attendanceRate: 0,
          attendanceDelta: null,
        },
        headcountTrend: [],
        payrollTrend: [],
        companySplit: [],
        companies: [],
        branches: [],
        orgTree: [],
        notifications: [],
      });
    }

    const companyObjIds = companyIds.map((id) => toObjectId(id)).filter(Boolean);
    const today = formatDate();
    const now = new Date();

    const [companies, branches, departments, employees, notifData] = await Promise.all([
      Company.find({ _id: { $in: companyObjIds } }).sort({ name: 1 }),
      Branch.find({ companyId: { $in: companyObjIds } }).sort({ isHeadOffice: -1, name: 1 }),
      Department.find({ companyId: { $in: companyObjIds } }).sort({ name: 1 }),
      User.find({
        ...ACTIVE_EMPLOYEE_FILTER,
        companyId: { $in: companyObjIds },
      }).select('companyId branchId departmentId dept salary createdAt isActive updatedAt'),
      buildNotifications(req.user),
    ]);

    const empIds = employees.map((e) => e._id);
    const headcount = employees.length;
    const salarySum = employees.reduce((s, e) => s + (Number(e.salary) || 0), 0);

    const months = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), monthIndex: d.getMonth() });
    }
    const slipKeys = months.map((m) => salaryMonthKey(m.year, m.monthIndex));

    const [todayLogs, monthLogs, prevMonthLogs, slips, allUsers] = await Promise.all([
      empIds.length
        ? AttendanceLog.find({
            date: today,
            userId: { $in: empIds },
            timeIn: { $exists: true, $ne: '' },
          }).select('userId')
        : [],
      empIds.length
        ? AttendanceLog.find({
            userId: { $in: empIds },
            date: {
              $regex: `^${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
            },
          }).select('status')
        : [],
      empIds.length
        ? AttendanceLog.find({
            userId: { $in: empIds },
            date: {
              $regex: `^${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0')}`,
            },
          }).select('status')
        : [],
      empIds.length
        ? SalarySlip.find({ userId: { $in: empIds }, month: { $in: slipKeys } })
        : [],
      User.find({ companyId: { $in: companyObjIds } }).select(
        'createdAt isActive updatedAt companyId salary',
      ),
    ]);

    const goodThis = monthLogs.filter((l) => ['Present', 'Delayed'].includes(l.status)).length;
    const rateThis =
      monthLogs.length > 0
        ? round1((goodThis / monthLogs.length) * 100)
        : headcount > 0
          ? round1((todayLogs.length / headcount) * 100)
          : 0;
    const goodPrev = prevMonthLogs.filter((l) =>
      ['Present', 'Delayed'].includes(l.status),
    ).length;
    const ratePrev =
      prevMonthLogs.length > 0 ? round1((goodPrev / prevMonthLogs.length) * 100) : rateThis;
    const attendanceDelta = round1(rateThis - ratePrev);

    const slipsByMonth = new Map();
    slips.forEach((s) => {
      const list = slipsByMonth.get(s.month) || [];
      list.push(s);
      slipsByMonth.set(s.month, list);
    });

    const headcountTrend = [];
    const payrollTrend = [];
    months.forEach(({ year, monthIndex }) => {
      const label = MONTH_SHORT[monthIndex];
      const start = monthStart(year, monthIndex);
      const end = monthEnd(year, monthIndex);
      const key = salaryMonthKey(year, monthIndex);

      const hc = allUsers.filter((u) => {
        if (!u.createdAt || new Date(u.createdAt) > end) return false;
        if (u.isActive === false && u.updatedAt && new Date(u.updatedAt) < start) return false;
        return true;
      }).length;
      headcountTrend.push({ label, value: hc });

      const monthSlips = slipsByMonth.get(key) || [];
      let payroll = monthSlips.reduce((s, x) => s + (Number(x.net) || 0), 0);
      if (!payroll) payroll = salarySum;
      payrollTrend.push({
        label,
        value: round1(payroll / 10000000),
        amount: payroll,
      });
    });

    const currentKey = slipKeys[slipKeys.length - 1];
    const currentSlips = slipsByMonth.get(currentKey) || [];
    const payrollMtd =
      currentSlips.reduce((s, x) => s + (Number(x.net) || 0), 0) || salarySum;
    const slipNetByUser = new Map(
      currentSlips.map((s) => [String(s.userId), Number(s.net) || 0]),
    );

    const companyById = new Map(companies.map((c) => [String(c._id), c]));
    const presentSet = new Set(todayLogs.map((l) => String(l.userId)));

    const companySplit = companies.map((c) => {
      const count = employees.filter((e) => String(e.companyId) === String(c._id)).length;
      return {
        id: String(c._id),
        label: c.name,
        value: count,
      };
    });

    const companiesOut = companies.map((c) => {
      const cid = String(c._id);
      const cBranches = branches.filter((b) => String(b.companyId) === cid);
      const cEmps = employees.filter((e) => String(e.companyId) === cid);
      let payroll = 0;
      cEmps.forEach((e) => {
        payroll += slipNetByUser.has(String(e._id))
          ? slipNetByUser.get(String(e._id))
          : Number(e.salary) || 0;
      });
      return {
        id: cid,
        name: c.name,
        slug: c.slug,
        city: c.city || '',
        status: c.status || 'Active',
        branches: cBranches.length,
        employees: cEmps.length,
        payroll,
        payrollLabel: formatInr(payroll),
      };
    });

    const branchesOut = branches.map((b) => {
      const bEmps = employees.filter((e) => e.branchId && String(e.branchId) === String(b._id));
      const present = bEmps.filter((e) => presentSet.has(String(e._id))).length;
      const attendance =
        bEmps.length > 0 ? round1((present / bEmps.length) * 100) : 0;
      let payroll = 0;
      bEmps.forEach((e) => {
        payroll += slipNetByUser.has(String(e._id))
          ? slipNetByUser.get(String(e._id))
          : Number(e.salary) || 0;
      });
      const company = companyById.get(String(b.companyId));
      return {
        id: String(b._id),
        name: b.name,
        code: b.code,
        company: company?.name || '',
        companyId: String(b.companyId),
        employees: bEmps.length,
        attendance,
        payroll,
        payrollLabel: formatInr(payroll),
        isHeadOffice: !!b.isHeadOffice,
      };
    });

    const orgTree = companies.map((c) => {
      const cid = String(c._id);
      const cBranches = branches
        .filter((b) => String(b.companyId) === cid)
        .map((b) => {
          const bid = String(b._id);
          const empCount = employees.filter(
            (e) => e.branchId && String(e.branchId) === bid,
          ).length;
          const deptNames = [
            ...new Set(
              departments
                .filter((d) => String(d.branchId) === bid)
                .map((d) => d.name),
            ),
          ].slice(0, 8);
          return {
            id: bid,
            name: b.name,
            code: b.code,
            employees: empCount,
            isHeadOffice: !!b.isHeadOffice,
            departments: deptNames,
          };
        })
        .sort((a, b) => Number(b.isHeadOffice) - Number(a.isHeadOffice) || b.employees - a.employees);

      return {
        id: cid,
        name: c.name,
        slug: c.slug,
        branches: cBranches,
      };
    });

    const notifications = (notifData.notifications || []).slice(0, 8).map((n) => ({
      id: n.id,
      text: n.message || n.title,
      title: n.title,
      tone:
        n.type === 'attendance' || n.type === 'delay'
          ? 'warning'
          : n.type === 'email' || n.type === 'message'
            ? 'info'
            : 'neutral',
      time: n.time,
    }));

    return sendSuccess(res, {
      owner: {
        name: req.user.name,
        role: req.user.role || 'Company Owner',
        email: req.user.email,
      },
      dateLabel: new Date().toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
      summary: {
        companies: companies.length,
        branches: branches.length,
        employees: headcount,
        payrollMtd,
        payrollMtdLabel: formatInr(payrollMtd),
        attendanceRate: rateThis,
        attendanceDelta,
      },
      headcountTrend,
      payrollTrend: payrollTrend.map((p) => ({ label: p.label, value: p.value })),
      companySplit,
      companies: companiesOut,
      branches: branchesOut,
      orgTree,
      notifications,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * GET /api/dashboard/super-admin
 * Company-wide overview for Super Admin (active company only).
 */
router.get(
  '/super-admin',
  protect,
  authorize('manage_system_settings', 'create_branch'),
  async (req, res) => {
    try {
      const companyId = req.user.companyId ? String(req.user.companyId) : null;
      if (!companyId) {
        return sendSuccess(res, {
          admin: {
            name: req.user.name,
            role: req.user.role || 'Super Admin',
            email: req.user.email,
          },
          company: null,
          dateLabel: new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
          summary: {
            branches: 0,
            departments: 0,
            employees: 0,
            attendanceRate: 0,
            payrollMtd: 0,
            payrollMtdLabel: '₹0',
          },
          branches: [],
          employeeGrowth: [],
          attendanceTrend: [],
          recentAudit: [],
          health: {
            apiUptime: 99.9,
            databaseLoad: 0,
            storageUsed: 0,
            activeSessions: 0,
          },
        });
      }

      const companyObjId = toObjectId(companyId);
      const today = formatDate();
      const now = new Date();

      const [company, branches, departments, employees] = await Promise.all([
        Company.findById(companyObjId),
        Branch.find({ companyId: companyObjId }).sort({ isHeadOffice: -1, name: 1 }),
        Department.find({ companyId: companyObjId }).sort({ name: 1 }),
        User.find({
          ...ACTIVE_EMPLOYEE_FILTER,
          companyId: companyObjId,
        }).select('_id branchId salary createdAt isActive updatedAt'),
      ]);

      const empIds = employees.map((e) => e._id);
      const headcount = employees.length;
      const salarySum = employees.reduce((s, e) => s + (Number(e.salary) || 0), 0);

      const months = [];
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ year: d.getFullYear(), monthIndex: d.getMonth() });
      }
      const slipKeys = months.map((m) => salaryMonthKey(m.year, m.monthIndex));

      const [todayLogs, monthLogs, slips, allUsers, recentUsers, sessions] =
        await Promise.all([
          empIds.length
            ? AttendanceLog.find({
                date: today,
                userId: { $in: empIds },
                timeIn: { $exists: true, $ne: '' },
              }).select('userId')
            : [],
          empIds.length
            ? AttendanceLog.find({
                userId: { $in: empIds },
                date: {
                  $regex: `^${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
                },
              }).select('status')
            : [],
          empIds.length
            ? SalarySlip.find({ userId: { $in: empIds }, month: { $in: slipKeys } })
            : [],
          User.find({ companyId: companyObjId }).select(
            'createdAt isActive updatedAt salary lastLoginAt name systemRole',
          ),
          User.find({ companyId: companyObjId })
            .sort({ updatedAt: -1 })
            .limit(8)
            .select('name employeeId systemRole updatedAt createdAt isActive'),
          User.countDocuments({
            ...ACTIVE_EMPLOYEE_FILTER,
            companyId: companyObjId,
            lastLoginAt: {
              $gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
            },
          }),
        ]);

      const goodThis = monthLogs.filter((l) =>
        ['Present', 'Delayed'].includes(l.status),
      ).length;
      const rateThis =
        monthLogs.length > 0
          ? round1((goodThis / monthLogs.length) * 100)
          : headcount > 0
            ? round1((todayLogs.length / headcount) * 100)
            : 0;

      const slipsByMonth = new Map();
      slips.forEach((s) => {
        const list = slipsByMonth.get(s.month) || [];
        list.push(s);
        slipsByMonth.set(s.month, list);
      });

      const currentKey = slipKeys[slipKeys.length - 1];
      const currentSlips = slipsByMonth.get(currentKey) || [];
      const payrollMtd =
        currentSlips.reduce((s, x) => s + (Number(x.net) || 0), 0) || salarySum;
      const slipNetByUser = new Map(
        currentSlips.map((s) => [String(s.userId), Number(s.net) || 0]),
      );
      const presentSet = new Set(todayLogs.map((l) => String(l.userId)));

      const branchesOut = branches.map((b) => {
        const bEmps = employees.filter(
          (e) => e.branchId && String(e.branchId) === String(b._id),
        );
        const present = bEmps.filter((e) => presentSet.has(String(e._id))).length;
        const attendance =
          bEmps.length > 0 ? round1((present / bEmps.length) * 100) : 0;
        let payroll = 0;
        bEmps.forEach((e) => {
          payroll += slipNetByUser.has(String(e._id))
            ? slipNetByUser.get(String(e._id))
            : Number(e.salary) || 0;
        });
        return {
          id: String(b._id),
          name: b.name,
          code: b.code,
          company: company?.name || '',
          employees: bEmps.length,
          attendance,
          payroll,
          payrollLabel: formatInr(payroll),
          active: bEmps.length,
          status: b.status || 'Active',
          isHeadOffice: !!b.isHeadOffice,
        };
      });

      // Employee growth — new joiners per month (last 6)
      const employeeGrowth = [];
      for (let i = 5; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const start = monthStart(d.getFullYear(), d.getMonth());
        const end = monthEnd(d.getFullYear(), d.getMonth());
        const count = allUsers.filter((u) => {
          if (!u.createdAt) return false;
          const c = new Date(u.createdAt);
          return c >= start && c <= end;
        }).length;
        employeeGrowth.push({ label: MONTH_SHORT[d.getMonth()], value: count });
      }

      // Attendance trend — last 7 months
      const attendanceTrend = await Promise.all(
        months.map(async ({ year, monthIndex }) => {
          const prefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
          const logs =
            empIds.length
              ? await AttendanceLog.find({
                  userId: { $in: empIds },
                  date: { $regex: `^${prefix}` },
                }).select('status')
              : [];
          const good = logs.filter((l) =>
            ['Present', 'Delayed'].includes(l.status),
          ).length;
          const rate =
            logs.length > 0
              ? round1((good / logs.length) * 100)
              : monthIndex === now.getMonth() && year === now.getFullYear()
                ? rateThis
                : 0;
          return { label: MONTH_SHORT[monthIndex], value: rate };
        }),
      );

      const recentAudit = recentUsers.map((u) => {
        const wasCreated =
          u.createdAt &&
          u.updatedAt &&
          Math.abs(new Date(u.updatedAt) - new Date(u.createdAt)) < 5000;
        return {
          actor: req.user.name || 'Admin',
          action: wasCreated
            ? `Created user ${u.name}${u.employeeId ? ` (${u.employeeId})` : ''}`
            : u.isActive === false
              ? `Updated account ${u.name} (inactive)`
              : `Updated account ${u.name}`,
          time: (() => {
            const diffMs = Date.now() - new Date(u.updatedAt || u.createdAt).getTime();
            const mins = Math.floor(diffMs / 60000);
            if (mins < 60) return `${Math.max(1, mins)}m ago`;
            const hours = Math.floor(mins / 60);
            if (hours < 24) return `${hours}h ago`;
            return `${Math.floor(hours / 24)}d ago`;
          })(),
        };
      });

      const storageUsed = Math.min(
        95,
        Math.round(15 + headcount / 10 + branches.length * 3),
      );
      const databaseLoad = Math.min(
        90,
        Math.round(20 + (todayLogs.length / Math.max(headcount, 1)) * 40),
      );

      return sendSuccess(res, {
        admin: {
          name: req.user.name,
          role: req.user.role || 'Super Admin',
          email: req.user.email,
        },
        company: company
          ? {
              id: String(company._id),
              name: company.name,
              slug: company.slug,
              city: company.city || '',
              status: company.status || 'Active',
            }
          : null,
        dateLabel: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        summary: {
          branches: branches.length,
          departments: departments.length,
          employees: headcount,
          attendanceRate: rateThis,
          payrollMtd,
          payrollMtdLabel: formatInr(payrollMtd),
        },
        branches: branchesOut,
        employeeGrowth,
        attendanceTrend,
        recentAudit,
        health: {
          apiUptime: 99.9,
          databaseLoad,
          storageUsed,
          activeSessions: Math.min(100, Math.round((sessions / Math.max(headcount, 1)) * 100) || sessions),
        },
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

/**
 * GET /api/dashboard/branch-head
 * Branch-scoped overview for Branch Head / HR (own branch).
 */
router.get(
  '/branch-head',
  protect,
  authorize('create_department', 'view_all_attendance'),
  async (req, res) => {
    try {
      const branchId = req.user.branchId ? String(req.user.branchId) : null;
      const companyId = req.user.companyId ? String(req.user.companyId) : null;

      if (!branchId) {
        return sendSuccess(res, {
          admin: {
            name: req.user.name,
            role: req.user.role || 'Branch Head',
            email: req.user.email,
          },
          branch: null,
          company: null,
          dateLabel: new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
          summary: {
            employees: 0,
            managers: 0,
            hrs: 0,
            attendanceRate: 0,
            attendanceDelta: null,
            pendingLeave: 0,
            departments: 0,
            teams: 0,
          },
          attendanceSplit: [],
          leaveSplit: [],
          departments: [],
          teams: [],
          recentActivity: [],
          pendingLeaves: [],
        });
      }

      const branchObjId = toObjectId(branchId);
      const today = formatDate();
      const now = new Date();
      const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevPrefix = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

      const userFilter = {
        ...ACTIVE_EMPLOYEE_FILTER,
        branchId: branchObjId,
        ...(companyId ? { companyId: toObjectId(companyId) } : {}),
      };

      const [branch, company, employees, departments, teams, pendingLeaves] =
        await Promise.all([
          Branch.findById(branchObjId),
          companyId ? Company.findById(toObjectId(companyId)) : null,
          User.find(userFilter).select(
            'name email role systemRole dept avatar employeeId status delayCount departmentId teamId teamIds createdAt',
          ),
          Department.find({ branchId: branchObjId }).sort({ name: 1 }),
          Team.find({ branchId: branchObjId }).sort({ name: 1 }),
          LeaveRequest.find({
            branchId: branchObjId,
            status: 'Pending',
          })
            .populate('userId', 'name avatar employeeId dept')
            .sort({ createdAt: -1 })
            .limit(8),
        ]);

      const empIds = employees.map((e) => e._id);
      const headcount = employees.length;
      const managers = employees.filter((e) => e.systemRole === 'manager').length;
      const hrs = employees.filter((e) => e.systemRole === 'hr').length;

      const [todayLogs, monthLogs, prevMonthLogs, leaveCounts, notifData] =
        await Promise.all([
          empIds.length
            ? AttendanceLog.find({
                date: today,
                userId: { $in: empIds },
                timeIn: { $exists: true, $ne: '' },
              }).select('userId status timeIn')
            : [],
          empIds.length
            ? AttendanceLog.find({
                userId: { $in: empIds },
                date: { $regex: `^${monthPrefix}` },
              }).select('status')
            : [],
          empIds.length
            ? AttendanceLog.find({
                userId: { $in: empIds },
                date: { $regex: `^${prevPrefix}` },
              }).select('status')
            : [],
          LeaveRequest.aggregate([
            {
              $match: {
                branchId: branchObjId,
                status: { $in: ['Pending', 'Approved', 'Rejected'] },
              },
            },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ]),
          buildNotifications(req.user).catch(() => ({ notifications: [] })),
        ]);

      const presentSet = new Set(todayLogs.map((l) => String(l.userId)));
      const present = todayLogs.length;
      const onLeave = employees.filter((e) => e.status === 'On Leave').length;
      const absent = Math.max(0, headcount - present - onLeave);
      const late = todayLogs.filter((l) => l.status === 'Delayed').length;

      const goodThis = monthLogs.filter((l) =>
        ['Present', 'Delayed'].includes(l.status),
      ).length;
      const rateThis =
        monthLogs.length > 0
          ? round1((goodThis / monthLogs.length) * 100)
          : headcount > 0
            ? round1((present / headcount) * 100)
            : 0;
      const goodPrev = prevMonthLogs.filter((l) =>
        ['Present', 'Delayed'].includes(l.status),
      ).length;
      const ratePrev =
        prevMonthLogs.length > 0
          ? round1((goodPrev / prevMonthLogs.length) * 100)
          : rateThis;

      const leaveByStatus = Object.fromEntries(
        leaveCounts.map((r) => [r._id, r.count]),
      );

      const deptOut = await Promise.all(
        departments.map(async (d) => {
          const count = employees.filter(
            (e) => e.departmentId && String(e.departmentId) === String(d._id),
          ).length;
          return {
            id: String(d._id),
            name: d.name,
            code: d.code || '',
            employees: count,
            status: d.status || 'Active',
          };
        }),
      );

      const teamsOut = await Promise.all(
        teams.map(async (t) => {
          const members = await User.countDocuments(
            teamMemberFilter(t._id, { isActive: { $ne: false } }),
          );
          const manager = t.managerId
            ? employees.find((e) => String(e._id) === String(t.managerId))
            : null;
          return {
            id: String(t._id),
            name: t.name,
            members,
            managerName: manager?.name || '',
            departmentId: t.departmentId ? String(t.departmentId) : null,
          };
        }),
      );

      const recentActivity = todayLogs
        .slice()
        .sort((a, b) => String(b.timeIn || '').localeCompare(String(a.timeIn || '')))
        .slice(0, 10)
        .map((l) => {
          const emp = employees.find((e) => String(e._id) === String(l.userId));
          return {
            name: emp?.name || 'Employee',
            avatar: resolveAvatar(emp?.avatar, emp?.name),
            action: l.status === 'Delayed' ? 'checked in late' : 'checked in',
            time: l.timeIn || '',
            dept: emp?.dept || '',
          };
        });

      (notifData.notifications || []).slice(0, 5).forEach((n) => {
        recentActivity.push({
          name: n.title || 'System',
          avatar: null,
          action: n.message || n.title || '',
          time: n.time || '',
          dept: '',
        });
      });

      return sendSuccess(res, {
        admin: {
          name: req.user.name,
          role: req.user.role || 'Branch Head',
          email: req.user.email,
        },
        branch: branch
          ? {
              id: String(branch._id),
              name: branch.name,
              code: branch.code,
              city: branch.city || '',
              isHeadOffice: !!branch.isHeadOffice,
            }
          : null,
        company: company
          ? {
              id: String(company._id),
              name: company.name,
              slug: company.slug,
            }
          : null,
        dateLabel: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        summary: {
          employees: headcount,
          managers,
          hrs,
          attendanceRate: rateThis,
          attendanceDelta: round1(rateThis - ratePrev),
          pendingLeave: leaveByStatus.Pending || 0,
          departments: departments.length,
          teams: teams.length,
          presentToday: present,
          lateToday: late,
          absentToday: absent,
        },
        attendanceSplit: [
          { label: 'Present', value: present },
          { label: 'Late', value: late },
          { label: 'On Leave', value: onLeave },
          { label: 'Absent', value: absent },
        ],
        leaveSplit: [
          { label: 'Approved', value: leaveByStatus.Approved || 0 },
          { label: 'Pending', value: leaveByStatus.Pending || 0 },
          { label: 'Rejected', value: leaveByStatus.Rejected || 0 },
        ],
        departments: deptOut,
        teams: teamsOut,
        recentActivity: recentActivity.slice(0, 12),
        pendingLeaves: pendingLeaves.map((l) => ({
          id: String(l._id),
          name: l.userId?.name || 'Employee',
          avatar: resolveAvatar(l.userId?.avatar, l.userId?.name),
          leaveType: l.leaveType,
          days: l.days,
          startDate: l.startDate,
          endDate: l.endDate,
          status: l.status,
        })),
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

/**
 * GET /api/dashboard/hr
 * Branch-scoped HR home — joinees, leave, documents, hiring trend.
 */
router.get(
  '/hr',
  protect,
  authorize('create_employees', 'manage_salary'),
  async (req, res) => {
    try {
      const branchId = req.user.branchId ? String(req.user.branchId) : null;
      const companyId = req.user.companyId ? String(req.user.companyId) : null;
      const branchObjId = branchId ? toObjectId(branchId) : null;
      const today = formatDate();
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const since30 = new Date(now);
      since30.setDate(since30.getDate() - 30);

      const userFilter = {
        ...ACTIVE_EMPLOYEE_FILTER,
        ...(companyId ? { companyId: toObjectId(companyId) } : {}),
        ...(branchObjId ? { branchId: branchObjId } : {}),
      };

      const Onboarding = require('../models/Onboarding');
      const EmployeeDocument = require('../models/EmployeeDocument');

      const [branch, company, employees, pendingLeaves, leaveCounts, docsPending] =
        await Promise.all([
          branchObjId ? Branch.findById(branchObjId) : null,
          companyId ? Company.findById(toObjectId(companyId)) : null,
          User.find(userFilter)
            .select(
              'name role systemRole dept avatar employeeId status createdAt departmentId',
            )
            .sort({ createdAt: -1 }),
          LeaveRequest.find({
            ...(branchObjId ? { branchId: branchObjId } : {}),
            ...(companyId ? { companyId: toObjectId(companyId) } : {}),
            status: 'Pending',
          })
            .populate('userId', 'name avatar employeeId dept')
            .sort({ createdAt: -1 })
            .limit(8),
          LeaveRequest.aggregate([
            {
              $match: {
                ...(branchObjId ? { branchId: branchObjId } : {}),
                ...(companyId ? { companyId: toObjectId(companyId) } : {}),
                status: { $in: ['Pending', 'Approved', 'Rejected'] },
              },
            },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ]),
          EmployeeDocument.countDocuments({
            status: 'Pending',
            ...(branchObjId ? { branchId: branchObjId } : {}),
            ...(companyId ? { companyId: toObjectId(companyId) } : {}),
          }),
        ]);

      const headcount = employees.length;
      const newJoinees = employees.filter(
        (e) => e.createdAt && new Date(e.createdAt) >= thisMonthStart,
      );
      const recentJoinees = employees
        .filter((e) => e.createdAt && new Date(e.createdAt) >= since30)
        .slice(0, 10)
        .map((e) => ({
          id: String(e._id),
          name: e.name,
          role: e.role || e.systemRole,
          dept: e.dept || '',
          avatar: resolveAvatar(e.avatar, e.name),
          date: e.createdAt
            ? new Date(e.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })
            : '',
        }));

      const leaveByStatus = Object.fromEntries(
        leaveCounts.map((r) => [r._id, r.count]),
      );

      const empIds = employees.map((e) => e._id);
      const todayLogs = empIds.length
        ? await AttendanceLog.find({
            date: today,
            userId: { $in: empIds },
            timeIn: { $exists: true, $ne: '' },
          }).select('userId status')
        : [];

      const onboardingPending = await Onboarding.countDocuments({
        status: 'In Progress',
        userId: { $in: empIds },
      });

      const alerts = [];
      if (leaveByStatus.Pending) {
        alerts.push({
          text: `${leaveByStatus.Pending} leave request(s) awaiting review`,
          time: 'Today',
          tone: 'warning',
        });
      }
      if (docsPending) {
        alerts.push({
          text: `${docsPending} document(s) pending verification`,
          time: 'Today',
          tone: 'danger',
        });
      }
      if (onboardingPending) {
        alerts.push({
          text: `${onboardingPending} joinee(s) still onboarding`,
          time: 'This month',
          tone: 'info',
        });
      }
      const lateToday = todayLogs.filter((l) => l.status === 'Delayed').length;
      if (lateToday) {
        alerts.push({
          text: `${lateToday} late check-in(s) today`,
          time: 'Today',
          tone: 'warning',
        });
      }

      const hiringTrend = [];
      for (let i = 5; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const start = monthStart(d.getFullYear(), d.getMonth());
        const end = monthEnd(d.getFullYear(), d.getMonth());
        const count = employees.filter((u) => {
          if (!u.createdAt) return false;
          const c = new Date(u.createdAt);
          return c >= start && c <= end;
        }).length;
        hiringTrend.push({ label: MONTH_SHORT[d.getMonth()], value: count });
      }

      return sendSuccess(res, {
        admin: {
          name: req.user.name,
          role: req.user.role || 'HR',
          email: req.user.email,
        },
        branch: branch
          ? {
              id: String(branch._id),
              name: branch.name,
              code: branch.code,
              city: branch.city || '',
            }
          : null,
        company: company
          ? { id: String(company._id), name: company.name, slug: company.slug }
          : null,
        dateLabel: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        summary: {
          employees: headcount,
          newJoinees: newJoinees.length,
          pendingLeave: leaveByStatus.Pending || 0,
          pendingDocuments: docsPending,
          onboardingInProgress: onboardingPending,
          presentToday: todayLogs.length,
        },
        leaveSplit: [
          { label: 'Approved', value: leaveByStatus.Approved || 0 },
          { label: 'Pending', value: leaveByStatus.Pending || 0 },
          { label: 'Rejected', value: leaveByStatus.Rejected || 0 },
        ],
        recentJoinees,
        pendingLeaves: pendingLeaves.map((l) => ({
          id: String(l._id),
          name: l.userId?.name || 'Employee',
          avatar: resolveAvatar(l.userId?.avatar, l.userId?.name),
          leaveType: l.leaveType,
          days: l.days,
          duration: `${l.days} day(s)`,
          appliedOn: l.createdAt
            ? new Date(l.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
              })
            : '',
          status: l.status,
        })),
        alerts,
        hiringTrend,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

/**
 * GET /api/dashboard/manager — team-scoped manager home
 */
router.get(
  '/manager',
  protect,
  authorize('view_team_attendance', 'approve_leave', 'manage_tasks'),
  async (req, res) => {
    try {
      const Task = require('../models/Task');
      const { getUserTeamIdList, teamMemberFilter } = require('../utils/teamMembership');
      const today = formatDate();
      const now = new Date();
      const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const teamIds = getUserTeamIdList(req.user);
      const managedTeams = await Team.find({
        $or: [
          { managerId: req.user._id },
          ...(teamIds.length ? [{ _id: { $in: teamIds } }] : []),
        ],
        ...(req.user.companyId ? { companyId: req.user.companyId } : {}),
      }).sort({ name: 1 });

      const allTeamIds = managedTeams.map((t) => t._id);
      let members = [];
      if (allTeamIds.length) {
        members = await User.find({
          ...ACTIVE_EMPLOYEE_FILTER,
          $or: [
            { teamId: { $in: allTeamIds } },
            { teamIds: { $in: allTeamIds } },
            { managerId: req.user._id },
          ],
        }).select(
          'name role systemRole dept avatar employeeId status teamId teamIds delayCount',
        );
      } else {
        members = await User.find({
          ...ACTIVE_EMPLOYEE_FILTER,
          managerId: req.user._id,
        }).select(
          'name role systemRole dept avatar employeeId status teamId teamIds delayCount',
        );
      }

      // Always include self in count context but exclude from member table optionally
      const memberIds = members.map((m) => m._id);
      const [todayLogs, pendingLeaves, tasks, branch] = await Promise.all([
        memberIds.length
          ? AttendanceLog.find({
              date: today,
              userId: { $in: memberIds },
              timeIn: { $exists: true, $ne: '' },
            }).select('userId status')
          : [],
        LeaveRequest.find({
          userId: { $in: memberIds.length ? memberIds : [req.user._id] },
          status: 'Pending',
        })
          .populate('userId', 'name avatar')
          .sort({ createdAt: -1 })
          .limit(8),
        Task.find({
          $or: [
            { assigneeId: { $in: [...memberIds, req.user._id] } },
            { assignerId: req.user._id },
          ],
        }).select('assigneeId status'),
        req.user.branchId ? Branch.findById(req.user.branchId) : null,
      ]);

      const presentSet = new Set(todayLogs.map((l) => String(l.userId)));
      const present = todayLogs.length;
      const onLeave = members.filter((m) => m.status === 'On Leave').length;
      const absent = Math.max(0, members.length - present - onLeave);
      const rate =
        members.length > 0 ? round1((present / members.length) * 100) : 0;

      const tasksByUser = new Map();
      tasks.forEach((t) => {
        const id = String(t.assigneeId);
        const cur = tasksByUser.get(id) || { total: 0, done: 0 };
        cur.total += 1;
        if (t.status === 'Completed') cur.done += 1;
        tasksByUser.set(id, cur);
      });

      const memberRows = members.map((m) => {
        const id = String(m._id);
        const t = tasksByUser.get(id) || { total: 0, done: 0 };
        const isPresent = presentSet.has(id);
        const status = m.status === 'On Leave' ? 'On Leave' : isPresent ? 'Present' : 'Absent';
        const performance =
          t.total > 0
            ? Math.round((t.done / t.total) * 100)
            : isPresent
              ? 85
              : 60;
        return {
          id,
          name: m.name,
          role: m.role || m.systemRole,
          avatar: resolveAvatar(m.avatar, m.name),
          status,
          tasks: t.total,
          done: t.done,
          performance,
        };
      });

      const primaryTeam = managedTeams[0];

      return sendSuccess(res, {
        admin: {
          name: req.user.name,
          role: req.user.role || 'Manager',
          email: req.user.email,
        },
        team: primaryTeam
          ? { id: String(primaryTeam._id), name: primaryTeam.name }
          : null,
        teams: managedTeams.map((t) => ({
          id: String(t._id),
          name: t.name,
        })),
        branch: branch
          ? { id: String(branch._id), name: branch.name, code: branch.code }
          : null,
        dateLabel: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        summary: {
          members: members.length,
          present,
          onLeave,
          absent,
          attendanceRate: rate,
          pendingLeave: pendingLeaves.length,
          openTasks: tasks.filter((t) => t.status !== 'Completed').length,
        },
        attendanceSplit: [
          { label: 'Present', value: present },
          { label: 'On Leave', value: onLeave },
          { label: 'Absent', value: absent },
        ],
        performanceSplit: [
          {
            label: 'Exceeds',
            value: memberRows.filter((m) => m.performance >= 85).length,
          },
          {
            label: 'Meets',
            value: memberRows.filter(
              (m) => m.performance >= 70 && m.performance < 85,
            ).length,
          },
          {
            label: 'Needs Focus',
            value: memberRows.filter((m) => m.performance < 70).length,
          },
        ],
        pendingLeaves: pendingLeaves.map((l) => ({
          id: String(l._id),
          name: l.userId?.name || 'Employee',
          avatar: resolveAvatar(l.userId?.avatar, l.userId?.name),
          leaveType: l.leaveType,
          days: l.days,
          duration: `${l.days} day(s)`,
          status: l.status,
        })),
        members: memberRows,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

/**
 * GET /api/dashboard/employee — personal employee home
 */
router.get('/employee', protect, async (req, res) => {
  try {
    const Task = require('../models/Task');
    const today = formatDate();
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [todayAtt, monthLogs, slips, tasks, leaveApproved, branch, team] =
      await Promise.all([
        AttendanceLog.findOne({ userId: req.user._id, date: today }),
        AttendanceLog.find({
          userId: req.user._id,
          date: { $regex: `^${monthPrefix}` },
        }).select('status date timeIn timeOut'),
        SalarySlip.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(6),
        Task.find({ assigneeId: req.user._id }).sort({ dueDate: 1 }).limit(20),
        LeaveRequest.find({
          userId: req.user._id,
          status: 'Approved',
          startDate: { $regex: `^${now.getFullYear()}` },
        }).select('days'),
        req.user.branchId ? Branch.findById(req.user.branchId) : null,
        req.user.teamId ? Team.findById(req.user.teamId) : null,
      ]);

    const good = monthLogs.filter((l) =>
      ['Present', 'Delayed'].includes(l.status),
    ).length;
    const attendanceRate =
      monthLogs.length > 0 ? round1((good / monthLogs.length) * 100) : 100;
    const leaveUsed = leaveApproved.reduce((s, l) => s + (Number(l.days) || 0), 0);
    const leaveBalance = Math.max(0, 18 - leaveUsed);

    // Last 7 days hours
    const weekDates = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      weekDates.push({ d, key: formatDate(d) });
    }
    const weekLogs = await AttendanceLog.find({
      userId: req.user._id,
      date: { $in: weekDates.map((w) => w.key) },
    }).select('date status');
    const weekLogByDate = new Map(weekLogs.map((l) => [l.date, l]));
    const week = weekDates.map(({ d, key }) => {
      const log = weekLogByDate.get(key);
      const hours =
        log && ['Present', 'Delayed'].includes(log.status) ? 8 : 0;
      return {
        label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
        value: hours,
      };
    });

    const presentDays = monthLogs.filter((l) =>
      ['Present', 'Delayed'].includes(l.status),
    ).length;
    const leaveDays = monthLogs.filter((l) => l.status === 'On Leave').length;
    const absentDays = Math.max(0, monthLogs.length - presentDays - leaveDays);

    const latestSlip = slips[0];
    const todayIso = new Date().toISOString().slice(0, 10);
    let holidays = [];
    if (req.user.companyId) {
      await ensureDefaults([String(req.user.companyId)]);
      const holidayFilter = {
        companyId: req.user.companyId,
        date: { $gte: todayIso },
        $or: [{ branchId: null }],
      };
      if (req.user.branchId) {
        holidayFilter.$or.push({ branchId: req.user.branchId });
      }
      const rows = await Holiday.find(holidayFilter).sort({ date: 1 }).limit(8);
      holidays = rows.map((h) => ({
        id: String(h._id),
        name: h.name,
        date: formatHolidayDate(h.date),
        dateIso: h.date,
      }));
    }

    return sendSuccess(res, {
      admin: {
        name: req.user.name,
        role: req.user.role || req.user.systemRole,
        email: req.user.email,
        employeeId: req.user.employeeId || '',
        dept: req.user.dept || '',
      },
      branch: branch
        ? { id: String(branch._id), name: branch.name, code: branch.code }
        : null,
      team: team ? { id: String(team._id), name: team.name } : null,
      dateLabel: new Date().toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
      summary: {
        checkInTime: todayAtt?.timeIn || null,
        checkOutTime: todayAtt?.timeOut || null,
        leaveBalance,
        lastPayslip: latestSlip ? Number(latestSlip.net) || 0 : 0,
        lastPayslipLabel: latestSlip
          ? formatInr(latestSlip.net)
          : '₹0',
        attendanceRate,
        openTasks: tasks.filter((t) => t.status !== 'Completed').length,
      },
      attendanceWeek: week,
      attendanceSplit: [
        { label: 'Present', value: presentDays || good },
        { label: 'Leave', value: leaveDays },
        { label: 'Absent', value: absentDays },
      ],
      payslips: slips.map((s) => ({
        id: String(s._id),
        month: s.month,
        net: Number(s.net) || 0,
        netLabel: formatInr(s.net),
        status: 'Paid',
      })),
      tasks: tasks.slice(0, 5).map((t) => ({
        id: String(t._id),
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate || '',
      })),
      holidays,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
