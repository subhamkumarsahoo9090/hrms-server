/**
 * RBAC matrix + org roles for multi-company / multi-branch HR Core.
 *
 * Hierarchy (within a company):
 *   company_owner (CEO)
 *   └── super_admin
 *       └── branch_head
 *           ├── hr          ← branch-scoped (cannot create users in other branches)
 *           ├── manager     ← team-scoped
 *           └── staff roles
 */

const PERMISSION_MATRIX = {
  // Org structure
  manage_companies: ['company_owner'],
  create_branch: ['company_owner', 'super_admin'],
  manage_branches: ['company_owner', 'super_admin'],
  create_department: ['company_owner', 'super_admin', 'branch_head', 'hr'],
  create_team: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],

  // People
  create_branch_head: ['company_owner', 'super_admin'],
  create_hr: ['company_owner', 'super_admin', 'branch_head'],
  create_roles: ['company_owner', 'super_admin', 'hr'],
  create_employees: ['company_owner', 'super_admin', 'branch_head', 'hr'],
  edit_employees: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  delete_employees: ['company_owner', 'super_admin', 'branch_head', 'hr'],
  reset_employee_password: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  manage_salary: ['company_owner', 'super_admin', 'hr'],
  generate_payslip: ['company_owner', 'super_admin', 'hr'],
  view_own_payslip: 'all',

  // Attendance
  view_all_attendance: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  view_team_attendance: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  clock_in: 'all',
  clock_out: 'all',
  break_in_out: 'all',

  // Comms
  manage_messages: ['company_owner', 'super_admin', 'hr'],
  view_messages: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  view_emails: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  view_absent_users: 'all',

  // Settings / catering
  manage_system_settings: ['company_owner', 'super_admin'],
  manage_catering: ['hr', 'branch_head'],

  // Leave
  view_leave: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],
  apply_leave: 'all',
  approve_leave: ['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'],

  // Recruitment
  manage_recruitment: ['company_owner', 'super_admin', 'branch_head', 'hr'],
};

const SYSTEM_ROLES = [
  'company_owner',
  'super_admin',
  'branch_head',
  'hr',
  'manager',
  'developer',
  'sales',
  'designer',
  'accountant',
  'marketing',
  'custom',
];

const STAFF_ROLES = [
  'developer',
  'sales',
  'designer',
  'accountant',
  'marketing',
  'custom',
];

const ROLE_LABELS = {
  company_owner: 'Company Owner',
  super_admin: 'Super Admin',
  branch_head: 'Branch Head',
  hr: 'HR',
  manager: 'Manager',
  developer: 'Developer',
  sales: 'Sales Person',
  designer: 'Designer',
  accountant: 'Accountant',
  marketing: 'Marketing',
  custom: 'Custom Role',
};

/** Roles that see company-wide data (all branches) */
const COMPANY_WIDE_ROLES = ['company_owner', 'super_admin'];

/** Roles locked to a single branch */
const BRANCH_SCOPED_ROLES = ['branch_head', 'hr'];

/** Roles locked to team / reportees */
const TEAM_SCOPED_ROLES = ['manager'];

function hasPermission(role, permission) {
  const allowed = PERMISSION_MATRIX[permission];
  if (!allowed) return false;
  if (allowed === 'all') return true;
  return allowed.includes(role);
}

function isCompanyWideRole(role) {
  return COMPANY_WIDE_ROLES.includes(role);
}

function isBranchScopedRole(role) {
  return BRANCH_SCOPED_ROLES.includes(role);
}

function isTeamScopedRole(role) {
  return TEAM_SCOPED_ROLES.includes(role);
}

module.exports = {
  PERMISSION_MATRIX,
  SYSTEM_ROLES,
  STAFF_ROLES,
  ROLE_LABELS,
  COMPANY_WIDE_ROLES,
  BRANCH_SCOPED_ROLES,
  TEAM_SCOPED_ROLES,
  hasPermission,
  isCompanyWideRole,
  isBranchScopedRole,
  isTeamScopedRole,
};
