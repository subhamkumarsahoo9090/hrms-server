/**
 * DESTRUCTIVE seed — wipes DB then creates:
 *   Company Owner + EZ Wealth (Delhi CP) + Bharat Demography (Noida)
 *
 * Prefer `npm run migrate:org` if you need to KEEP existing users.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const colors = require('colors');
const connectDB = require('../config/db');

const User = require('../models/User');
const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const CompanyMembership = require('../models/CompanyMembership');
const CustomRole = require('../models/CustomRole');
const AttendanceLog = require('../models/AttendanceLog');
const BreakLog = require('../models/BreakLog');
const DelayRequest = require('../models/DelayRequest');
const SalarySlip = require('../models/SalarySlip');
const Menu = require('../models/Menu');
const MenuCatalog = require('../models/MenuCatalog');
const MenuFeedback = require('../models/MenuFeedback');
const LunchReservation = require('../models/LunchReservation');
const Message = require('../models/Message');
const Email = require('../models/Email');
const Absence = require('../models/Absence');
const ChatMessage = require('../models/ChatMessage');
const SystemSettings = require('../models/SystemSettings');
const NotificationDismissal = require('../models/NotificationDismissal');

async function seed() {
  await connectDB();

  console.log(colors.yellow('Clearing all database data...'));
  await Promise.all([
    User.deleteMany(),
    Company.deleteMany(),
    Branch.deleteMany(),
    Department.deleteMany(),
    Team.deleteMany(),
    CompanyMembership.deleteMany(),
    CustomRole.deleteMany(),
    AttendanceLog.deleteMany(),
    BreakLog.deleteMany(),
    DelayRequest.deleteMany(),
    SalarySlip.deleteMany(),
    Menu.deleteMany(),
    MenuCatalog.deleteMany(),
    MenuFeedback.deleteMany(),
    LunchReservation.deleteMany(),
    Message.deleteMany(),
    Email.deleteMany(),
    Absence.deleteMany(),
    ChatMessage.deleteMany(),
    SystemSettings.deleteMany(),
    NotificationDismissal.deleteMany(),
  ]);

  console.log(colors.yellow('Creating companies & branches...'));

  const ezwealth = await Company.create({
    name: 'EZ Wealth',
    slug: 'ezwealth',
    legalName: 'EZ Wealth',
    city: 'New Delhi',
    address: 'Connaught Place (CP), New Delhi',
    status: 'Active',
  });

  const delhiBranch = await Branch.create({
    companyId: ezwealth._id,
    name: 'New Delhi - CP',
    code: 'DEL-CP',
    city: 'New Delhi',
    address: 'Connaught Place, New Delhi',
    isHeadOffice: true,
  });

  for (const name of ['IT', 'Sales', 'Finance', 'HR', 'Administration']) {
    await Department.create({
      companyId: ezwealth._id,
      branchId: delhiBranch._id,
      name,
      code: name.slice(0, 3).toUpperCase(),
    });
  }

  const bharat = await Company.create({
    name: 'Bharat Demography',
    slug: 'bharat-demography',
    legalName: 'Bharat Demography',
    city: 'Noida',
    address: 'Noida, Uttar Pradesh',
    status: 'Active',
  });

  const noidaBranch = await Branch.create({
    companyId: bharat._id,
    name: 'Noida',
    code: 'NOIDA',
    city: 'Noida',
    address: 'Noida, Uttar Pradesh',
    isHeadOffice: true,
  });

  for (const name of ['IT', 'Sales', 'Finance', 'HR', 'Administration']) {
    await Department.create({
      companyId: bharat._id,
      branchId: noidaBranch._id,
      name,
      code: name.slice(0, 3).toUpperCase(),
    });
  }

  console.log(colors.yellow('Creating Company Owner (CEO)...'));
  const owner = await User.create({
    employeeId: 'EMP001',
    name: 'Rahul Agarwal',
    email: 'rahul.agarwal@hrcore.com',
    password: 'admin123',
    role: 'Company Owner',
    systemRole: 'company_owner',
    dept: 'Administration',
    companyId: ezwealth._id,
    branchId: delhiBranch._id,
    status: 'Active',
    avatar: '🏢',
    delayCount: 0,
    salary: 0,
    isActive: true,
  });

  ezwealth.ownerUserId = owner._id;
  await ezwealth.save();
  bharat.ownerUserId = owner._id;
  await bharat.save();

  await CompanyMembership.create([
    {
      userId: owner._id,
      companyId: ezwealth._id,
      systemRole: 'company_owner',
      branchId: null,
      isDefault: true,
    },
    {
      userId: owner._id,
      companyId: bharat._id,
      systemRole: 'company_owner',
      branchId: null,
      isDefault: false,
    },
  ]);

  console.log(colors.green.bold('\n✓ Fresh seed complete\n'));
  console.log(colors.cyan('Company Owner login:'));
  console.log(colors.white('  Email    → rahul.agarwal@hrcore.com'));
  console.log(colors.white('  Password → admin123'));
  console.log(colors.gray('\nCompanies: EZ Wealth (Delhi CP) + Bharat Demography (Noida)'));
  console.log(colors.gray('To KEEP existing users instead, run: npm run migrate:org\n'));

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error(colors.red(err));
  process.exit(1);
});
