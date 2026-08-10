/**
 * Keep only Developers + Sales teams.
 * - Developers → manager Manoj Sir (Manoj Rawat)
 * - Sales → manager Manas Sir (create if missing)
 * - Demote every other systemRole=manager off the manager post
 *
 *   node utils/fixTeamsTwo.js
 */
require('dotenv').config();
const colors = require('colors');
const connectDB = require('../config/db');
const User = require('../models/User');
const Team = require('../models/Team');
const Department = require('../models/Department');
const CompanyMembership = require('../models/CompanyMembership');

function deptToStaffRole(dept = '') {
  const d = String(dept).toLowerCase();
  if (d.includes('sale')) return { systemRole: 'sales', role: 'Sales', dept: 'Sales' };
  if (d.includes('eng') || d.includes('product') || d.includes('develop') || d.includes('it')) {
    return { systemRole: 'developer', role: 'Developer', dept: 'Engineering' };
  }
  if (d.includes('financ') || d.includes('account')) {
    return { systemRole: 'accountant', role: 'Accountant', dept: 'Finance' };
  }
  return { systemRole: 'custom', role: 'Staff', dept: dept || 'Operations' };
}

async function nextEmployeeId(companyId) {
  const users = await User.find({
    employeeId: { $regex: /^EMP\d+$/i },
  })
    .select('employeeId')
    .lean();
  let max = 0;
  users.forEach((u) => {
    const n = parseInt(String(u.employeeId).replace(/\D/g, ''), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  });
  // also try company-scoped count as floor
  const count = await User.countDocuments({ companyId });
  const next = Math.max(max, count) + 1;
  return `EMP${String(next).padStart(3, '0')}`;
}

async function main() {
  await connectDB();

  const manoj = await User.findOne({ name: /manoj/i });
  if (!manoj) {
    throw new Error('Manoj Sir not found in DB');
  }

  const companyId = manoj.companyId;
  const branchId = manoj.branchId;
  if (!companyId || !branchId) {
    throw new Error('Manoj has no company/branch — cannot place teams');
  }

  let engDept = await Department.findOne({
    companyId,
    branchId,
    name: /engineering|developer/i,
  });
  if (!engDept) {
    engDept = await Department.findOne({ companyId, name: /engineering/i });
  }
  let salesDept = await Department.findOne({
    companyId,
    branchId,
    name: /^sales$/i,
  });
  if (!salesDept) {
    salesDept = await Department.findOne({ companyId, name: /sales/i });
  }
  if (!engDept || !salesDept) {
    throw new Error('Engineering or Sales department missing');
  }

  // Manas Sir — create as Sales manager if missing
  let manas = await User.findOne({
    $or: [{ name: /^manas(\s|$)/i }, { name: /manas sir/i }, { email: /manas@/i }],
  });
  if (!manas) {
    const employeeId = await nextEmployeeId(companyId);
    manas = await User.create({
      employeeId,
      name: 'Manas Sir',
      email: 'manas@hrcore.com',
      password: 'Password@123',
      role: 'Sales Manager',
      systemRole: 'manager',
      dept: 'Sales',
      companyId,
      branchId,
      departmentId: salesDept._id,
      status: 'Active',
      isActive: true,
      avatar: '👤',
    });
    console.log(colors.cyan(`Created Manas Sir (${manas.email}) / Password@123`));
  } else {
    manas.systemRole = 'manager';
    manas.role = 'Sales Manager';
    manas.dept = 'Sales';
    manas.companyId = companyId;
    manas.branchId = branchId;
    manas.departmentId = salesDept._id;
    manas.isActive = true;
    manas.status = 'Active';
    await manas.save();
    console.log(colors.cyan(`Updated existing Manas → manager: ${manas.name}`));
  }

  // Ensure Manoj stays usable as team manager (keep super_admin)
  manoj.departmentId = engDept._id;
  await manoj.save();

  // Upsert the two teams
  let devTeam = await Team.findOne({
    companyId,
    branchId,
    name: { $in: ['Developers', 'Developer', 'Engineering'] },
  });
  if (!devTeam) {
    // Prefer renaming Alpha / Engineering team if present
    devTeam = await Team.findOne({ departmentId: engDept._id, name: /alpha|developer|product/i });
  }
  if (devTeam) {
    devTeam.name = 'Developers';
    devTeam.departmentId = engDept._id;
    devTeam.companyId = companyId;
    devTeam.branchId = branchId;
    devTeam.managerId = manoj._id;
    devTeam.status = 'Active';
    await devTeam.save();
  } else {
    devTeam = await Team.create({
      name: 'Developers',
      companyId,
      branchId,
      departmentId: engDept._id,
      managerId: manoj._id,
      status: 'Active',
    });
  }

  let salesTeam = await Team.findOne({
    companyId,
    branchId,
    name: { $in: ['Sales', 'Sales Alpha', 'Sales Beta'] },
  });
  if (!salesTeam) {
    salesTeam = await Team.findOne({ departmentId: salesDept._id });
  }
  if (salesTeam) {
    salesTeam.name = 'Sales';
    salesTeam.departmentId = salesDept._id;
    salesTeam.companyId = companyId;
    salesTeam.branchId = branchId;
    salesTeam.managerId = manas._id;
    salesTeam.status = 'Active';
    await salesTeam.save();
  } else {
    salesTeam = await Team.create({
      name: 'Sales',
      companyId,
      branchId,
      departmentId: salesDept._id,
      managerId: manas._id,
      status: 'Active',
    });
  }

  // Link Manas to sales team
  manas.teamId = salesTeam._id;
  manas.teamIds = [salesTeam._id];
  manas.managerId = null;
  await manas.save();

  // Delete every other team
  const keepIds = [devTeam._id, salesTeam._id];
  const del = await Team.deleteMany({ _id: { $nin: keepIds } });
  console.log(colors.yellow(`Deleted ${del.deletedCount} other teams`));

  // Demote all managers except Manas
  const otherManagers = await User.find({
    systemRole: 'manager',
    _id: { $ne: manas._id },
  });
  let demoted = 0;
  for (const u of otherManagers) {
    const mapped = deptToStaffRole(u.dept || u.role);
    u.systemRole = mapped.systemRole;
    u.role = mapped.role === 'Staff' && u.role && u.role !== 'Manager' ? u.role : mapped.role;
    if (mapped.systemRole === 'developer') u.dept = 'Engineering';
    if (mapped.systemRole === 'sales') u.dept = 'Sales';
    if (mapped.systemRole === 'accountant') u.dept = 'Finance';
    await u.save();
    demoted += 1;
    console.log(colors.gray(`  Demoted ${u.name} → ${u.systemRole}`));
  }

  // Assign all developers under Manoj / Developers team
  const developers = await User.find({
    systemRole: 'developer',
    isActive: true,
  });
  for (const u of developers) {
    u.teamId = devTeam._id;
    u.teamIds = [devTeam._id];
    u.managerId = manoj._id;
    u.departmentId = engDept._id;
    u.dept = u.dept || 'Engineering';
    u.companyId = u.companyId || companyId;
    u.branchId = u.branchId || branchId;
    await u.save();
  }
  console.log(colors.green(`Developers on Manoj's team: ${developers.length}`));

  // Assign all sales under Manas / Sales team
  const salesPeople = await User.find({
    systemRole: 'sales',
    isActive: true,
    _id: { $ne: manas._id },
  });
  for (const u of salesPeople) {
    u.teamId = salesTeam._id;
    u.teamIds = [salesTeam._id];
    u.managerId = manas._id;
    u.departmentId = salesDept._id;
    u.dept = 'Sales';
    u.companyId = u.companyId || companyId;
    u.branchId = u.branchId || branchId;
    await u.save();
  }
  console.log(colors.green(`Sales on Manas's team: ${salesPeople.length}`));

  // Clear team links for everyone else (not manoj/manas/dev/sales)
  const others = await User.find({
    isActive: true,
    _id: { $nin: [manoj._id, manas._id] },
    systemRole: { $nin: ['developer', 'sales'] },
  });
  for (const u of others) {
    const tid = u.teamId ? String(u.teamId) : '';
    const keep =
      tid === String(devTeam._id) || tid === String(salesTeam._id);
    if (!keep) {
      u.teamId = null;
      u.teamIds = [];
    }
    // Drop managerId if it pointed at a demoted manager (keep if Manoj/Manas)
    if (
      u.managerId &&
      String(u.managerId) !== String(manoj._id) &&
      String(u.managerId) !== String(manas._id)
    ) {
      u.managerId = null;
    }
    await u.save();
  }

  // Sync membership role for demoted users if present
  for (const u of otherManagers) {
    await CompanyMembership.updateMany(
      { userId: u._id },
      { $set: { systemRole: u.systemRole } },
    );
  }
  await CompanyMembership.updateMany(
    { userId: manas._id },
    { $set: { systemRole: 'manager', companyId, branchId } },
    { upsert: false },
  );
  const manasMembership = await CompanyMembership.findOne({ userId: manas._id, companyId });
  if (!manasMembership) {
    await CompanyMembership.create({
      userId: manas._id,
      companyId,
      branchId,
      systemRole: 'manager',
    });
  }

  const remainingTeams = await Team.find().populate('managerId', 'name systemRole');
  const remainingManagers = await User.find({ systemRole: 'manager' }).select('name email');

  console.log(colors.green('\n=== DONE ==='));
  console.log(
    remainingTeams.map((t) => ({
      team: t.name,
      manager: t.managerId?.name,
      role: t.managerId?.systemRole,
    })),
  );
  console.log(
    'Managers left:',
    remainingManagers.map((m) => m.name),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(colors.red(err.message));
  process.exit(1);
});
