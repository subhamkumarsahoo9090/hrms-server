/**
 * Seed dummy tasks for every active user (role-aware assigner).
 *
 *   npm run seed:tasks
 *   npm run seed:tasks -- --force   # delete existing then reseed
 */
require('dotenv').config();
const colors = require('colors');
const connectDB = require('../config/db');
const User = require('../models/User');
const Task = require('../models/Task');

const TITLES = [
  'Complete weekly status update',
  'Review pending documents',
  'Prepare client follow-up notes',
  'Update project tracker',
  'Schedule 1:1 check-in',
  'Close open action items',
  'Draft handoff summary',
  'Verify attendance exceptions',
  'Submit expense receipts',
  'Polish demo for stakeholders',
];

const PRIOS = ['High', 'Medium', 'Low'];
const STATUSES = ['Pending', 'In Progress', 'Completed'];

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function assignerFor(user, byRole, byBranch, byCompany) {
  const companyKey = user.companyId ? String(user.companyId) : '';
  const branchKey = user.branchId ? String(user.branchId) : '';

  if (user.managerId) {
    const m = byCompany.get(String(user.managerId)) || null;
    if (m) return m;
  }

  const role = user.systemRole;
  const branchUsers = branchKey ? byBranch.get(branchKey) || [] : [];
  const companyUsers = companyKey
    ? [...byCompany.values()].filter((u) => String(u.companyId) === companyKey)
    : [...byCompany.values()];

  const findRole = (roles, pool) =>
    pool.find((u) => roles.includes(u.systemRole) && String(u._id) !== String(user._id));

  if (['developer', 'sales', 'designer', 'accountant', 'marketing', 'custom'].includes(role)) {
    return (
      findRole(['manager'], branchUsers) ||
      findRole(['hr', 'branch_head'], branchUsers) ||
      findRole(['manager', 'hr', 'branch_head', 'super_admin'], companyUsers) ||
      user
    );
  }
  if (role === 'manager') {
    return (
      findRole(['branch_head', 'hr'], branchUsers) ||
      findRole(['super_admin', 'company_owner'], companyUsers) ||
      user
    );
  }
  if (role === 'hr') {
    return (
      findRole(['branch_head'], branchUsers) ||
      findRole(['super_admin', 'company_owner'], companyUsers) ||
      user
    );
  }
  if (role === 'branch_head') {
    return findRole(['super_admin', 'company_owner'], companyUsers) || user;
  }
  if (role === 'super_admin') {
    return findRole(['company_owner'], companyUsers) || user;
  }
  return user;
}

async function seedTasks({ force = false, perUser = 2 } = {}) {
  const users = await User.find({ isActive: true });
  if (!users.length) {
    return { usersScanned: 0, deleted: 0, created: 0 };
  }

  let deleted = 0;
  if (force) {
    const res = await Task.deleteMany({});
    deleted = res.deletedCount || 0;
  }

  const byId = new Map(users.map((u) => [String(u._id), u]));
  const byBranch = new Map();
  users.forEach((u) => {
    if (!u.branchId) return;
    const k = String(u.branchId);
    const list = byBranch.get(k) || [];
    list.push(u);
    byBranch.set(k, list);
  });

  const existingCounts = new Map();
  if (!force) {
    const counts = await Task.aggregate([
      { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
    ]);
    counts.forEach((c) => existingCounts.set(String(c._id), c.n));
  }

  const docs = [];
  for (const user of users) {
    const have = force ? 0 : existingCounts.get(String(user._id)) || 0;
    const need = Math.max(0, perUser - have);
    if (!need) continue;

    const assigner = assignerFor(user, null, byBranch, byId);
    for (let i = 0; i < need; i += 1) {
      const status = pick(STATUSES);
      const dueOffset = status === 'Completed' ? -pick([2, 5, 8]) : pick([1, 3, 5, 7, 10]);
      docs.push({
        title: pick(TITLES),
        description: `Dummy task for ${user.name} (${user.systemRole}).`,
        companyId: user.companyId || null,
        branchId: user.branchId || null,
        teamId: user.teamId || null,
        assigneeId: user._id,
        assignerId: assigner?._id || user._id,
        priority: pick(PRIOS),
        status,
        dueDate: daysFromNow(dueOffset),
      });
    }
  }

  if (docs.length) {
    await Task.insertMany(docs);
  }

  return {
    usersScanned: users.length,
    deleted,
    created: docs.length,
    perUser,
  };
}

async function main() {
  const force = process.argv.includes('--force');
  await connectDB();
  console.log(colors.cyan(`Seeding tasks${force ? ' (force)' : ''}…`));
  const result = await seedTasks({ force, perUser: 2 });
  console.log(colors.green(JSON.stringify(result, null, 2)));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(colors.red(err.message));
    process.exit(1);
  });
}

module.exports = { seedTasks };
