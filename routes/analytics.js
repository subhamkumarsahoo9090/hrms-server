const express = require('express');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const AttendanceLog = require('../models/AttendanceLog');
const SalarySlip = require('../models/SalarySlip');
const { protect } = require('../middleware/auth');
const { isBranchScopedRole } = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, formatDate } = require('../utils/helpers');

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

function monthEnd(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
}

function monthStart(year, monthIndex) {
  return new Date(year, monthIndex, 1, 0, 0, 0, 0);
}

function monthLabel(year, monthIndex) {
  return MONTH_SHORT[monthIndex];
}

function salaryMonthKey(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
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

async function resolveCompanyScope(user) {
  if (user.systemRole === 'company_owner') {
    return resolveOwnerCompanyIds(user);
  }
  if (user.companyId) return [String(user.companyId)];
  return [];
}

function baseUserFilter(companyIds, user) {
  const filter = {
    companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
  };
  if (isBranchScopedRole(user.systemRole) && user.branchId) {
    filter.branchId = user.branchId;
  }
  return filter;
}

// GET /api/analytics — org analytics for owner console
router.get('/', protect, async (req, res) => {
  try {
    const companyIds = await resolveCompanyScope(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, {
        summary: {
          headcount: 0,
          attritionRate: 0,
          retentionRate: 100,
          costPerEmployee: 0,
          costPerEmployeeLabel: '₹0',
          monthlyPayroll: 0,
          monthlyPayrollLabel: '₹0',
          headcountYoY: null,
          attritionDelta: null,
        },
        headcountTrend: [],
        payrollTrend: [],
        attritionTrend: [],
        costBreakdown: [],
        companySplit: [],
        branchBenchmark: [],
        periodLabel: 'Last 7 months',
      });
    }

    const userFilter = baseUserFilter(companyIds, req.user);
    const users = await User.find(userFilter).select(
      'companyId branchId salary isActive status createdAt updatedAt systemRole',
    );

    const activeUsers = users.filter((u) => u.isActive !== false);
    const inactiveUsers = users.filter((u) => u.isActive === false);
    const headcount = activeUsers.length;

    const salarySum = activeUsers.reduce((s, u) => s + (Number(u.salary) || 0), 0);
    const costPerEmployee = headcount > 0 ? Math.round(salarySum / headcount) : 0;

    const now = new Date();
    const months = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), monthIndex: d.getMonth() });
    }

    const slipMonths = months.map((m) => salaryMonthKey(m.year, m.monthIndex));
    const userIds = users.map((u) => u._id);
    const slips = userIds.length
      ? await SalarySlip.find({
          userId: { $in: userIds },
          month: { $in: slipMonths },
        })
      : [];

    const slipsByMonth = new Map();
    slips.forEach((s) => {
      const list = slipsByMonth.get(s.month) || [];
      list.push(s);
      slipsByMonth.set(s.month, list);
    });

    const headcountTrend = [];
    const payrollTrend = [];
    const attritionTrend = [];

    months.forEach(({ year, monthIndex }) => {
      const end = monthEnd(year, monthIndex);
      const start = monthStart(year, monthIndex);
      const label = monthLabel(year, monthIndex);
      const key = salaryMonthKey(year, monthIndex);

      // Users who existed by month end: createdAt <= end, and not deactivated before month start
      const monthHeadcount = users.filter((u) => {
        if (!u.createdAt || new Date(u.createdAt) > end) return false;
        if (u.isActive === false && u.updatedAt && new Date(u.updatedAt) < start) return false;
        return true;
      }).length;

      const exits = users.filter((u) => {
        if (u.isActive !== false) return false;
        if (!u.updatedAt) return false;
        const t = new Date(u.updatedAt);
        return t >= start && t <= end;
      }).length;

      const attrition =
        monthHeadcount > 0 ? round1((exits / monthHeadcount) * 100) : 0;

      const monthSlips = slipsByMonth.get(key) || [];
      let payroll = monthSlips.reduce((s, slip) => s + (Number(slip.net) || 0), 0);
      if (!payroll) {
        // Estimate from active salaries at that month
        payroll = users
          .filter((u) => {
            if (!u.createdAt || new Date(u.createdAt) > end) return false;
            if (u.isActive === false && u.updatedAt && new Date(u.updatedAt) < start) return false;
            return true;
          })
          .reduce((s, u) => s + (Number(u.salary) || 0), 0);
      }

      headcountTrend.push({ label, value: monthHeadcount });
      payrollTrend.push({ label, value: Math.round(payroll) });
      attritionTrend.push({ label, value: attrition });
    });

    const currentAttrition =
      attritionTrend.length > 0 ? attritionTrend[attritionTrend.length - 1].value : 0;
    const prevAttrition =
      attritionTrend.length > 1 ? attritionTrend[attritionTrend.length - 2].value : currentAttrition;
    const attritionDelta = round1(currentAttrition - prevAttrition);

    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const headcountYearAgo = users.filter((u) => {
      if (!u.createdAt || new Date(u.createdAt) > yearAgo) return false;
      if (u.isActive === false && u.updatedAt && new Date(u.updatedAt) < yearAgo) return false;
      return true;
    }).length;
    const headcountYoY =
      headcountYearAgo > 0
        ? round1(((headcount - headcountYearAgo) / headcountYearAgo) * 100)
        : null;

    const retentionRate = round1(100 - currentAttrition);

    // Cost breakdown from latest month slips, fallback to estimates
    const latestKey = slipMonths[slipMonths.length - 1];
    const latestSlips = slipsByMonth.get(latestKey) || [];
    let costBreakdown;
    let monthlyPayroll = payrollTrend[payrollTrend.length - 1]?.value || salarySum;

    if (latestSlips.length) {
      const basic = latestSlips.reduce((s, x) => s + (Number(x.basic) || 0), 0);
      const benefits = latestSlips.reduce(
        (s, x) => s + (Number(x.allowances) || 0) + (Number(x.bonus) || 0),
        0,
      );
      const statutory = latestSlips.reduce(
        (s, x) => s + (Number(x.tax) || 0) + (Number(x.pf) || 0),
        0,
      );
      const totalParts = basic + benefits + statutory || 1;
      const salPct = Math.round((basic / totalParts) * 100);
      const benPct = Math.round((benefits / totalParts) * 100);
      const statPct = Math.round((statutory / totalParts) * 100);
      costBreakdown = [
        { label: 'Salaries', value: salPct || 72 },
        { label: 'Benefits', value: benPct || 14 },
        { label: 'Statutory', value: statPct || 9 },
        {
          label: 'Other',
          value: Math.max(0, 100 - (salPct || 72) - (benPct || 14) - (statPct || 9)),
        },
      ];
      monthlyPayroll = latestSlips.reduce((s, x) => s + (Number(x.net) || 0), 0) || monthlyPayroll;
    } else {
      costBreakdown = [
        { label: 'Salaries', value: 72 },
        { label: 'Benefits', value: 14 },
        { label: 'Statutory', value: 9 },
        { label: 'Other', value: 5 },
      ];
    }

    // Company split
    const companies = await Company.find({
      _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    });
    const companyById = new Map(companies.map((c) => [String(c._id), c]));
    const companyCounts = new Map();
    activeUsers.forEach((u) => {
      const id = u.companyId ? String(u.companyId) : '';
      companyCounts.set(id, (companyCounts.get(id) || 0) + 1);
    });
    const companySplit = [...companyCounts.entries()]
      .map(([id, value]) => ({
        label: companyById.get(id)?.name || 'Unknown',
        value,
        companyId: id || null,
      }))
      .sort((a, b) => b.value - a.value);

    // Branch benchmark
    const branchFilter = {
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      branchFilter._id = req.user.branchId;
    }
    const branches = await Branch.find(branchFilter).sort({ name: 1 });

    const today = formatDate();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const activeIds = activeUsers.map((u) => u._id);

    const [todayLogs, monthLogs] = await Promise.all([
      activeIds.length
        ? AttendanceLog.find({
            date: today,
            userId: { $in: activeIds },
            timeIn: { $exists: true, $ne: '' },
          }).select('userId')
        : [],
      activeIds.length
        ? AttendanceLog.find({
            date: { $regex: `^${monthPrefix}` },
            userId: { $in: activeIds },
          }).select('userId status')
        : [],
    ]);

    const presentToday = new Set(todayLogs.map((l) => String(l.userId)));
    const monthLogsByUser = new Map();
    monthLogs.forEach((l) => {
      const id = String(l.userId);
      const list = monthLogsByUser.get(id) || [];
      list.push(l);
      monthLogsByUser.set(id, list);
    });

    const branchBenchmark = branches.map((b) => {
      const branchUsers = activeUsers.filter(
        (u) => u.branchId && String(u.branchId) === String(b._id),
      );
      const empCount = branchUsers.length;
      const payroll = branchUsers.reduce((s, u) => s + (Number(u.salary) || 0), 0);

      let attendance = 0;
      if (empCount > 0) {
        // Prefer MTD attendance rate from logs; fallback to today present %
        let presentish = 0;
        let total = 0;
        branchUsers.forEach((u) => {
          const logs = monthLogsByUser.get(String(u._id)) || [];
          if (logs.length) {
            total += logs.length;
            presentish += logs.filter((l) =>
              ['Present', 'Delayed'].includes(l.status),
            ).length;
          } else if (presentToday.has(String(u._id))) {
            total += 1;
            presentish += 1;
          } else {
            total += 1;
          }
        });
        attendance = total > 0 ? round1((presentish / total) * 100) : 0;
      }

      const company = companyById.get(String(b.companyId));
      return {
        id: String(b._id),
        name: b.name,
        code: b.code,
        company: company?.name || '',
        companyId: String(b.companyId),
        employees: empCount,
        attendance,
        payroll,
        payrollLabel: formatInr(payroll),
        share: headcount > 0 ? round1((empCount / headcount) * 100) : 0,
      };
    });

    return sendSuccess(res, {
      summary: {
        headcount,
        attritionRate: currentAttrition,
        retentionRate,
        costPerEmployee,
        costPerEmployeeLabel: formatInr(costPerEmployee),
        monthlyPayroll,
        monthlyPayrollLabel: formatInr(monthlyPayroll),
        headcountYoY,
        attritionDelta,
        inactiveCount: inactiveUsers.length,
      },
      headcountTrend,
      payrollTrend,
      attritionTrend,
      costBreakdown,
      companySplit,
      branchBenchmark,
      periodLabel: 'Last 7 months',
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
