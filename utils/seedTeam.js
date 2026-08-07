require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');
const User = require('../models/User');
const CustomRole = require('../models/CustomRole');
const TEAM = require('./teamData');
const TEAM_AVATAR_URLS = require('./teamAvatarUrls');

const DEFAULT_PASSWORD = '123456';

/** Accounts already created — do not recreate or change password */
const SKIP_EMAILS = new Set([
  'rahul.agarwal@hrcore.com',
  'sarita.thakur@hrcore.com',
  'subham.sahoo@hrcore.com',
  'mukesh.chaudhari@hrcore.com',
  'manoj.rawat@hrcore.com',
]);

const ROLE_MAP = {
  'Founder & CEO': { systemRole: 'super_admin', dept: 'Administration', salary: 0 },
  'Chief Compliance Officer (CCO)': { systemRole: 'manager', dept: 'Compliance', salary: 8500 },
  'Chief Operating Officer (COO)': { systemRole: 'manager', dept: 'Operations', salary: 9000 },
  'Chief Technology Officer (CTO)': { systemRole: 'manager', dept: 'Engineering', salary: 9000 },
  'Regional Head': { systemRole: 'manager', dept: 'Sales', salary: 7500 },
  'Head of Information Technology (IT)': { systemRole: 'manager', dept: 'Engineering', salary: 8000 },
  'Head of Depository Operations': { systemRole: 'manager', dept: 'Operations', salary: 7500 },
  'Head of Back Office Operations': { systemRole: 'manager', dept: 'Operations', salary: 7500 },
  'Head of Risk Management': { systemRole: 'manager', dept: 'Risk Management', salary: 8000 },
  'Chief Human Resources Officer (CHRO)': { systemRole: 'hr', dept: 'Human Resources', salary: 8500 },
  Accounts: { systemRole: 'accountant', dept: 'Finance', salary: 5500 },
  BackOffice: { systemRole: 'custom', dept: 'Operations', salary: 4500 },
  IT: { systemRole: 'developer', dept: 'Engineering', salary: 6000 },
  'Sales & Marketing': { systemRole: 'sales', dept: 'Sales', salary: 5000 },
  'Customer Support': { systemRole: 'sales', dept: 'Customer Support', salary: 4800 },
  Depository: { systemRole: 'custom', dept: 'Operations', salary: 4500 },
  RMS: { systemRole: 'custom', dept: 'Risk Management', salary: 5000 },
  'Research Analyst': { systemRole: 'custom', dept: 'Research', salary: 5500 },
  'Human Resource': { systemRole: 'hr', dept: 'Human Resources', salary: 5200 },
  'Trading Head': { systemRole: 'manager', dept: 'Trading', salary: 7500 },
  Developer: { systemRole: 'developer', dept: 'Engineering', salary: 6500 },
  'Product Manager': { systemRole: 'manager', dept: 'Product', salary: 7000 },
  'AI/ML Engineer': { systemRole: 'developer', dept: 'Engineering', salary: 7000 },
  'Full Stack Developer': { systemRole: 'developer', dept: 'Engineering', salary: 6500 },
  'Full Stack Mobile App Developer': { systemRole: 'developer', dept: 'Engineering', salary: 6500 },
  Trading: { systemRole: 'custom', dept: 'Trading', salary: 5000 },
};

const CUSTOM_JOB_TITLES = new Set([
  'BackOffice',
  'Depository',
  'RMS',
  'Research Analyst',
  'Trading',
]);

function emailFromName(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return `${parts[0].toLowerCase()}@hrcore.com`;
  }
  const first = parts[0].toLowerCase();
  const last = parts[parts.length - 1].toLowerCase();
  return `${first}.${last}@hrcore.com`;
}

function resolveMapping(jobTitle) {
  return (
    ROLE_MAP[jobTitle] || {
      systemRole: 'custom',
      dept: 'General',
      salary: 4500,
    }
  );
}

async function nextEmployeeId() {
  const users = await User.find().select('employeeId');
  let max = 0;
  users.forEach((u) => {
    const match = /^EMP(\d+)$/.exec(u.employeeId || '');
    if (match) max = Math.max(max, parseInt(match[1], 10));
  });
  return `EMP${String(max + 1).padStart(3, '0')}`;
}

async function ensureCustomRoles() {
  const uniqueTitles = [...new Set(TEAM.map((m) => m.jobTitle))];
  const roleIdByName = {};

  for (const title of uniqueTitles) {
    let role = await CustomRole.findOne({ name: title });
    if (!role && CUSTOM_JOB_TITLES.has(title)) {
      role = await CustomRole.create({
        name: title,
        description: `${title} team role`,
        createdBy: 'System Seed',
      });
      console.log(colors.cyan(`  + Custom role: ${title}`));
    } else if (!role && resolveMapping(title).systemRole === 'custom' && !ROLE_MAP[title]) {
      role = await CustomRole.create({
        name: title,
        description: `${title} team role`,
        createdBy: 'System Seed',
      });
      console.log(colors.cyan(`  + Custom role: ${title}`));
    }
    if (role) {
      roleIdByName[title] = role._id;
    }
  }

  return roleIdByName;
}

async function seedTeam() {
  await connectDB();

  console.log(colors.yellow.bold('\nSeeding Wealth Discovery team (non-destructive)...\n'));

  const roleIdByName = await ensureCustomRoles();
  let created = 0;
  let skipped = 0;

  for (const member of TEAM.sort((a, b) => a.order - b.order)) {
    const email = emailFromName(member.name);
    const mapping = resolveMapping(member.jobTitle);

    if (SKIP_EMAILS.has(email)) {
      const existing = await User.findOne({ email });
      console.log(colors.gray(`  ↷ Skipped (already exists): ${member.name} → ${email}`));
      skipped += 1;
      if (existing && member.jobTitle === 'Founder & CEO' && existing.systemRole !== 'super_admin') {
        existing.systemRole = 'super_admin';
        existing.role = member.jobTitle;
        existing.dept = mapping.dept;
        await existing.save();
        console.log(colors.yellow(`    Updated ${member.name} to super_admin`));
      }
      continue;
    }

    const exists = await User.findOne({ email });
    if (exists) {
      console.log(colors.gray(`  ↷ Skipped (email taken): ${member.name} → ${email}`));
      skipped += 1;
      continue;
    }

    const employeeId = await nextEmployeeId();
    const customRoleId =
      mapping.systemRole === 'custom' ? roleIdByName[member.jobTitle] || null : null;

    await User.create({
      employeeId,
      name: member.name,
      email,
      password: DEFAULT_PASSWORD,
      role: member.jobTitle,
      systemRole: mapping.systemRole,
      dept: mapping.dept,
      status: 'Active',
      avatar: TEAM_AVATAR_URLS[member.name] || '👤',
      delayCount: 0,
      salary: mapping.salary,
      customRoleId,
      isActive: true,
    });

    console.log(
      colors.green(`  ✓ Created: ${member.name} (${member.jobTitle}) → ${email} / ${employeeId}`),
    );
    created += 1;
  }

  const total = await User.countDocuments();
  console.log(colors.green.bold(`\n✓ Done. Created ${created}, skipped ${skipped}, total users: ${total}\n`));
  console.log(colors.cyan('Default password for new accounts: ' + DEFAULT_PASSWORD));
  console.log(colors.gray('Existing accounts (Rahul, Sarita, Subham, Mukesh, Manoj) were not modified.\n'));

  await mongoose.disconnect();
  process.exit(0);
}

seedTeam().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
