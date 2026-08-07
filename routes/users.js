const express = require('express');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { hasPermission, ROLE_LABELS, isCompanyWideRole } = require('../constants/permissions');
const {
  buildUserScopeFilter,
  canAssignToBranch,
  toObjectId,
} = require('../utils/scope');
const { sendSuccess, sendError, sanitizeUser } = require('../utils/helpers');

const router = express.Router();

const PRIVILEGED_ROLES = new Set([
  'company_owner',
  'super_admin',
  'branch_head',
  'hr',
  'manager',
]);

const ROLE_RANK = {
  company_owner: 0,
  super_admin: 1,
  branch_head: 2,
  hr: 3,
  manager: 4,
};

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

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function generateEmployeeId(companyId) {
  const count = await User.countDocuments({ companyId });
  return `EMP${String(count + 1).padStart(3, '0')}`;
}

// GET /api/users — login accounts visible to actor
router.get('/', protect, async (req, res) => {
  try {
    const qCompanyId = toObjectId(req.query.companyId);
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
          users: [],
          totals: { users: 0, active: 0, privileged: 0, loggedInToday: 0 },
        });
      }
      filter = {
        companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
      };
    } else if (!hasPermission(req.user.systemRole, 'create_employees') && !isCompanyWideRole(req.user.systemRole)) {
      // non-admin: only self
      filter = { _id: req.user._id };
    } else {
      filter = buildUserScopeFilter(req.user);
    }

    const users = await User.find(filter).sort({ isActive: -1, name: 1 });

    const branchIds = [
      ...new Set(users.map((u) => (u.branchId ? String(u.branchId) : null)).filter(Boolean)),
    ];
    const companyIds = [
      ...new Set(users.map((u) => (u.companyId ? String(u.companyId) : null)).filter(Boolean)),
    ];

    const [branches, companies] = await Promise.all([
      branchIds.length
        ? Branch.find({ _id: { $in: branchIds.map((id) => toObjectId(id)).filter(Boolean) } })
        : [],
      companyIds.length
        ? Company.find({ _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } })
        : [],
    ]);

    const branchById = new Map(branches.map((b) => [String(b._id), b]));
    const companyById = new Map(companies.map((c) => [String(c._id), c]));
    const todayStart = startOfToday();

    const enriched = users
      .map((u) => {
        const mapped = sanitizeUser(u);
        const branch = u.branchId ? branchById.get(String(u.branchId)) : null;
        const company = u.companyId ? companyById.get(String(u.companyId)) : null;
        const companyWide = isCompanyWideRole(u.systemRole);
        return {
          ...mapped,
          roleLabel: ROLE_LABELS[u.systemRole] || mapped.role,
          branchName: companyWide ? 'All branches' : branch?.name || '',
          branchCode: branch?.code || '',
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          isPrivileged: PRIVILEGED_ROLES.has(u.systemRole),
        };
      })
      .sort((a, b) => {
        const ra = ROLE_RANK[a.systemRole] ?? 50;
        const rb = ROLE_RANK[b.systemRole] ?? 50;
        if (ra !== rb) return ra - rb;
        return String(a.name).localeCompare(String(b.name));
      });

    const totals = {
      users: enriched.length,
      active: enriched.filter((u) => u.isActive !== false).length,
      privileged: enriched.filter((u) => u.isPrivileged).length,
      loggedInToday: enriched.filter(
        (u) => u.lastLoginAt && new Date(u.lastLoginAt) >= todayStart,
      ).length,
    };

    return sendSuccess(res, {
      users: enriched,
      totals,
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/users/hr — create HR in actor's company (branch-scoped for branch_head/hr creators)
router.post('/hr', protect, authorize('create_hr'), async (req, res) => {
  try {
    if (!req.user.companyId) {
      return sendError(res, 'No active company on user', 400);
    }

    const { name, email, password, role, dept, branchId } = req.body;

    if (!name || !email || !password) {
      return sendError(res, 'Name, email, and password are required');
    }

    let targetBranchId = toObjectId(branchId) || req.user.branchId;
    if (!canAssignToBranch(req.user, targetBranchId)) {
      return sendError(res, 'HR can only be created in your own branch', 403);
    }
    if (!targetBranchId) {
      return sendError(res, 'branchId is required to create HR');
    }

    const existing = await User.findOne({
      companyId: req.user.companyId,
      email: email.toLowerCase(),
    });
    if (existing) {
      return sendError(res, 'Email already registered in this company');
    }

    const employeeId = await generateEmployeeId(req.user.companyId);

    const user = await User.create({
      employeeId,
      name,
      email,
      password,
      role: role || 'HR Specialist',
      systemRole: 'hr',
      dept: dept || 'Human Resources',
      companyId: req.user.companyId,
      branchId: targetBranchId,
      avatar: '👩‍💼',
      salary: req.body.salary || 5000,
    });

    return sendSuccess(res, { user: sanitizeUser(user) }, 'HR account created', 201);
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
