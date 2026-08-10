/**
 * Seed EZ Wealth teams and distribute existing members across them.
 *
 * - Creates 1–2 teams per department that has staff
 * - Splits users in that department evenly across those teams
 * - Picks a manager per team (prefer systemRole=manager, else first member)
 * - Leaves company_owner unassigned to a team (company-wide) unless alone in dept
 *
 * Usage:  npm run migrate:seed-teams
 */
require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');

const Company = require('../models/Company');
const Department = require('../models/Department');
const Team = require('../models/Team');
const User = require('../models/User');

/** Suggested team names by department (used in order). */
const TEAM_NAMES = {
  Engineering: ['Alpha', 'Beta'],
  Operations: ['Ops Core', 'Ops Field'],
  Trading: ['Trading Desk A', 'Trading Desk B'],
  Sales: ['Sales Alpha', 'Sales Beta'],
  'Risk Management': ['Risk Unit'],
  HR: ['People Ops'],
  Finance: ['Finance Desk'],
  Compliance: ['Compliance Unit'],
  'Customer Support': ['Support Desk'],
  Research: ['Research Lab'],
  Product: ['Product Squad'],
  Administration: ['Leadership Office'],
  IT: ['Platform'],
};

function chunkRoundRobin(items, buckets) {
  const groups = Array.from({ length: buckets }, () => []);
  items.forEach((item, i) => {
    groups[i % buckets].push(item);
  });
  return groups.filter((g) => g.length > 0);
}

function teamCountFor(deptName, memberCount) {
  if (memberCount <= 0) return 0;
  const names = TEAM_NAMES[deptName] || [`${deptName} Team`];
  if (memberCount === 1) return 1;
  if (memberCount === 2) return Math.min(2, names.length);
  if (memberCount >= 6) return Math.min(2, names.length);
  return Math.min(names.length, memberCount >= 3 ? Math.min(2, names.length) : 1);
}

async function ensureTeam({ companyId, branchId, departmentId, name }) {
  let team = await Team.findOne({ departmentId, name });
  if (team) return { team, created: false };
  team = await Team.create({
    companyId,
    branchId,
    departmentId,
    name,
    status: 'Active',
  });
  return { team, created: true };
}

function pickManager(members) {
  const managers = members.filter((u) => u.systemRole === 'manager');
  if (managers.length) return managers[0];
  const leads = members.filter(
    (u) => !['company_owner', 'employee'].includes(u.systemRole),
  );
  if (leads.length) return leads[0];
  return members[0] || null;
}

async function migrate() {
  await connectDB();
  console.log(colors.bold('\n=== Seed EZ Wealth teams + assign members ===\n'));

  const ez = await Company.findOne({
    $or: [{ slug: 'ezwealth' }, { name: /ez\s*wealth/i }],
  });
  if (!ez) {
    console.log(colors.red('EZ Wealth company not found'));
    process.exit(1);
  }

  const departments = await Department.find({ companyId: ez._id }).sort({ name: 1 });
  const users = await User.find({
    companyId: ez._id,
    isActive: { $ne: false },
  });

  console.log(colors.white(`Company: ${ez.name}`));
  console.log(colors.white(`Departments: ${departments.length}`));
  console.log(colors.white(`Users: ${users.length}`));

  // Clear existing team assignments for this company so re-run is clean
  const existingTeams = await Team.find({ companyId: ez._id });
  if (existingTeams.length) {
    console.log(colors.yellow(`Removing ${existingTeams.length} existing team(s)…`));
    await User.updateMany({ companyId: ez._id }, { $set: { teamId: null } });
    await Team.deleteMany({ companyId: ez._id });
  }

  let teamsCreated = 0;
  let assigned = 0;

  for (const dept of departments) {
    let members = users.filter(
      (u) => u.departmentId && String(u.departmentId) === String(dept._id),
    );

    // Keep company_owner out of team rosters when other staff exist
    const owners = members.filter((u) => u.systemRole === 'company_owner');
    const staff = members.filter((u) => u.systemRole !== 'company_owner');
    if (staff.length > 0) {
      members = staff;
    }

    const nTeams = teamCountFor(dept.name, members.length);
    if (nTeams === 0) {
      console.log(colors.gray(`  skip ${dept.name} (no members)`));
      continue;
    }

    const nameList = TEAM_NAMES[dept.name] || [`${dept.name} Team`];
    const groups = chunkRoundRobin(members, nTeams);

    console.log(colors.cyan(`\n${dept.name} (${members.length} members → ${groups.length} team(s))`));

    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      const teamName = nameList[i] || `${dept.name} ${i + 1}`;
      const { team, created } = await ensureTeam({
        companyId: ez._id,
        branchId: dept.branchId,
        departmentId: dept._id,
        name: teamName,
      });
      if (created) teamsCreated += 1;

      const manager = pickManager(group);
      if (manager) {
        team.managerId = manager._id;
        await team.save();
      }

      for (const user of group) {
        user.teamId = team._id;
        user.teamIds = [team._id];
        if (manager && String(user._id) !== String(manager._id)) {
          user.managerId = manager._id;
        }
        await user.save();
        assigned += 1;
      }

      console.log(
        colors.white(
          `  ✓ ${teamName.padEnd(18)} ${group.length} members` +
            (manager ? ` · mgr ${manager.name}` : ''),
        ),
      );
    }

    // Owners stay unassigned (company-wide) — log only
    if (owners.length && staff.length > 0) {
      console.log(
        colors.gray(
          `  (owner ${owners.map((o) => o.name).join(', ')} left unassigned — company-wide)`,
        ),
      );
    }
  }

  const finalTeams = await Team.find({ companyId: ez._id }).sort({ name: 1 });
  console.log(colors.green.bold(`\n✓ Done`));
  console.log(colors.white(`  Teams created : ${teamsCreated}`));
  console.log(colors.white(`  Members assigned: ${assigned}`));
  console.log(colors.white(`  Teams total   : ${finalTeams.length}`));

  for (const t of finalTeams) {
    const count = await User.countDocuments({
      teamId: t._id,
      isActive: { $ne: false },
    });
    console.log(colors.gray(`    ${t.name}: ${count}`));
  }
  console.log('');

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
