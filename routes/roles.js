const express = require('express');
const CustomRole = require('../models/CustomRole');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  PERMISSION_MATRIX,
  ROLE_LABELS,
  BRANCH_SCOPED_ROLES,
  STAFF_ROLES,
} = require('../constants/permissions');
const { assertSameCompany, toObjectId } = require('../utils/scope');
const { sendSuccess, sendError } = require('../utils/helpers');

const router = express.Router();

const ROLE_META = [
  {
    key: 'company_owner',
    scope: 'All companies',
    description: 'Owns every tenant. Can onboard companies and switch between them.',
  },
  {
    key: 'super_admin',
    scope: 'One company',
    description: 'Full control inside a single company across all its branches.',
  },
  {
    key: 'branch_head',
    scope: 'One branch',
    description: 'Runs one branch — approves leave and manages departments and teams.',
  },
  {
    key: 'hr',
    scope: 'One branch',
    description: 'Branch-level HR. Cannot create or edit employees of another branch.',
  },
  {
    key: 'manager',
    scope: 'One team',
    description: 'Owns a team — tasks, attendance visibility and first-level approvals.',
  },
  {
    key: 'employee',
    scope: 'Self',
    description: 'Self-service only — attendance, leave, payslips and documents.',
    aggregateStaff: true,
  },
];

const MATRIX_COLUMNS = [
  { key: 'owner', role: 'company_owner' },
  { key: 'superAdmin', role: 'super_admin' },
  { key: 'branchHead', role: 'branch_head' },
  { key: 'hr', role: 'hr' },
  { key: 'manager', role: 'manager' },
];

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

function buildPermissionRows() {
  return Object.entries(PERMISSION_MATRIX).map(([permission, allowed]) => {
    const row = { permission };
    MATRIX_COLUMNS.forEach(({ key, role }) => {
      row[key] = allowed === 'all' || (Array.isArray(allowed) && allowed.includes(role));
    });
    return row;
  });
}

function formatCustomRole(r, companyById) {
  const company = r.companyId ? companyById?.get(String(r.companyId)) : null;
  return {
    id: String(r._id),
    name: r.name,
    description: r.description || '',
    createdBy: r.createdBy,
    companyId: r.companyId ? String(r.companyId) : null,
    companyName: company?.name || '',
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
  };
}

// GET /api/roles — system + custom roles, permission matrix, account counts
router.get('/', protect, async (req, res) => {
  try {
    let companyIds = [];

    if (req.user.systemRole === 'company_owner') {
      companyIds = await resolveOwnerCompanyIds(req.user);
    } else if (req.user.companyId) {
      companyIds = [String(req.user.companyId)];
    }

    const companyFilter = companyIds.length
      ? { companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } }
      : { _id: null };

    const [counts, customRoles, companies] = await Promise.all([
      User.aggregate([
        { $match: companyFilter },
        { $group: { _id: '$systemRole', count: { $sum: 1 } } },
      ]),
      companyIds.length
        ? CustomRole.find(companyFilter).sort({ createdAt: -1 })
        : CustomRole.find({ companyId: null }).sort({ createdAt: -1 }),
      companyIds.length
        ? Company.find({ _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } })
        : [],
    ]);

    const countByRole = new Map(counts.map((c) => [c._id, c.count]));
    const staffCount = STAFF_ROLES.reduce((s, key) => s + (countByRole.get(key) || 0), 0);
    const companyById = new Map(companies.map((c) => [String(c._id), c]));

    const systemRoles = ROLE_META.map((meta) => {
      const accounts = meta.aggregateStaff
        ? staffCount
        : countByRole.get(meta.key) || 0;
      return {
        key: meta.key,
        role: ROLE_LABELS[meta.key] || meta.key.replace(/_/g, ' '),
        label: ROLE_LABELS[meta.key] || (meta.aggregateStaff ? 'Employee' : meta.key),
        scope: meta.scope,
        description: meta.description,
        accounts,
        isSystem: true,
      };
    });
    // Fix employee label
    const emp = systemRoles.find((r) => r.key === 'employee');
    if (emp) {
      emp.role = 'Employee';
      emp.label = 'Employee';
    }

    const permissionMatrix = buildPermissionRows();
    const assignedAccounts = systemRoles.reduce((s, r) => s + r.accounts, 0);

    const totals = {
      systemRoles: systemRoles.length,
      permissions: permissionMatrix.length,
      branchScopedRoles: BRANCH_SCOPED_ROLES.length,
      assignedAccounts,
      customRoles: customRoles.length,
    };

    return sendSuccess(res, {
      systemRoles,
      customRoles: customRoles.map((r) => formatCustomRole(r, companyById)),
      permissionMatrix,
      totals,
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/roles/custom — company scoped
router.get('/custom', protect, async (req, res) => {
  try {
    let filter = {};
    if (req.user.systemRole === 'company_owner') {
      const companyIds = await resolveOwnerCompanyIds(req.user);
      filter = {
        companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
      };
    } else if (req.user.companyId) {
      filter = { companyId: req.user.companyId };
    }

    const roles = await CustomRole.find(filter).sort({ createdAt: -1 });
    const companyIds = [
      ...new Set(roles.map((r) => (r.companyId ? String(r.companyId) : null)).filter(Boolean)),
    ];
    const companies = companyIds.length
      ? await Company.find({ _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } })
      : [];
    const companyById = new Map(companies.map((c) => [String(c._id), c]));

    return sendSuccess(res, {
      roles: roles.map((r) => formatCustomRole(r, companyById)),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/roles/custom
router.post('/custom', protect, authorize('create_roles'), async (req, res) => {
  try {
    const { name, description, companyId } = req.body;

    if (!name) {
      return sendError(res, 'Role name is required');
    }

    let targetCompanyId = toObjectId(companyId) || req.user.companyId;
    if (!targetCompanyId) {
      return sendError(res, 'No active company on user', 400);
    }

    if (req.user.systemRole === 'company_owner') {
      const ownedIds = await resolveOwnerCompanyIds(req.user);
      if (!ownedIds.includes(String(targetCompanyId))) {
        return sendError(res, 'You do not own this company', 403);
      }
    } else if (!assertSameCompany(req.user, targetCompanyId)) {
      return sendError(res, 'Cannot create role for another company', 403);
    }

    const createdBy = `${req.user.name} (${req.user.role})`;

    const role = await CustomRole.create({
      companyId: targetCompanyId,
      name: String(name).trim(),
      description: description || '',
      createdBy,
    });

    const company = await Company.findById(targetCompanyId);

    return sendSuccess(
      res,
      {
        role: formatCustomRole(role, new Map([[String(targetCompanyId), company]])),
      },
      'Custom role created',
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Role name already exists in this company');
    }
    return sendError(res, err.message, 500);
  }
});

// DELETE /api/roles/custom/:id
router.delete('/custom/:id', protect, authorize('create_roles'), async (req, res) => {
  try {
    const roleId = toObjectId(req.params.id);
    if (!roleId) return sendError(res, 'Invalid role id');

    const role = await CustomRole.findById(roleId);
    if (!role) {
      return sendError(res, 'Role not found', 404);
    }

    if (req.user.systemRole === 'company_owner') {
      const ownedIds = await resolveOwnerCompanyIds(req.user);
      if (!ownedIds.includes(String(role.companyId))) {
        return sendError(res, 'You do not own this company', 403);
      }
    } else if (!assertSameCompany(req.user, role.companyId)) {
      return sendError(res, 'Forbidden', 403);
    }

    await role.deleteOne();
    return sendSuccess(res, null, 'Custom role deleted');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
