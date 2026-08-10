/**
 * Assign random monthly salaries to all active users and generate missing payslips.
 *
 *   npm run seed:salaries          # overwrite all salaries + backfill 3 months
 *   npm run seed:salaries -- --keep  # only fill zero/missing salaries
 */
require('dotenv').config();
const colors = require('colors');
const connectDB = require('../config/db');
const User = require('../models/User');
const SalarySlip = require('../models/SalarySlip');

const ROLE_RANGES = {
  company_owner: [180000, 350000],
  super_admin: [120000, 220000],
  branch_head: [90000, 150000],
  hr: [55000, 100000],
  manager: [48000, 90000],
  developer: [35000, 75000],
  sales: [30000, 65000],
  designer: [32000, 70000],
  accountant: [30000, 60000],
  marketing: [30000, 62000],
  custom: [28000, 55000],
};

function randomInRange([min, max]) {
  const raw = min + Math.random() * (max - min);
  return Math.round(raw / 1000) * 1000;
}

function salaryForRole(role) {
  return randomInRange(ROLE_RANGES[role] || [28000, 58000]);
}

function salaryMonthKey(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function calculateSlip(salary, month) {
  const basic = Math.round(salary * 0.5);
  const allowances = Math.round(salary * 0.38);
  const bonus = Math.round(salary * 0.05);
  const tax = Math.round(salary * 0.08);
  const pf = Math.round(salary * 0.04);
  const net = basic + allowances + bonus - tax - pf;
  return { month, basic, allowances, bonus, tax, pf, net };
}

async function seedSalaries({ force = false, monthsBack = 3 } = {}) {
  const users = await User.find({ isActive: true });
  let salaryUpdated = 0;
  let slipsCreated = 0;

  const now = new Date();
  const monthKeys = [];
  for (let i = monthsBack - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(salaryMonthKey(d.getFullYear(), d.getMonth()));
  }

  for (const user of users) {
    const current = Number(user.salary) || 0;
    if (force || current <= 0) {
      user.salary = salaryForRole(user.systemRole);
      await user.save();
      salaryUpdated += 1;
    }

    const salary = Number(user.salary) || 0;
    if (salary <= 0) continue;
    if (['company_owner', 'super_admin'].includes(user.systemRole)) continue;

    for (const month of monthKeys) {
      const existing = await SalarySlip.findOne({ userId: user._id, month });
      if (existing) continue;
      await SalarySlip.create({ userId: user._id, ...calculateSlip(salary, month) });
      slipsCreated += 1;
    }
  }

  return {
    usersScanned: users.length,
    salaryUpdated,
    slipsCreated,
    months: monthKeys,
  };
}

async function main() {
  // Default: overwrite all salaries. Pass --keep to only fill zero/missing.
  const force = !process.argv.includes('--keep');
  await connectDB();
  console.log(
    colors.cyan(
      `Seeding salaries${force ? ' (overwrite all)' : ' (only missing/zero)'}…`,
    ),
  );
  const result = await seedSalaries({ force, monthsBack: 3 });
  console.log(colors.green(JSON.stringify(result, null, 2)));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(colors.red(err.message));
    process.exit(1);
  });
}

module.exports = { seedSalaries, salaryForRole, calculateSlip, salaryMonthKey };
