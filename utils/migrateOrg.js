/**
 * Non-destructive org migration.
 *
 * - Creates Company: EZ Wealth (ezwealth) — New Delhi / CP
 * - Creates Branch: New Delhi - CP (head office)
 * - Creates Company: Bharat Demography — Noida (empty teams for now)
 * - Assigns ALL existing users → EZ Wealth + New Delhi CP
 * - Promotes first super_admin (or first user) → company_owner (CEO)
 * - Links CEO as owner of BOTH companies + CompanyMembership rows
 *
 * Does NOT delete users or attendance data.
 * Usage:  npm run migrate:org
 */
require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');

const User = require('../models/User');
const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const CompanyMembership = require('../models/CompanyMembership');

async function dropLegacyUniqueIndexes() {
  const collection = mongoose.connection.collection('users');
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    const keys = Object.keys(idx.key || {});
    // Drop old global unique on email / employeeId if present
    if (
      idx.unique &&
      keys.length === 1 &&
      (keys[0] === 'email' || keys[0] === 'employeeId')
    ) {
      console.log(colors.yellow(`  Dropping legacy unique index: ${idx.name}`));
      try {
        await collection.dropIndex(idx.name);
      } catch (e) {
        console.log(colors.gray(`  (skip drop ${idx.name}: ${e.message})`));
      }
    }
  }
}

async function ensureCompany({ name, slug, city, address, ownerUserId }) {
  let company = await Company.findOne({ slug });
  if (company) {
    console.log(colors.cyan(`  Company exists: ${company.name}`));
    if (ownerUserId && !company.ownerUserId) {
      company.ownerUserId = ownerUserId;
      await company.save();
    }
    return company;
  }
  company = await Company.create({
    name,
    slug,
    legalName: name,
    city,
    address,
    ownerUserId: ownerUserId || null,
    status: 'Active',
  });
  console.log(colors.green(`  Created company: ${company.name}`));
  return company;
}

async function ensureBranch({ companyId, name, code, city, address, isHeadOffice }) {
  let branch = await Branch.findOne({ companyId, code });
  if (branch) {
    console.log(colors.cyan(`  Branch exists: ${branch.name}`));
    return branch;
  }
  branch = await Branch.create({
    companyId,
    name,
    code,
    city,
    address,
    isHeadOffice: !!isHeadOffice,
    status: 'Active',
  });
  console.log(colors.green(`  Created branch: ${branch.name}`));
  return branch;
}

async function ensureDefaultDepartments(companyId, branchId) {
  const names = ['IT', 'Sales', 'Finance', 'HR', 'Administration'];
  for (const name of names) {
    const existing = await Department.findOne({ branchId, name });
    if (!existing) {
      await Department.create({
        companyId,
        branchId,
        name,
        code: name.slice(0, 3).toUpperCase(),
      });
      console.log(colors.green(`  Created department: ${name}`));
    }
  }
}

async function ensureMembership({ userId, companyId, systemRole, branchId, isDefault }) {
  await CompanyMembership.findOneAndUpdate(
    { userId, companyId },
    {
      userId,
      companyId,
      systemRole,
      branchId: branchId || null,
      isDefault: !!isDefault,
    },
    { upsert: true, returnDocument: 'after' },
  );
}

async function migrate() {
  await connectDB();
  console.log(colors.bold('\n=== Org Migration (preserve users) ===\n'));

  await dropLegacyUniqueIndexes();

  const users = await User.find().sort({ createdAt: 1 });
  console.log(colors.white(`Found ${users.length} existing user(s)`));

  let owner =
    users.find((u) => u.systemRole === 'company_owner') ||
    users.find((u) => u.systemRole === 'super_admin') ||
    users[0] ||
    null;

  if (!owner) {
    console.log(colors.yellow('No users found — creating placeholder CEO after companies…'));
  }

  // 1) EZ Wealth — New Delhi CP
  const ezwealth = await ensureCompany({
    name: 'EZ Wealth',
    slug: 'ezwealth',
    city: 'New Delhi',
    address: 'Connaught Place (CP), New Delhi',
    ownerUserId: owner?._id,
  });

  const delhiBranch = await ensureBranch({
    companyId: ezwealth._id,
    name: 'New Delhi - CP',
    code: 'DEL-CP',
    city: 'New Delhi',
    address: 'Connaught Place, New Delhi',
    isHeadOffice: true,
  });

  await ensureDefaultDepartments(ezwealth._id, delhiBranch._id);

  // 2) Bharat Demography — Noida (structure only; no staff yet)
  const bharat = await ensureCompany({
    name: 'Bharat Demography',
    slug: 'bharat-demography',
    city: 'Noida',
    address: 'Noida, Uttar Pradesh',
    ownerUserId: owner?._id,
  });

  const noidaBranch = await ensureBranch({
    companyId: bharat._id,
    name: 'Noida',
    code: 'NOIDA',
    city: 'Noida',
    address: 'Noida, Uttar Pradesh',
    isHeadOffice: true,
  });

  await ensureDefaultDepartments(bharat._id, noidaBranch._id);

  // 3) Assign every existing user to EZ Wealth + Delhi CP
  let updated = 0;
  for (const user of users) {
    const wasOwnerCandidate = owner && String(user._id) === String(owner._id);
    const nextRole = wasOwnerCandidate ? 'company_owner' : user.systemRole;

    // Only rewrite org fields if missing OR force-align to ezwealth for migration
    user.companyId = ezwealth._id;
    user.branchId = delhiBranch._id;
    if (wasOwnerCandidate) {
      user.systemRole = 'company_owner';
      user.role = 'Company Owner';
      // Owner is company-wide — branchId still set as home branch for display
    }
    if (!user.dept) user.dept = 'General';

    // Link departmentId from legacy string dept (create dept if missing)
    if (!user.departmentId && user.dept) {
      const label = String(user.dept).trim();
      let department = await Department.findOne({
        branchId: delhiBranch._id,
        name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (!department) {
        // Common aliases → default seed names
        const aliases = {
          'human resources': 'HR',
          hr: 'HR',
          engineering: 'IT',
          general: 'Administration',
          admin: 'Administration',
        };
        const key = label.toLowerCase();
        const mapped = aliases[key];
        if (mapped) {
          department = await Department.findOne({
            branchId: delhiBranch._id,
            name: mapped,
          });
        }
      }
      if (!department) {
        department = await Department.create({
          companyId: ezwealth._id,
          branchId: delhiBranch._id,
          name: label,
          code: label.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GEN',
        });
      }
      user.departmentId = department._id;
      user.dept = department.name;
    }

    await user.save();
    updated += 1;

    await ensureMembership({
      userId: user._id,
      companyId: ezwealth._id,
      systemRole: nextRole,
      branchId: wasOwnerCandidate ? null : delhiBranch._id,
      isDefault: true,
    });
  }

  if (owner) {
    // Refresh owner ref after save
    owner = await User.findById(owner._id);
    ezwealth.ownerUserId = owner._id;
    await ezwealth.save();
    bharat.ownerUserId = owner._id;
    await bharat.save();

    // CEO membership on Bharat Demography (no branch lock — company-wide)
    await ensureMembership({
      userId: owner._id,
      companyId: bharat._id,
      systemRole: 'company_owner',
      branchId: null,
      isDefault: false,
    });
  }

  // Sync CustomRole unique index — attach companyId to existing roles
  try {
    const CustomRole = require('../models/CustomRole');
    await CustomRole.updateMany(
      { companyId: null },
      { $set: { companyId: ezwealth._id } },
    );
  } catch (e) {
    console.log(colors.gray(`  CustomRole sync skip: ${e.message}`));
  }

  console.log(colors.green.bold(`\n✓ Migration complete`));
  console.log(colors.white(`  Users linked to EZ Wealth / New Delhi-CP : ${updated}`));
  console.log(colors.white(`  EZ Wealth company id     : ${ezwealth._id}`));
  console.log(colors.white(`  Delhi CP branch id       : ${delhiBranch._id}`));
  console.log(colors.white(`  Bharat Demography id     : ${bharat._id}`));
  console.log(colors.white(`  Noida branch id          : ${noidaBranch._id}`));
  if (owner) {
    console.log(colors.cyan(`\n  Company Owner (CEO): ${owner.name} <${owner.email}>`));
    console.log(colors.gray('  Can switch between EZ Wealth ↔ Bharat Demography via /api/auth/switch-company\n'));
  }

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
