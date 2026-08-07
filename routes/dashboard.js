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
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, formatDate } = require('../utils/helpers');
const {
  ACTIVE_EMPLOYEE_FILTER,
  getTodayAbsentUsers,
} = require('../utils/absences');
const { buildNotifications } = require('../utils/notifications');

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

module.exports = router;
