const express = require('express');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const AttendanceLog = require('../models/AttendanceLog');
const SalarySlip = require('../models/SalarySlip');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { isBranchScopedRole } = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, formatDate } = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');

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

// GET /api/reports/overview
router.get('/overview', protect, authorize('view_all_attendance'), async (req, res) => {
  try {
    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, {
        periodLabel: 'This Month',
        summary: {
          attendanceRate: 0,
          attendanceDelta: null,
          headcount: 0,
          headcountDelta: 0,
          payrollMtd: 0,
          payrollMtdLabel: '₹0',
          newJoinees: 0,
        },
        headcountTrend: [],
        attendanceTrend: [],
        departmentSplit: [],
        departments: [],
        payrollTrend: [],
        employeeGrowth: [],
        topBranches: [],
      });
    }

    const companyObjIds = companyIds.map((id) => toObjectId(id)).filter(Boolean);
    const userFilter = {
      ...ACTIVE_EMPLOYEE_FILTER,
      companyId: { $in: companyObjIds },
    };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      userFilter.branchId = req.user.branchId;
    }

    const employees = await User.find(userFilter).select(
      'dept departmentId branchId companyId salary createdAt isActive',
    );
    const empIds = employees.map((e) => e._id);
    const headcount = employees.length;

    const now = new Date();
    const today = formatDate();
    const monthStartDate = monthStart(now.getFullYear(), now.getMonth());
    const prevMonthStart = monthStart(now.getFullYear(), now.getMonth() - 1);
    const prevMonthEnd = monthEnd(now.getFullYear(), now.getMonth() - 1);

    const newJoinees = employees.filter(
      (e) => e.createdAt && new Date(e.createdAt) >= monthStartDate,
    ).length;

    const months = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), monthIndex: d.getMonth() });
    }

    const allUsersForTrend = await User.find({
      companyId: { $in: companyObjIds },
      ...(userFilter.branchId ? { branchId: userFilter.branchId } : {}),
    }).select('createdAt isActive updatedAt salary');

    const slipKeys = months.map((m) => salaryMonthKey(m.year, m.monthIndex));
    const [todayLogs, monthLogs, prevMonthLogs, slips, departments, branches] =
      await Promise.all([
        empIds.length
          ? AttendanceLog.find({
              date: today,
              userId: { $in: empIds },
              timeIn: { $exists: true, $ne: '' },
            }).select('userId status')
          : [],
        empIds.length
          ? AttendanceLog.find({
              userId: { $in: empIds },
              date: {
                $regex: `^${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
              },
            }).select('status userId')
          : [],
        empIds.length
          ? AttendanceLog.find({
              userId: { $in: empIds },
              date: {
                $regex: `^${prevMonthStart.getFullYear()}-${String(prevMonthStart.getMonth() + 1).padStart(2, '0')}`,
              },
            }).select('status')
          : [],
        empIds.length
          ? SalarySlip.find({ userId: { $in: empIds }, month: { $in: slipKeys } })
          : [],
        Department.find({
          companyId: { $in: companyObjIds },
          ...(userFilter.branchId ? { branchId: userFilter.branchId } : {}),
        }),
        Branch.find({
          companyId: { $in: companyObjIds },
          ...(userFilter.branchId ? { _id: userFilter.branchId } : {}),
        }).sort({ name: 1 }),
      ]);

    const onDutyToday = todayLogs.length;
    const attendanceRate =
      headcount > 0 ? round1((onDutyToday / headcount) * 100) : 0;

    const goodThisMonth = monthLogs.filter((l) =>
      ['Present', 'Delayed'].includes(l.status),
    ).length;
    const rateThisMonth =
      monthLogs.length > 0
        ? round1((goodThisMonth / monthLogs.length) * 100)
        : attendanceRate;
    const goodPrev = prevMonthLogs.filter((l) =>
      ['Present', 'Delayed'].includes(l.status),
    ).length;
    const ratePrev =
      prevMonthLogs.length > 0
        ? round1((goodPrev / prevMonthLogs.length) * 100)
        : rateThisMonth;
    const attendanceDelta = round1(rateThisMonth - ratePrev);

    // Headcount at start of previous month for delta
    const headcountPrev = allUsersForTrend.filter((u) => {
      if (!u.createdAt || new Date(u.createdAt) > prevMonthEnd) return false;
      if (u.isActive === false && u.updatedAt && new Date(u.updatedAt) < prevMonthStart) {
        return false;
      }
      return true;
    }).length;
    const headcountDelta = headcount - headcountPrev;

    const slipsByMonth = new Map();
    slips.forEach((s) => {
      const list = slipsByMonth.get(s.month) || [];
      list.push(s);
      slipsByMonth.set(s.month, list);
    });

    const salarySum = employees.reduce((s, e) => s + (Number(e.salary) || 0), 0);
    const headcountTrend = [];
    const attendanceTrend = [];
    const payrollTrend = [];
    const employeeGrowth = [];

    for (const { year, monthIndex } of months) {
      const label = MONTH_SHORT[monthIndex];
      const start = monthStart(year, monthIndex);
      const end = monthEnd(year, monthIndex);
      const prefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
      const key = salaryMonthKey(year, monthIndex);

      const hc = allUsersForTrend.filter((u) => {
        if (!u.createdAt || new Date(u.createdAt) > end) return false;
        if (u.isActive === false && u.updatedAt && new Date(u.updatedAt) < start) {
          return false;
        }
        return true;
      }).length;
      headcountTrend.push({ label, value: hc });

      const mLogs = empIds.length
        ? await AttendanceLog.find({
            userId: { $in: empIds },
            date: { $regex: `^${prefix}` },
          }).select('status')
        : [];
      const good = mLogs.filter((l) => ['Present', 'Delayed'].includes(l.status)).length;
      const rate = mLogs.length > 0 ? round1((good / mLogs.length) * 100) : rateThisMonth;
      attendanceTrend.push({ label, value: rate });

      const monthSlips = slipsByMonth.get(key) || [];
      let payroll = monthSlips.reduce((s, x) => s + (Number(x.net) || 0), 0);
      if (!payroll) payroll = salarySum;
      payrollTrend.push({ label, value: round1(payroll / 10000000) });

      const joined = allUsersForTrend.filter((u) => {
        if (!u.createdAt) return false;
        const t = new Date(u.createdAt);
        return t >= start && t <= end;
      }).length;
      employeeGrowth.push({ label, value: joined });
    }

    const currentKey = slipKeys[slipKeys.length - 1];
    const currentSlips = slipsByMonth.get(currentKey) || [];
    const payrollMtd =
      currentSlips.reduce((s, x) => s + (Number(x.net) || 0), 0) || salarySum;

    // Department split + performance
    const deptById = new Map(departments.map((d) => [String(d._id), d]));
    const presentToday = new Set(todayLogs.map((l) => String(l.userId)));

    const deptBuckets = new Map();
    employees.forEach((e) => {
      let name = e.dept || 'General';
      if (e.departmentId) {
        const d = deptById.get(String(e.departmentId));
        if (d?.name) name = d.name;
      }
      // Normalize Admin
      if (/^admin/i.test(name)) name = 'Admin';
      const bucket = deptBuckets.get(name) || { employees: 0, present: 0 };
      bucket.employees += 1;
      if (presentToday.has(String(e._id))) bucket.present += 1;
      deptBuckets.set(name, bucket);
    });

    const departmentRows = [...deptBuckets.entries()]
      .map(([name, b]) => ({
        name,
        employees: b.employees,
        present: b.present,
        attendance: b.employees > 0 ? round1((b.present / b.employees) * 100) : 0,
      }))
      .sort((a, b) => b.employees - a.employees);

    const departmentSplit = departmentRows.slice(0, 8).map((d) => ({
      label: d.name,
      value: d.employees,
    }));

    // Top branches by attendance
    const logByUser = new Map(todayLogs.map((l) => [String(l.userId), l]));
    const topBranches = branches
      .map((b) => {
        const branchEmps = employees.filter(
          (e) => e.branchId && String(e.branchId) === String(b._id),
        );
        const present = branchEmps.filter((e) => logByUser.has(String(e._id))).length;
        const score =
          branchEmps.length > 0 ? round1((present / branchEmps.length) * 100) : 0;
        return {
          id: String(b._id),
          name: `${b.name}${b.code ? ` (${b.code})` : ''}`,
          code: b.code,
          score,
          employees: branchEmps.length,
        };
      })
      .filter((b) => b.employees > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    return sendSuccess(res, {
      periodLabel: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      summary: {
        attendanceRate: rateThisMonth,
        attendanceDelta,
        headcount,
        headcountDelta,
        payrollMtd,
        payrollMtdLabel: formatInr(payrollMtd),
        newJoinees,
      },
      headcountTrend,
      attendanceTrend,
      departmentSplit,
      departments: departmentRows,
      payrollTrend,
      employeeGrowth,
      topBranches,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
