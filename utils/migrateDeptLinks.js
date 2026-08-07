/**
 * Link users.departmentId from legacy string `dept`, creating missing departments.
 *
 * - Matches Department.name (case-insensitive) within the user's branch
 * - Applies common aliases (e.g. Human Resources → HR)
 * - Creates a Department for any remaining dept labels
 * - Sets user.departmentId (and normalizes user.dept to the Department.name)
 *
 * Usage:  npm run migrate:dept-links
 */
require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');

const User = require('../models/User');
const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Department = require('../models/Department');

/** Normalized label → preferred Department.name */
const DEPT_ALIASES = {
  hr: 'HR',
  humanresources: 'HR',
  humanresource: 'HR',
  it: 'IT',
  informationtechnology: 'IT',
  engineering: 'Engineering',
  engg: 'Engineering',
  sales: 'Sales',
  finance: 'Finance',
  administration: 'Administration',
  admin: 'Administration',
  operations: 'Operations',
  ops: 'Operations',
  compliance: 'Compliance',
  riskmanagement: 'Risk Management',
  risk: 'Risk Management',
  customersupport: 'Customer Support',
  support: 'Customer Support',
  research: 'Research',
  trading: 'Trading',
  product: 'Product',
  general: 'Administration',
};

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '');
}

function resolveDeptLabel(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 'Administration';
  const alias = DEPT_ALIASES[normalizeKey(trimmed)];
  return alias || trimmed;
}

function codeFromName(name) {
  const cleaned = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (cleaned.length <= 3) return cleaned || 'GEN';
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .map((p) => p[0])
      .join('')
      .toUpperCase()
      .slice(0, 4);
  }
  return cleaned.slice(0, 3);
}

async function ensureDepartment(companyId, branchId, name) {
  const existing = await Department.findOne({
    branchId,
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  });
  if (existing) {
    if (existing.name !== name) {
      existing.name = name;
      await existing.save();
    }
    return existing;
  }

  let code = codeFromName(name);
  if (await Department.exists({ branchId, code })) {
    code = `${code}${Math.floor(Math.random() * 9) + 1}`.slice(0, 4);
  }

  return Department.create({
    companyId,
    branchId,
    name,
    code,
    status: 'Active',
  });
}

async function migrate() {
  await connectDB();
  console.log(colors.bold('\n=== Link users → departments ===\n'));

  const users = await User.find({
    isActive: { $ne: false },
    companyId: { $ne: null },
    branchId: { $ne: null },
  });

  console.log(colors.white(`Users with company+branch: ${users.length}`));

  let linked = 0;
  let createdDepts = 0;
  let skipped = 0;
  const createdNames = new Set();

  for (const user of users) {
    if (user.departmentId) {
      skipped += 1;
      continue;
    }

    const label = resolveDeptLabel(user.dept);
    const beforeCount = await Department.countDocuments({
      branchId: user.branchId,
      name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    });

    const department = await ensureDepartment(user.companyId, user.branchId, label);
    if (beforeCount === 0) {
      createdDepts += 1;
      createdNames.add(`${label}`);
    }

    user.departmentId = department._id;
    user.dept = department.name;
    await user.save();
    linked += 1;
  }

  // Summary per company
  const companies = await Company.find().sort({ name: 1 });
  for (const company of companies) {
    const depts = await Department.find({ companyId: company._id }).sort({ name: 1 });
    console.log(colors.cyan(`\n${company.name}`));
    for (const d of depts) {
      const n = await User.countDocuments({
        departmentId: d._id,
        isActive: { $ne: false },
      });
      console.log(colors.white(`  ${d.name.padEnd(22)} ${n} employees`));
    }
  }

  console.log(colors.green.bold(`\n✓ Done`));
  console.log(colors.white(`  Linked users       : ${linked}`));
  console.log(colors.white(`  Already linked     : ${skipped}`));
  console.log(colors.white(`  Departments created: ${createdDepts}`));
  if (createdNames.size) {
    console.log(colors.gray(`  New names: ${[...createdNames].join(', ')}`));
  }
  console.log('');

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
