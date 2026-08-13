const express = require('express');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const AttendanceLog = require('../models/AttendanceLog');
const BreakLog = require('../models/BreakLog');
const DelayRequest = require('../models/DelayRequest');
const SalarySlip = require('../models/SalarySlip');
const MenuFeedback = require('../models/MenuFeedback');
const LunchReservation = require('../models/LunchReservation');
const Message = require('../models/Message');
const Email = require('../models/Email');
const Absence = require('../models/Absence');
const ChatMessage = require('../models/ChatMessage');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { hasPermission, ROLE_LABELS } = require('../constants/permissions');
const {
  buildUserScopeFilter,
  canAssignToBranch,
  canAccessEmployee,
  assertSameCompany,
  toObjectId,
} = require('../utils/scope');
const {
  sendSuccess,
  sendError,
  sanitizeUser,
  buildUserLookupFilter,
  validateShiftTimes,
  nextEmployeeId,
  duplicateKeyMessage,
} = require('../utils/helpers');
const { DEFAULT_SHIFT_START, DEFAULT_SHIFT_END } = require('../constants/shifts');

const router = express.Router();

async function resolveOwnerCompanyIds(user) {
  const memberships = await CompanyMembership.find({ userId: user._id });
  const owned = await Company.find({ ownerUserId: user._id });
  return [
    ...new Set([
      ...memberships.map((m) => String(m.companyId)),
      ...owned.map((c) => String(c._id)),
      user.companyId ? String(user.companyId) : null,
    ].filter(Boolean)),
  ];
}

async function enrichEmployees(users) {
  const branchIds = [
    ...new Set(users.map((u) => (u.branchId ? String(u.branchId) : null)).filter(Boolean)),
  ];
  const deptIds = [
    ...new Set(users.map((u) => (u.departmentId ? String(u.departmentId) : null)).filter(Boolean)),
  ];
  const teamIds = [
    ...new Set(users.map((u) => (u.teamId ? String(u.teamId) : null)).filter(Boolean)),
  ];
  const managerIds = [
    ...new Set(users.map((u) => (u.managerId ? String(u.managerId) : null)).filter(Boolean)),
  ];
  const companyIds = [
    ...new Set(users.map((u) => (u.companyId ? String(u.companyId) : null)).filter(Boolean)),
  ];

  const [branches, departments, teams, managers, companies] = await Promise.all([
    branchIds.length
      ? Branch.find({ _id: { $in: branchIds.map((id) => toObjectId(id)).filter(Boolean) } })
      : [],
    deptIds.length
      ? Department.find({ _id: { $in: deptIds.map((id) => toObjectId(id)).filter(Boolean) } })
      : [],
    teamIds.length
      ? Team.find({ _id: { $in: teamIds.map((id) => toObjectId(id)).filter(Boolean) } })
      : [],
    managerIds.length
      ? User.find({
          _id: { $in: managerIds.map((id) => toObjectId(id)).filter(Boolean) },
        }).select('name email')
      : [],
    companyIds.length
      ? Company.find({ _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } })
      : [],
  ]);

  const branchById = new Map(branches.map((b) => [String(b._id), b]));
  const deptById = new Map(departments.map((d) => [String(d._id), d]));
  const teamById = new Map(teams.map((t) => [String(t._id), t]));
  const managerById = new Map(managers.map((m) => [String(m._id), m]));
  const companyById = new Map(companies.map((c) => [String(c._id), c]));

  return users.map((user) => {
    const mapped = sanitizeUser(user);
    const branch = user.branchId ? branchById.get(String(user.branchId)) : null;
    const dept = user.departmentId ? deptById.get(String(user.departmentId)) : null;
    const team = user.teamId ? teamById.get(String(user.teamId)) : null;
    const manager = user.managerId ? managerById.get(String(user.managerId)) : null;
    const company = user.companyId ? companyById.get(String(user.companyId)) : null;
    return {
      ...mapped,
      branchName: branch?.name || '',
      branchCode: branch?.code || '',
      departmentName: dept?.name || mapped.dept || '',
      teamName: team?.name || '',
      managerName: manager?.name || '',
      companyName: company?.name || '',
      companySlug: company?.slug || '',
    };
  });
}


const DEPT_BY_ROLE = {
  hr: 'Human Resources',
  manager: 'Operations',
  developer: 'Engineering',
  sales: 'Sales',
  designer: 'Product Design',
  accountant: 'Finance',
  marketing: 'Marketing',
  custom: 'General',
  branch_head: 'Branch Management',
  super_admin: 'Administration',
};

const STAFF_ASSIGNABLE = [
  'manager',
  'developer',
  'sales',
  'designer',
  'accountant',
  'marketing',
  'custom',
];

async function findEmployee(id, companyId) {
  const filter = buildUserLookupFilter(id);
  if (companyId) {
    return User.findOne({ $and: [filter, { companyId }] });
  }
  return User.findOne(filter);
}

/** Owner can manage any owned company; others use canAccessEmployee */
async function findManageableEmployee(actor, id) {
  if (actor.systemRole === 'company_owner') {
    const employee = await findEmployee(id, null);
    if (!employee) return null;
    const owned = await resolveOwnerCompanyIds(actor);
    if (!employee.companyId || !owned.includes(String(employee.companyId))) {
      return null;
    }
    return employee;
  }

  const employee = await findEmployee(id, actor.companyId);
  if (!employee) return null;
  if (!canAccessEmployee(actor, employee)) return null;
  return employee;
}

function canEditFullProfile(actorRole) {
  return ['company_owner', 'super_admin', 'hr'].includes(actorRole);
}

async function purgeUserData(userId) {
  await Promise.all([
    AttendanceLog.deleteMany({ userId }),
    BreakLog.deleteMany({ userId }),
    DelayRequest.deleteMany({ userId }),
    SalarySlip.deleteMany({ userId }),
    MenuFeedback.deleteMany({ userId }),
    LunchReservation.deleteMany({ userId }),
    Email.deleteMany({ userId }),
    Absence.deleteMany({ userId }),
    Message.deleteMany({ fromUserId: userId }),
    ChatMessage.deleteMany({
      $or: [{ sender: userId }, { receiver: userId }],
    }),
  ]);
}

function resolveCreatePermission(actorRole, targetRole) {
  if (targetRole === 'branch_head') {
    return hasPermission(actorRole, 'create_branch_head');
  }
  if (targetRole === 'hr') {
    return hasPermission(actorRole, 'create_hr');
  }
  if (targetRole === 'super_admin') {
    return actorRole === 'company_owner';
  }
  if (STAFF_ASSIGNABLE.includes(targetRole)) {
    return hasPermission(actorRole, 'create_employees');
  }
  return false;
}

// GET /api/employees — scoped by actor org visibility
router.get('/', protect, async (req, res) => {
  try {
    const qCompanyId = toObjectId(req.query.companyId);
    const qBranchId = toObjectId(req.query.branchId);
    let filter;

    if (req.user.systemRole === 'company_owner') {
      let companyIds = await resolveOwnerCompanyIds(req.user);
      if (qCompanyId) {
        if (!companyIds.includes(String(qCompanyId))) {
          return sendError(res, 'You do not have access to this company', 403);
        }
        companyIds = [String(qCompanyId)];
      }
      if (!companyIds.length) {
        return sendSuccess(res, {
          employees: [],
          active: [],
          deactivated: [],
          totals: { employees: 0, active: 0, inactive: 0, onLeave: 0 },
        });
      }
      filter = {
        companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
      };
      if (qBranchId) filter.branchId = qBranchId;
    } else {
      const scope = buildUserScopeFilter(req.user);
      filter = scope;
      if (
        req.user.companyId &&
        req.user.branchId &&
        !hasPermission(req.user.systemRole, 'create_employees') &&
        !hasPermission(req.user.systemRole, 'view_all_attendance')
      ) {
        filter = { companyId: req.user.companyId, branchId: req.user.branchId };
      }
      if (qBranchId && hasPermission(req.user.systemRole, 'create_employees')) {
        if (
          req.user.systemRole === 'super_admin' ||
          (req.user.branchId && String(req.user.branchId) === String(qBranchId))
        ) {
          filter = { ...filter, branchId: qBranchId };
        }
      }
    }

    const employees = await User.find(filter).sort({ isActive: -1, name: 1 });
    const enriched = await enrichEmployees(employees);

    const active = enriched.filter((e) => e.isActive !== false);
    const deactivated = enriched.filter((e) => e.isActive === false);
    const onLeave = enriched.filter(
      (e) => String(e.status || '').toLowerCase().includes('leave'),
    );

    return sendSuccess(res, {
      employees: enriched,
      active,
      deactivated,
      totals: {
        employees: enriched.length,
        active: active.length,
        inactive: deactivated.length,
        onLeave: onLeave.length,
      },
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/employees/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const employee = await findEmployee(req.params.id, req.user.companyId);

    if (!employee) {
      return sendError(res, 'Employee not found', 404);
    }

    if (!canAccessEmployee(req.user, employee) && String(employee._id) !== String(req.user._id)) {
      // allow same-branch read for staff directory
      const sameBranch =
        req.user.branchId &&
        employee.branchId &&
        String(req.user.branchId) === String(employee.branchId) &&
        String(req.user.companyId) === String(employee.companyId);
      if (!sameBranch) {
        return sendError(res, 'Forbidden', 403);
      }
    }

    return sendSuccess(res, { employee: sanitizeUser(employee) });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/employees — create under actor company; HR locked to own branch
router.post('/', protect, async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      systemRole,
      role,
      dept,
      salary,
      status,
      avatar,
      shiftStart,
      shiftEnd,
      branchId,
      departmentId,
      teamId,
      managerId,
      companyId,
    } = req.body;

    if (!name || !email || !password || !systemRole) {
      return sendError(res, 'Name, email, password, and systemRole are required');
    }

    if (!resolveCreatePermission(req.user.systemRole, systemRole)) {
      return sendError(res, `Forbidden — cannot create role: ${systemRole}`, 403);
    }

    let targetCompanyId = toObjectId(companyId) || req.user.companyId;
    if (!targetCompanyId) {
      return sendError(res, 'Your account has no company assigned. Run org migration first.', 400);
    }

    if (req.user.systemRole === 'company_owner') {
      const ownedIds = await resolveOwnerCompanyIds(req.user);
      if (!ownedIds.includes(String(targetCompanyId))) {
        return sendError(res, 'You do not own this company', 403);
      }
    } else if (!assertSameCompany(req.user, targetCompanyId)) {
      return sendError(res, 'Cannot create employee for another company', 403);
    }

    // Super Admin / Company Owner are company-wide — never bind to a branch/dept/team
    const needsBranch = !['company_owner', 'super_admin'].includes(systemRole);
    let targetBranchId = needsBranch ? toObjectId(branchId) || req.user.branchId : null;
    let targetDeptId = needsBranch ? toObjectId(departmentId) : null;
    let targetTeamId = needsBranch ? toObjectId(teamId) : null;
    let deptLabel = dept || DEPT_BY_ROLE[systemRole] || 'General';

    if (needsBranch) {
      if (req.user.systemRole !== 'company_owner' && !canAssignToBranch(req.user, targetBranchId)) {
        return sendError(
          res,
          'HR / Branch Head can only create employees in their own branch',
          403,
        );
      }
      if (!targetBranchId) {
        return sendError(res, 'branchId is required for this role');
      }
    }

    if (targetBranchId) {
      const branch = await Branch.findOne({
        _id: targetBranchId,
        companyId: targetCompanyId,
      });
      if (!branch) {
        return sendError(res, 'Branch not found in this company', 404);
      }
    }

    if (targetDeptId) {
      const department = await Department.findOne({
        _id: targetDeptId,
        companyId: targetCompanyId,
      });
      if (!department) {
        return sendError(res, 'Department not found', 404);
      }
      if (targetBranchId && String(department.branchId) !== String(targetBranchId)) {
        return sendError(res, 'Department does not belong to selected branch');
      }
      targetBranchId = department.branchId;
      deptLabel = department.name;
    }

    if (targetTeamId) {
      const team = await Team.findOne({
        _id: targetTeamId,
        companyId: targetCompanyId,
      });
      if (!team) {
        return sendError(res, 'Team not found', 404);
      }
      if (targetBranchId && String(team.branchId) !== String(targetBranchId)) {
        return sendError(res, 'Team does not belong to selected branch');
      }
      targetBranchId = team.branchId;
      targetDeptId = team.departmentId;
    }

    // Re-check branch after dept/team resolution (HR lock)
    if (
      needsBranch &&
      req.user.systemRole !== 'company_owner' &&
      !canAssignToBranch(req.user, targetBranchId)
    ) {
      return sendError(
        res,
        'HR / Branch Head can only create employees in their own branch',
        403,
      );
    }

    const existing = await User.findOne({
      companyId: targetCompanyId,
      email: email.toLowerCase(),
    });
    if (existing) {
      return sendError(res, 'Email already registered in this company');
    }

    const shiftError = validateShiftTimes(shiftStart, shiftEnd);
    if (shiftError) {
      return sendError(res, shiftError);
    }

    const employeeId = await nextEmployeeId(User, targetCompanyId);
    const isHr = systemRole === 'hr';

    const user = await User.create({
      employeeId,
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password,
      role: role || ROLE_LABELS[systemRole] || systemRole.replace('_', ' '),
      systemRole,
      dept: deptLabel,
      companyId: targetCompanyId,
      branchId: targetBranchId || null,
      departmentId: targetDeptId || null,
      teamId: targetTeamId || null,
      teamIds: targetTeamId ? [targetTeamId] : [],
      managerId: toObjectId(managerId) || null,
      salary: salary ?? (isHr ? 5000 : 4000),
      status: status || 'Active',
      avatar: avatar || (isHr ? '👩‍💼' : '👤'),
      shiftStart: shiftStart || DEFAULT_SHIFT_START,
      shiftEnd: shiftEnd || DEFAULT_SHIFT_END,
      isActive: true,
    });

    await CompanyMembership.findOneAndUpdate(
      { userId: user._id, companyId: targetCompanyId },
      {
        userId: user._id,
        companyId: targetCompanyId,
        systemRole,
        branchId: needsBranch ? targetBranchId || null : null,
        isDefault: true,
      },
      { upsert: true, new: true },
    );

    const [enriched] = await enrichEmployees([user]);
    const message =
      systemRole === 'super_admin'
        ? 'Super Admin created'
        : isHr
          ? 'HR account created'
          : 'Employee created';
    return sendSuccess(res, { employee: enriched }, message, 201);
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, duplicateKeyMessage(err));
    }
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/employees/:id — Owner / Super Admin / HR (and other edit_employees) update user data
router.patch('/:id', protect, authorize('edit_employees'), async (req, res) => {
  try {
    const employee = await findManageableEmployee(req.user, req.params.id);
    if (!employee) {
      return sendError(res, 'Employee not found or outside your scope', 404);
    }

    const fullEdit = canEditFullProfile(req.user.systemRole);

    // Role changes — only owner / SA / HR, and only roles they may create (or keep current)
    if (req.body.systemRole !== undefined && req.body.systemRole !== employee.systemRole) {
      if (!fullEdit) {
        return sendError(res, 'Forbidden — cannot change system role', 403);
      }
      const nextRole = String(req.body.systemRole);
      const ok =
        resolveCreatePermission(req.user.systemRole, nextRole) ||
        (req.user.systemRole === 'company_owner' && nextRole === 'super_admin') ||
        (req.user.systemRole === 'super_admin' && nextRole === 'super_admin');
      if (!ok) {
        return sendError(res, `Forbidden — cannot assign role: ${nextRole}`, 403);
      }
      // HR cannot promote to branch_head / super_admin / hr above themselves
      if (
        req.user.systemRole === 'hr' &&
        ['company_owner', 'super_admin', 'branch_head', 'hr'].includes(nextRole)
      ) {
        return sendError(res, 'HR cannot assign this role', 403);
      }
      employee.systemRole = nextRole;
      if (!req.body.role) {
        employee.role = ROLE_LABELS[nextRole] || nextRole;
      }
      if (['company_owner', 'super_admin'].includes(nextRole)) {
        employee.branchId = null;
        employee.departmentId = null;
        employee.teamId = null;
        employee.teamIds = [];
      }
    }

    const allowed = [
      'name',
      'role',
      'dept',
      'status',
      'avatar',
      'shiftStart',
      'shiftEnd',
      'departmentId',
      'teamId',
      'managerId',
      'phone',
    ];
    if (fullEdit) {
      allowed.push('email');
    }
    if (hasPermission(req.user.systemRole, 'manage_salary')) {
      allowed.push('salary');
    }

    // Branch change — Super Admin stays company-wide (no branch)
    if (req.body.branchId !== undefined) {
      if (['company_owner', 'super_admin'].includes(employee.systemRole)) {
        employee.branchId = null;
      } else {
        const newBranchId = toObjectId(req.body.branchId) || null;
        if (newBranchId) {
          const branch = await Branch.findById(newBranchId);
          if (!branch) return sendError(res, 'Branch not found', 404);
          if (String(branch.companyId) !== String(employee.companyId)) {
            return sendError(res, 'Branch must belong to the employee company', 403);
          }
          if (req.user.systemRole === 'company_owner') {
            const owned = await resolveOwnerCompanyIds(req.user);
            if (!owned.includes(String(branch.companyId))) {
              return sendError(res, 'Cannot move employee to another branch', 403);
            }
          } else if (!canAssignToBranch(req.user, newBranchId)) {
            return sendError(res, 'Cannot move employee to another branch', 403);
          }
        }
        employee.branchId = newBranchId;
      }
    }

    const shiftError = validateShiftTimes(req.body.shiftStart, req.body.shiftEnd);
    if (shiftError) {
      return sendError(res, shiftError);
    }

    if (req.body.email !== undefined && fullEdit) {
      const nextEmail = String(req.body.email).toLowerCase().trim();
      if (!nextEmail) return sendError(res, 'Email is required');
      if (nextEmail !== employee.email) {
        const clash = await User.findOne({
          companyId: employee.companyId,
          email: nextEmail,
          _id: { $ne: employee._id },
        }).select('_id');
        if (clash) return sendError(res, 'Email already registered in this company');
        employee.email = nextEmail;
      }
    }

    allowed.forEach((field) => {
      if (field === 'email') return; // handled above
      if (req.body[field] !== undefined) {
        if (['departmentId', 'teamId', 'managerId'].includes(field)) {
          employee[field] = toObjectId(req.body[field]) || null;
        } else if (field === 'salary') {
          employee.salary = Number(req.body.salary) || 0;
        } else {
          employee[field] = req.body[field];
        }
      }
    });

    if (req.body.dept === undefined && req.body.departmentId !== undefined) {
      const deptId = toObjectId(req.body.departmentId);
      if (deptId) {
        const dept = await Department.findById(deptId).select('name');
        if (dept?.name) employee.dept = dept.name;
      }
    }

    if (req.body.teamId !== undefined) {
      const tid = toObjectId(req.body.teamId);
      if (tid) {
        const ids = new Set((employee.teamIds || []).map(String));
        ids.add(String(tid));
        employee.teamIds = [...ids];
        employee.teamId = tid;
      } else {
        employee.teamId = null;
      }
    }

    if (req.body.isActive === true) {
      employee.isActive = true;
      if (!employee.status || employee.status === 'Inactive') {
        employee.status = 'Active';
      }
    } else if (req.body.isActive === false && fullEdit) {
      employee.isActive = false;
      employee.status = 'Inactive';
    }

    if (fullEdit && req.body.status !== undefined) {
      const st = String(req.body.status);
      employee.status = st;
      if (st === 'Inactive') employee.isActive = false;
      if (st === 'Active') employee.isActive = true;
    }

    await employee.save();

    const [enriched] = await enrichEmployees([employee]);
    return sendSuccess(res, { employee: enriched }, 'Employee updated');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.patch(
  '/:id/password',
  protect,
  authorize('reset_employee_password'),
  async (req, res) => {
    try {
      const employee = await findManageableEmployee(req.user, req.params.id);
      if (!employee) {
        return sendError(res, 'Employee not found or outside your scope', 404);
      }

      const { password } = req.body;
      if (!password || typeof password !== 'string' || password.trim().length < 6) {
        return sendError(res, 'Password must be at least 6 characters');
      }

      employee.password = password.trim();
      await employee.save();

      return sendSuccess(res, { employeeId: employee.employeeId }, 'Password updated');
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

router.patch('/:id/reactivate', protect, authorize('edit_employees'), async (req, res) => {
  try {
    const employee = await findManageableEmployee(req.user, req.params.id);
    if (!employee) {
      return sendError(res, 'Employee not found or outside your scope', 404);
    }

    employee.isActive = true;
    employee.status = req.body.status || 'Active';
    await employee.save();

    const [enriched] = await enrichEmployees([employee]);
    return sendSuccess(res, { employee: enriched }, 'Employee reactivated');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.patch('/:id/deactivate', protect, authorize('delete_employees'), async (req, res) => {
  try {
    const employee = await findManageableEmployee(req.user, req.params.id);
    if (!employee) {
      return sendError(res, 'Employee not found or outside your scope', 404);
    }

    if (employee._id.toString() === req.user._id.toString()) {
      return sendError(res, 'You cannot deactivate your own account', 400);
    }

    employee.isActive = false;
    employee.status = 'Inactive';
    await employee.save();

    return sendSuccess(res, { employee: sanitizeUser(employee) }, 'Employee deactivated');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.delete('/:id', protect, authorize('delete_employees'), async (req, res) => {
  try {
    const employee = await findManageableEmployee(req.user, req.params.id);
    if (!employee) {
      return sendError(res, 'Employee not found or outside your scope', 404);
    }

    if (employee._id.toString() === req.user._id.toString()) {
      return sendError(res, 'You cannot delete your own account', 400);
    }

    await purgeUserData(employee._id);
    await employee.deleteOne();

    return sendSuccess(res, { employeeId: employee.employeeId }, 'Employee deleted permanently');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
