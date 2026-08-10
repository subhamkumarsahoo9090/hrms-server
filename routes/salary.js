const express = require('express');
const SalarySlip = require('../models/SalarySlip');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const Team = require('../models/Team');
const Email = require('../models/Email');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  isBranchScopedRole,
  isTeamScopedRole,
  hasPermission,
} = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, formatTime, resolveAvatar } = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER, ATTENDANCE_SCOPE_FILTER } = require('../utils/absences');
const { getUserTeamIdList } = require('../utils/teamMembership');
const {
  seedSalaries,
  calculateSlip: calcFromSeed,
  salaryMonthKey,
} = require('../utils/seedSalaries');

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

function payslipScopeMeta(user) {
  const canViewStaff = hasPermission(user.systemRole, 'view_all_attendance');
  switch (user.systemRole) {
    case 'company_owner':
      return {
        scope: 'company',
        scopeLabel: 'All owned companies',
        isSelfService: false,
        canViewStaff: true,
        canManage: true,
      };
    case 'super_admin':
      return {
        scope: 'company',
        scopeLabel: 'Company-wide',
        isSelfService: false,
        canViewStaff: true,
        canManage: true,
      };
    case 'branch_head':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch',
        isSelfService: false,
        canViewStaff: true,
        canManage: false,
      };
    case 'hr':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch (HR)',
        isSelfService: false,
        canViewStaff: true,
        canManage: true,
      };
    case 'manager':
      return {
        scope: 'team',
        scopeLabel: 'Your team',
        isSelfService: false,
        canViewStaff: true,
        canManage: false,
      };
    default:
      return {
        scope: 'self',
        scopeLabel: 'Personal',
        isSelfService: true,
        canViewStaff: false,
        canManage: false,
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

function round1(n) {
  return Math.round(n * 10) / 10;
}

function formatInr(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 10000000) return `₹${round1(v / 10000000)} Cr`;
  if (v >= 100000) return `₹${round1(v / 100000)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
}

function formatInrFull(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

function mapSlip(slip) {
  return {
    id: String(slip._id),
    month: slip.month,
    basic: slip.basic,
    allowances: slip.allowances,
    bonus: slip.bonus,
    tax: slip.tax,
    pf: slip.pf,
    net: slip.net,
    userId: slip.userId?._id ? String(slip.userId._id) : String(slip.userId),
  };
}

function mapSlipDetailed(slip) {
  const base = mapSlip(slip);
  const u = slip.userId && typeof slip.userId === 'object' ? slip.userId : null;
  return {
    ...base,
    employeeName: u?.name,
    empId: u?.employeeId,
    dept: u?.dept,
    avatar: resolveAvatar(u?.avatar, u?.name),
  };
}

function calculateSlip(salary, month) {
  return calcFromSeed(salary, month);
}

// GET /api/salary/overview — payroll dashboard (role-scoped)
router.get('/overview', protect, authorize('manage_salary'), async (req, res) => {
  try {
    const scopeMeta = payslipScopeMeta(req.user);
    const userFilter = await resolveScopedEmployeeFilter(req.user);
    // Payroll overview stays on payroll admins; still apply branch scope for HR
    const employees = await User.find({
      ...userFilter,
      ...ACTIVE_EMPLOYEE_FILTER,
      systemRole: { $nin: ['company_owner', 'super_admin'] },
    }).select('name salary branchId companyId employeeId dept isActive');

    const empIds = employees.map((e) => e._id);
    const headcount = employees.length;
    const salarySum = employees.reduce((s, e) => s + (Number(e.salary) || 0), 0);
    const avgCtc = headcount > 0 ? Math.round(salarySum / headcount) : 0;

    const now = new Date();
    const months = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), monthIndex: d.getMonth() });
    }

    const slipMonthKeys = months.map((m) => salaryMonthKey(m.year, m.monthIndex));
    const slips = empIds.length
      ? await SalarySlip.find({
          userId: { $in: empIds },
          month: { $in: slipMonthKeys },
        })
      : [];

    const slipsByMonth = new Map();
    slips.forEach((s) => {
      const list = slipsByMonth.get(s.month) || [];
      list.push(s);
      slipsByMonth.set(s.month, list);
    });

    const trend = months.map(({ year, monthIndex }) => {
      const key = salaryMonthKey(year, monthIndex);
      const monthSlips = slipsByMonth.get(key) || [];
      let total = monthSlips.reduce((s, x) => s + (Number(x.net) || 0), 0);
      if (!total) {
        total = salarySum;
      }
      return {
        label: MONTH_SHORT[monthIndex],
        monthKey: key,
        value: round1(total / 10000000),
        amount: total,
        slipCount: monthSlips.length,
        status: monthSlips.length > 0 ? 'Generated' : 'Estimated',
      };
    });

    const current = trend[trend.length - 1];
    const previous = trend[trend.length - 2];
    const totalPayroll = current?.amount || salarySum;
    const lastMonthPayroll = previous?.amount || 0;
    const momChange =
      lastMonthPayroll > 0
        ? round1(((totalPayroll - lastMonthPayroll) / lastMonthPayroll) * 100)
        : null;

    const currentKey = slipMonthKeys[slipMonthKeys.length - 1];
    const currentSlips = slipsByMonth.get(currentKey) || [];
    const employeesPaid = currentSlips.length || headcount;

    let components;
    if (currentSlips.length) {
      const basic = currentSlips.reduce((s, x) => s + (Number(x.basic) || 0), 0);
      const allowances = currentSlips.reduce((s, x) => s + (Number(x.allowances) || 0), 0);
      const statutory = currentSlips.reduce(
        (s, x) => s + (Number(x.tax) || 0) + (Number(x.pf) || 0),
        0,
      );
      const hra = Math.round(allowances * (20 / 38));
      const special = Math.max(0, allowances - hra);
      const totalParts = basic + hra + special + statutory || 1;
      const pct = (n) => Math.round((n / totalParts) * 100);
      const basicPct = pct(basic);
      const hraPct = pct(hra);
      const specialPct = pct(special);
      const statPct = pct(statutory);
      components = [
        { label: 'Basic', value: basicPct || 50 },
        { label: 'HRA', value: hraPct || 20 },
        { label: 'Special Allowance', value: specialPct || 18 },
        {
          label: 'PF & Statutory',
          value:
            Math.max(0, 100 - (basicPct || 50) - (hraPct || 20) - (specialPct || 18)) ||
            statPct ||
            12,
        },
      ];
    } else {
      components = [
        { label: 'Basic', value: 50 },
        { label: 'HRA', value: 20 },
        { label: 'Special Allowance', value: 18 },
        { label: 'PF & Statutory', value: 12 },
      ];
    }

    const companyIds = await resolveCompanyIds(req.user);
    const companyObjIds = companyIds.map((id) => toObjectId(id)).filter(Boolean);
    let branchQuery = { companyId: { $in: companyObjIds } };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      branchQuery = { _id: req.user.branchId };
    }
    const branches = companyObjIds.length
      ? await Branch.find(branchQuery).sort({ name: 1 })
      : [];
    const companies = companyObjIds.length
      ? await Company.find({ _id: { $in: companyObjIds } })
      : [];
    const companyById = new Map(companies.map((c) => [String(c._id), c]));

    const slipUserIds = new Set(currentSlips.map((s) => String(s.userId)));
    const slipNetByUser = new Map(
      currentSlips.map((s) => [String(s.userId), Number(s.net) || 0]),
    );

    const branchRows = branches.map((b) => {
      const branchEmps = employees.filter(
        (e) => e.branchId && String(e.branchId) === String(b._id),
      );
      let payroll = 0;
      let paid = 0;
      branchEmps.forEach((e) => {
        const id = String(e._id);
        if (slipNetByUser.has(id)) {
          payroll += slipNetByUser.get(id);
          paid += 1;
        } else {
          payroll += Number(e.salary) || 0;
        }
      });
      const company = companyById.get(String(b.companyId));
      const hasSlips = branchEmps.some((e) => slipUserIds.has(String(e._id)));
      return {
        id: String(b._id),
        name: b.name,
        code: b.code,
        company: company?.name || '',
        employees: branchEmps.length,
        payroll,
        payrollLabel: formatInr(payroll),
        status: hasSlips || paid > 0 ? 'Processed' : 'Pending',
      };
    });

    const recentPayruns = [...trend]
      .reverse()
      .filter((t) => t.slipCount > 0 || t.amount > 0)
      .slice(0, 6)
      .map((t) => ({
        month: t.monthKey,
        amount: formatInrFull(t.amount),
        amountRaw: t.amount,
        status: t.slipCount > 0 ? 'Generated' : 'Estimated',
        slipCount: t.slipCount,
      }));

    return sendSuccess(res, {
      summary: {
        totalPayroll,
        totalPayrollLabel: formatInr(totalPayroll),
        lastMonthPayroll,
        lastMonthPayrollLabel: formatInr(lastMonthPayroll),
        employeesPaid,
        headcount,
        avgCtc,
        avgCtcLabel: formatInr(avgCtc),
        momChange,
        currentMonth: currentKey,
      },
      trend: trend.map((t) => ({ label: t.label, value: t.value })),
      components,
      branches: branchRows,
      recentPayruns,
      cycleLabel: '1st of every month',
      scope: scopeMeta.scope,
      scopeLabel: scopeMeta.scopeLabel,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/salary/slips — own slips
router.get('/slips', protect, authorize('view_own_payslip'), async (req, res) => {
  try {
    const slips = await SalarySlip.find({ userId: req.user._id })
      .populate('userId', 'name employeeId dept salary avatar branchId companyId')
      .sort({ createdAt: -1 });
    const scopeMeta = payslipScopeMeta(req.user);
    return sendSuccess(res, {
      salarySlips: slips.map(mapSlipDetailed),
      scope: scopeMeta.scope,
      scopeLabel: scopeMeta.scopeLabel,
      isSelfService: true,
      canManage: false,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/salary/slips/all — role-scoped staff slips
router.get(
  '/slips/all',
  protect,
  authorize('manage_salary', 'view_all_attendance'),
  async (req, res) => {
    try {
      const scopeMeta = payslipScopeMeta(req.user);
      const userFilter = await resolveScopedEmployeeFilter(req.user);
      const users = await User.find(userFilter).select('_id');
      const userIds = users.map((u) => u._id);

      const slips = userIds.length
        ? await SalarySlip.find({ userId: { $in: userIds } })
            .populate('userId', 'name employeeId dept salary avatar branchId companyId')
            .sort({ createdAt: -1 })
        : [];

      return sendSuccess(res, {
        salarySlips: slips.map(mapSlipDetailed),
        scope: scopeMeta.scope,
        scopeLabel: scopeMeta.scopeLabel,
        isSelfService: scopeMeta.isSelfService,
        canManage: hasPermission(req.user.systemRole, 'generate_payslip'),
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// GET /api/salary/slips/:id/download
router.get('/slips/:id/download', protect, authorize('view_own_payslip'), async (req, res) => {
  try {
    const slip = await SalarySlip.findById(req.params.id).populate(
      'userId',
      'name employeeId dept companyId branchId',
    );

    if (!slip) {
      return sendError(res, 'Salary slip not found', 404);
    }

    const isOwner = String(slip.userId?._id || slip.userId) === String(req.user._id);
    let allowed = isOwner || hasPermission(req.user.systemRole, 'manage_salary');

    if (!allowed && hasPermission(req.user.systemRole, 'view_all_attendance')) {
      const filter = await resolveScopedEmployeeFilter(req.user);
      const targetId = slip.userId?._id || slip.userId;
      const inScope = await User.exists({ ...filter, _id: targetId });
      allowed = Boolean(inScope);
    }

    if (!allowed) {
      return sendError(res, 'Forbidden', 403);
    }

    const mapped = mapSlip(slip);
    const gross =
      Number(mapped.basic) + Number(mapped.allowances) + Number(mapped.bonus);
    const deductions = Number(mapped.tax) + Number(mapped.pf);
    const pdfContent = {
      title: `Payslip — ${slip.month}`,
      employee: slip.userId?.name || req.user.name,
      empId: slip.userId?.employeeId || req.user.employeeId || '',
      dept: slip.userId?.dept || req.user.dept || '',
      ...mapped,
      gross,
      deductions,
      generatedAt: new Date().toISOString(),
      isOwn: isOwner,
    };

    return sendSuccess(res, { payslip: pdfContent }, 'Payslip ready for download');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/salary/generate-batch — role-scoped (HR = branch)
router.post('/generate-batch', protect, authorize('generate_payslip'), async (req, res) => {
  try {
    const { month } = req.body;
    const slipMonth =
      month ||
      new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const userFilter = await resolveScopedEmployeeFilter(req.user);
    const employees = await User.find({
      ...userFilter,
      ...ACTIVE_EMPLOYEE_FILTER,
      systemRole: { $nin: ['company_owner', 'super_admin'] },
    });

    if (!employees.length) {
      return sendError(res, 'No employees in your payroll scope', 400);
    }

    const generated = [];

    for (const emp of employees) {
      const existing = await SalarySlip.findOne({ userId: emp._id, month: slipMonth });
      if (existing) continue;

      const calc = calculateSlip(emp.salary || 0, slipMonth);
      const slip = await SalarySlip.create({ userId: emp._id, ...calc });
      generated.push(mapSlip(slip));

      await Email.create({
        userId: emp._id,
        from: 'payroll@hrcore.com',
        subject: `${slipMonth.split(' ')[0]} Payslip Available`,
        preview: `Your ${slipMonth} payslip is ready for download.`,
        body: `Dear ${emp.name}, your payslip for ${slipMonth} has been generated. Net pay: ₹${calc.net}.`,
        time: formatTime(),
        unread: true,
      });
    }

    return sendSuccess(
      res,
      { generatedCount: generated.length, slips: generated, month: slipMonth },
      `Generated ${generated.length} payslips for ${slipMonth}`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/salary/seed-salaries — assign random salaries + backfill slips
router.post('/seed-salaries', protect, authorize('manage_salary'), async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const monthsBack = Math.min(12, Math.max(1, Number(req.body?.monthsBack) || 3));
    const result = await seedSalaries({ force, monthsBack });
    return sendSuccess(res, result, `Updated ${result.salaryUpdated} salaries, created ${result.slipsCreated} slips`);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/salary/slips — generate single slip for employee
router.post('/slips', protect, authorize('generate_payslip'), async (req, res) => {
  try {
    const { userId, month, basic, allowances, bonus, tax, pf, net } = req.body;

    if (!userId || !month) {
      return sendError(res, 'userId and month are required');
    }

    const employee = await User.findById(userId);
    if (!employee) {
      return sendError(res, 'Employee not found', 404);
    }

    const filter = await resolveScopedEmployeeFilter(req.user);
    const inScope = await User.exists({ ...filter, _id: employee._id });
    if (!inScope) {
      return sendError(res, 'Forbidden', 403);
    }

    const calc = net
      ? { month, basic, allowances, bonus, tax, pf, net }
      : calculateSlip(employee.salary || 0, month);

    const slip = await SalarySlip.findOneAndUpdate(
      { userId, month },
      { userId, ...calc },
      { upsert: true, new: true },
    );

    return sendSuccess(res, { salarySlip: mapSlip(slip) }, 'Payslip generated', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
