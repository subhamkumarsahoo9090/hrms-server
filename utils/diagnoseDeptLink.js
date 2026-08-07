/**
 * Diagnose EZ Wealth department ↔ user linking.
 * Usage: node utils/diagnoseDeptLink.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const User = require('../models/User');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '');
}

(async () => {
  await connectDB();
  const ez = await Company.findOne({
    $or: [{ slug: 'ezwealth' }, { name: /ez\s*wealth/i }],
  });
  console.log('Company:', ez ? { id: String(ez._id), name: ez.name, slug: ez.slug } : null);
  if (!ez) {
    process.exit(1);
  }

  const branches = await Branch.find({ companyId: ez._id });
  console.log(
    'Branches:',
    branches.map((b) => ({ id: String(b._id), name: b.name, code: b.code })),
  );

  const depts = await Department.find({ companyId: ez._id });
  console.log(
    'Departments:',
    depts.map((d) => ({
      id: String(d._id),
      name: d.name,
      code: d.code,
      branchId: String(d.branchId),
    })),
  );

  const users = await User.find({
    companyId: ez._id,
    isActive: { $ne: false },
  }).select('name dept departmentId branchId teamId');

  const withDeptId = users.filter((u) => u.departmentId).length;
  const withoutDeptId = users.filter((u) => !u.departmentId).length;
  const deptStrings = {};
  users.forEach((u) => {
    const k = u.dept || '(empty)';
    deptStrings[k] = (deptStrings[k] || 0) + 1;
  });

  console.log(
    `Users total: ${users.length} | with departmentId: ${withDeptId} | without: ${withoutDeptId}`,
  );
  console.log('dept string counts:', deptStrings);

  const sample = users.slice(0, 12).map((u) => ({
    name: u.name,
    dept: u.dept,
    departmentId: u.departmentId ? String(u.departmentId) : null,
    branchId: u.branchId ? String(u.branchId) : null,
  }));
  console.log('Sample users:', JSON.stringify(sample, null, 2));

  const teams = await Team.find({ companyId: ez._id });
  console.log(
    'Teams:',
    teams.length,
    teams.map((t) => ({
      name: t.name,
      departmentId: t.departmentId ? String(t.departmentId) : null,
    })),
  );

  const deptByNorm = new Map();
  for (const d of depts) {
    deptByNorm.set(norm(d.name), d);
    if (d.code) deptByNorm.set(norm(d.code), d);
  }

  const unmatched = [];
  for (const [label, count] of Object.entries(deptStrings)) {
    if (label === '(empty)') continue;
    if (!deptByNorm.has(norm(label))) {
      unmatched.push({ label, count, norm: norm(label) });
    }
  }
  console.log('Unmatched dept strings:', unmatched);

  // Per-department counts as API does today
  for (const d of depts) {
    const byId = await User.countDocuments({
      departmentId: d._id,
      isActive: { $ne: false },
    });
    const byName = users.filter((u) => norm(u.dept) === norm(d.name)).length;
    console.log(`Dept ${d.name}: countById=${byId} countByDeptString=${byName}`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
