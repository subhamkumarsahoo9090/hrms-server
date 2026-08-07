const express = require('express');
const SalarySlip = require('../models/SalarySlip');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const Email = require('../models/Email');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, formatTime, resolveAvatar } = require('../utils/helpers');
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

function formatInrFull(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

function salaryMonthKey(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
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

function calculateSlip(salary, month) {
  const basic = Math.round(salary * 0.5);
  const hra = Math.round(salary * 0.2);
  const special = Math.round(salary * 0.18);
  const allowances = hra + special;
  const bonus = Math.round(salary * 0.05);
  const tax = Math.round(salary * 0.08);
  const pf = Math.round(salary * 0.04);
  const net = basic + allowances + bonus - tax - pf;
  return { month, basic, allowances, bonus, tax, pf, net, hra, special };
}

// GET /api/salary/overview — payroll dashboard
router.get('/overview', protect, authorize('manage_salary'), async (req, res) => {
  try {
    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, {
        summary: {
          totalPayroll: 0,
          totalPayrollLabel: '₹0',
          lastMonthPayroll: 0,
          lastMonthPayrollLabel: '₹0',
          employeesPaid: 0,
          headcount: 0,
          avgCtc: 0,
          avgCtcLabel: '₹0',
          momChange: null,
        },
        trend: [],
        components: [],
        branches: [],
        recentPayruns: [],
        cycleLabel: '1st of every month',
      });
    }

    const companyObjIds = companyIds.map((id) => toObjectId(id)).filter(Boolean);
    const userFilter = {
      ...ACTIVE_EMPLOYEE_FILTER,
      companyId: { $in: companyObjIds },
    };

    const employees = await User.find(userFilter).select(
      'name salary branchId companyId employeeId dept isActive',
    );
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
        // Estimate from current salaries when slips missing
        total = salarySum;
      }
      return {
        label: MONTH_SHORT[monthIndex],
        monthKey: key,
        value: round1(total / 10000000), // crore for chart
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

    // Component split from slips or formula defaults matching UI
    let components;
    if (currentSlips.length) {
      const basic = currentSlips.reduce((s, x) => s + (Number(x.basic) || 0), 0);
      const allowances = currentSlips.reduce((s, x) => s + (Number(x.allowances) || 0), 0);
      const statutory = currentSlips.reduce(
        (s, x) => s + (Number(x.tax) || 0) + (Number(x.pf) || 0),
        0,
      );
      // Split allowances ~ HRA 20 / Special 18 of gross salary structure
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
          value: Math.max(0, 100 - (basicPct || 50) - (hraPct || 20) - (specialPct || 18)) || statPct || 12,
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

    const branches = await Branch.find({ companyId: { $in: companyObjIds } }).sort({ name: 1 });
    const companies = await Company.find({ _id: { $in: companyObjIds } });
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
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/salary/slips — own slips
router.get('/slips', protect, authorize('view_own_payslip'), async (req, res) => {
  try {
    const slips = await SalarySlip.find({ userId: req.user._id }).sort({ createdAt: -1 });
    return sendSuccess(res, { salarySlips: slips.map(mapSlip) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/salary/slips/all — HR overview
router.get('/slips/all', protect, authorize('manage_salary'), async (req, res) => {
  try {
    const companyIds = await resolveCompanyIds(req.user);
    const userFilter = {
      ...ACTIVE_EMPLOYEE_FILTER,
      ...(companyIds.length
        ? { companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } }
        : {}),
    };
    const users = await User.find(userFilter).select('_id');
    const userIds = users.map((u) => u._id);

    const slips = await SalarySlip.find({ userId: { $in: userIds } })
      .populate('userId', 'name employeeId dept salary avatar branchId companyId')
      .sort({ createdAt: -1 });

    const formatted = slips.map((s) => ({
      ...mapSlip(s),
      employeeName: s.userId?.name,
      empId: s.userId?.employeeId,
      dept: s.userId?.dept,
      avatar: resolveAvatar(s.userId?.avatar, s.userId?.name),
    }));
    return sendSuccess(res, { salarySlips: formatted });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/salary/slips/:id/download
router.get('/slips/:id/download', protect, authorize('view_own_payslip'), async (req, res) => {
  try {
    const slip = await SalarySlip.findById(req.params.id);

    if (!slip) {
      return sendError(res, 'Salary slip not found', 404);
    }

    const isOwner = slip.userId.toString() === req.user._id.toString();
    const isPayrollAdmin = ['company_owner', 'super_admin', 'hr'].includes(req.user.systemRole);

    if (!isOwner && !isPayrollAdmin) {
      return sendError(res, 'Forbidden', 403);
    }

    const pdfContent = {
      title: `Payslip — ${slip.month}`,
      employee: req.user.name,
      ...mapSlip(slip),
      generatedAt: new Date().toISOString(),
    };

    return sendSuccess(res, { payslip: pdfContent }, 'Payslip ready for download');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/salary/generate-batch
router.post('/generate-batch', protect, authorize('generate_payslip'), async (req, res) => {
  try {
    const { month } = req.body;
    const slipMonth =
      month ||
      new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.length) {
      return sendError(res, 'No company in scope', 400);
    }

    const employees = await User.find({
      ...ACTIVE_EMPLOYEE_FILTER,
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
      systemRole: { $nin: ['company_owner', 'super_admin'] },
    });

    const generated = [];

    for (const emp of employees) {
      const existing = await SalarySlip.findOne({ userId: emp._id, month: slipMonth });
      if (existing) continue;

      const calc = calculateSlip(emp.salary || 0, slipMonth);
      const { hra, special, ...slipFields } = calc;
      void hra;
      void special;
      const slip = await SalarySlip.create({ userId: emp._id, ...slipFields });
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

    const companyIds = await resolveCompanyIds(req.user);
    if (
      companyIds.length &&
      employee.companyId &&
      !companyIds.includes(String(employee.companyId))
    ) {
      return sendError(res, 'Forbidden', 403);
    }

    const calc = net
      ? { month, basic, allowances, bonus, tax, pf, net }
      : (() => {
          const c = calculateSlip(employee.salary || 0, month);
          const { hra, special, ...rest } = c;
          void hra;
          void special;
          return rest;
        })();

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
