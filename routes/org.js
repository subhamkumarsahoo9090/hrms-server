const express = require('express');
const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const CompanyMembership = require('../models/CompanyMembership');
const User = require('../models/User');
const CustomRole = require('../models/CustomRole');
const LeaveRequest = require('../models/LeaveRequest');
const JobPosting = require('../models/JobPosting');
const Candidate = require('../models/Candidate');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  isCompanyWideRole,
  isBranchScopedRole,
  isTeamScopedRole,
} = require('../constants/permissions');
const { canAssignToBranch, assertSameCompany, toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, resolveAvatar, buildUserLookupFilter } = require('../utils/helpers');
const {
  teamMemberFilter,
  getUserTeamIdList,
  userBelongsToTeam,
  addUserToTeam,
  removeUserFromTeam,
  setUserPrimaryTeamOnly,
} = require('../utils/teamMembership');

const router = express.Router();

function sanitizeCompany(c) {
  const obj = c.toObject ? c.toObject() : { ...c };
  return {
    id: String(obj._id),
    name: obj.name,
    slug: obj.slug,
    legalName: obj.legalName,
    status: obj.status,
    ownerUserId: obj.ownerUserId ? String(obj.ownerUserId) : null,
    city: obj.city,
    address: obj.address,
    logo: obj.logo,
  };
}

function sanitizeSuperAdmin(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email || '',
    avatar: resolveAvatar(u.avatar, u.name),
    employeeId: u.employeeId || '',
  };
}

async function superAdminsByCompanyId(companyIds) {
  if (!companyIds.length) return new Map();

  const [direct, memberships] = await Promise.all([
    User.find({
      companyId: { $in: companyIds },
      systemRole: 'super_admin',
      isActive: { $ne: false },
    })
      .select('name email avatar employeeId companyId')
      .sort({ name: 1 }),
    CompanyMembership.find({
      companyId: { $in: companyIds },
      systemRole: 'super_admin',
    }).select('userId companyId'),
  ]);

  const extraIds = [
    ...new Set(memberships.map((m) => String(m.userId)).filter(Boolean)),
  ];
  const extraUsers = extraIds.length
    ? await User.find({
        _id: { $in: extraIds.map((id) => toObjectId(id)).filter(Boolean) },
        isActive: { $ne: false },
      }).select('name email avatar employeeId')
    : [];

  const userById = new Map();
  for (const u of [...direct, ...extraUsers]) {
    userById.set(String(u._id), u);
  }

  const byCompany = new Map();
  function add(companyId, user) {
    if (!companyId || !user) return;
    const cid = String(companyId);
    if (!byCompany.has(cid)) byCompany.set(cid, new Map());
    byCompany.get(cid).set(String(user._id), sanitizeSuperAdmin(user));
  }

  for (const u of direct) add(u.companyId, u);
  for (const m of memberships) add(m.companyId, userById.get(String(m.userId)));
  return byCompany;
}

function sanitizeBranch(b) {
  const obj = b.toObject ? b.toObject() : { ...b };
  return {
    id: String(obj._id),
    companyId: String(obj.companyId),
    name: obj.name,
    code: obj.code,
    city: obj.city,
    address: obj.address,
    isHeadOffice: !!obj.isHeadOffice,
    status: obj.status,
  };
}

function sanitizeDepartment(d) {
  const obj = d.toObject ? d.toObject() : { ...d };
  return {
    id: String(obj._id),
    companyId: String(obj.companyId),
    branchId: String(obj.branchId),
    name: obj.name,
    code: obj.code,
    status: obj.status,
  };
}

function sanitizeTeam(t) {
  const obj = t.toObject ? t.toObject() : { ...t };
  return {
    id: String(obj._id),
    companyId: String(obj.companyId),
    branchId: String(obj.branchId),
    departmentId: String(obj.departmentId),
    name: obj.name,
    managerId: obj.managerId ? String(obj.managerId) : null,
    status: obj.status,
  };
}

/** Owner, membership, company-wide role, or same-company branch/team-scoped role */
async function canAccessCompany(actor, companyId) {
  if (!companyId) return false;
  if (String(actor.companyId) === String(companyId)) {
    if (
      isCompanyWideRole(actor.systemRole) ||
      isBranchScopedRole(actor.systemRole) ||
      isTeamScopedRole(actor.systemRole)
    ) {
      return true;
    }
  }
  const owns = await Company.findOne({
    _id: companyId,
    ownerUserId: actor._id,
  });
  if (owns) return true;
  const membership = await CompanyMembership.findOne({
    userId: actor._id,
    companyId,
  });
  return !!membership;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function uniqueCompanySlug(baseName) {
  const base = slugify(baseName) || 'company';
  let slug = base;
  let n = 1;
  while (await Company.exists({ slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

function branchCodeFromCity(city, companyName) {
  const raw = String(city || companyName || 'HQ')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  return raw || 'HQ';
}

async function enrichCompanies(companies) {
  const companyIds = companies.map((c) => c._id);
  const saByCompany = await superAdminsByCompanyId(companyIds);

  return Promise.all(
    companies.map(async (c) => {
      const companyId = c._id;
      const [branchCount, employeeCount] = await Promise.all([
        Branch.countDocuments({ companyId }),
        User.countDocuments({ companyId, isActive: { $ne: false } }),
      ]);
      const superAdmins = [...(saByCompany.get(String(companyId))?.values() || [])];
      return {
        ...sanitizeCompany(c),
        branchCount,
        employeeCount,
        superAdmins,
        superAdmin: superAdmins[0] || null,
      };
    }),
  );
}

/** Companies the current user can access (memberships + owned) */
router.get('/companies', protect, async (req, res) => {
  try {
    const memberships = await CompanyMembership.find({ userId: req.user._id });
    const memberCompanyIds = memberships.map((m) => m.companyId);
    const owned = await Company.find({ ownerUserId: req.user._id });
    const ownedIds = owned.map((c) => c._id);

    const allIds = [...new Set([...memberCompanyIds, ...ownedIds].map(String))];
    const companies = await Company.find({
      _id: { $in: allIds.map((id) => toObjectId(id)).filter(Boolean) },
    }).sort({ name: 1 });

    if (!companies.length && req.user.companyId) {
      const current = await Company.findById(req.user.companyId);
      if (current) companies.push(current);
    }

    const enriched = await enrichCompanies(companies);
    const totals = enriched.reduce(
      (acc, c) => {
        acc.branches += c.branchCount || 0;
        acc.employees += c.employeeCount || 0;
        return acc;
      },
      { branches: 0, employees: 0 },
    );

    return sendSuccess(res, {
      companies: enriched,
      totals: {
        companies: enriched.length,
        branches: totals.branches,
        employees: totals.employees,
      },
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

function mapOrgMember(m) {
  return {
    id: String(m._id),
    employeeId: m.employeeId || '',
    name: m.name,
    role: m.role || '',
    systemRole: m.systemRole || '',
    dept: m.dept || '',
    status: m.status || 'Active',
    email: m.email || '',
    phone: m.phone || '',
    avatar: resolveAvatar(m.avatar, m.name),
  };
}

/** If Team.managerId is empty, use a member whose systemRole is manager. */
async function inferAndPersistTeamManager(team, memberDocs) {
  if (team.managerId) return team.managerId;
  const inferred = (memberDocs || []).find((m) => m.systemRole === 'manager');
  if (!inferred?._id) return null;
  await Team.updateOne(
    { _id: team._id, $or: [{ managerId: null }, { managerId: { $exists: false } }] },
    { $set: { managerId: inferred._id } },
  );
  team.managerId = inferred._id;
  return inferred._id;
}

/**
 * GET /api/org/companies/:id
 * Full company snapshot: branches, departments, super admins, teams + heads + members.
 */
router.get('/companies/:id', protect, async (req, res) => {
  try {
    const companyId = toObjectId(req.params.id);
    if (!companyId) return sendError(res, 'Invalid company id');

    const company = await Company.findById(companyId);
    if (!company) return sendError(res, 'Company not found', 404);

    const allowed = await canAccessCompany(req.user, companyId);
    if (!allowed) return sendError(res, 'You do not have access to this company', 403);

    const branchFilter = { companyId };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      branchFilter._id = req.user.branchId;
    }

    const deptFilter = { companyId };
    const teamFilter = { companyId };
    if (branchFilter._id) {
      deptFilter.branchId = branchFilter._id;
      teamFilter.branchId = branchFilter._id;
    }

    const [branches, departments, teams, saByCompany, employeeCount, owner] = await Promise.all([
      Branch.find(branchFilter).sort({ isHeadOffice: -1, name: 1 }),
      Department.find(deptFilter).sort({ name: 1 }),
      Team.find(teamFilter).sort({ name: 1 }),
      superAdminsByCompanyId([companyId]),
      User.countDocuments({ companyId, isActive: { $ne: false } }),
      company.ownerUserId
        ? User.findById(company.ownerUserId).select('name email avatar employeeId role')
        : null,
    ]);

    const superAdmins = [...(saByCompany.get(String(companyId))?.values() || [])];
    const managerIds = [
      ...new Set(teams.map((t) => (t.managerId ? String(t.managerId) : null)).filter(Boolean)),
    ];

    const [managers, usersInCompany] = await Promise.all([
      managerIds.length
        ? User.find({
            _id: { $in: managerIds.map((id) => toObjectId(id)).filter(Boolean) },
          }).select('name email avatar employeeId role systemRole phone dept status')
        : Promise.resolve([]),
      User.find({
        companyId,
        isActive: { $ne: false },
        ...(branchFilter._id ? { branchId: branchFilter._id } : {}),
      }).select(
        'name email avatar employeeId role systemRole phone dept status branchId departmentId teamId teamIds',
      ),
    ]);

    const managerById = new Map(managers.map((m) => [String(m._id), m]));
    const branchById = new Map(branches.map((b) => [String(b._id), b]));
    const deptById = new Map(departments.map((d) => [String(d._id), d]));

    const branchRows = branches.map((b) => {
      const bid = String(b._id);
      const branchDepts = departments.filter((d) => String(d.branchId) === bid);
      const branchTeams = teams.filter((t) => String(t.branchId) === bid);
      const people = usersInCompany.filter((u) => u.branchId && String(u.branchId) === bid);
      return {
        ...sanitizeBranch(b),
        departmentCount: branchDepts.length,
        teamCount: branchTeams.length,
        employeeCount: people.length,
      };
    });

    const departmentRows = departments.map((d) => {
      const did = String(d._id);
      const branch = branchById.get(String(d.branchId));
      const deptTeams = teams.filter((t) => String(t.departmentId) === did);
      const people = usersInCompany.filter(
        (u) => u.departmentId && String(u.departmentId) === did,
      );
      return {
        ...sanitizeDepartment(d),
        branchName: branch?.name || '',
        branchCode: branch?.code || '',
        teamCount: deptTeams.length,
        employeeCount: people.length,
      };
    });

    const teamRows = await Promise.all(teams.map(async (t) => {
      const tid = String(t._id);
      const members = usersInCompany.filter((u) =>
        getUserTeamIdList(u).some((id) => String(id) === tid),
      );
      await inferAndPersistTeamManager(t, members);
      const manager = t.managerId
        ? managerById.get(String(t.managerId)) ||
          members.find((m) => String(m._id) === String(t.managerId)) ||
          null
        : null;
      const branch = branchById.get(String(t.branchId));
      const dept = deptById.get(String(t.departmentId));
      return {
        ...sanitizeTeam(t),
        departmentName: dept?.name || '',
        branchName: branch?.name || '',
        branchCode: branch?.code || '',
        managerName: manager?.name || '',
        managerEmail: manager?.email || '',
        head: manager ? mapOrgMember(manager) : null,
        memberCount: members.length,
        members: members
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map(mapOrgMember),
      };
    }));

    const [enrichedCompany] = await enrichCompanies([company]);

    return sendSuccess(res, {
      company: {
        ...enrichedCompany,
        departmentCount: departments.length,
        teamCount: teams.length,
        employeeCount,
        superAdmins,
        superAdmin: superAdmins[0] || null,
        owner: owner
          ? {
              id: String(owner._id),
              name: owner.name,
              email: owner.email || '',
              avatar: resolveAvatar(owner.avatar, owner.name),
              employeeId: owner.employeeId || '',
            }
          : null,
      },
      branches: branchRows,
      departments: departmentRows,
      teams: teamRows,
      superAdmins,
      totals: {
        branches: branches.length,
        departments: departments.length,
        teams: teams.length,
        employees: employeeCount,
        superAdmins: superAdmins.length,
        teamMembers: teamRows.reduce((s, t) => s + (t.memberCount || 0), 0),
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * POST /api/org/companies
 * Company Owner onboards another company under the same CEO account.
 * Body: { name, city?, address?, legalName?, branchName?, branchCode? }
 */
router.post('/companies', protect, authorize('manage_companies'), async (req, res) => {
  try {
    const {
      name,
      city = '',
      address = '',
      legalName = '',
      branchName,
      branchCode,
    } = req.body;

    if (!name || !String(name).trim()) {
      return sendError(res, 'Company name is required');
    }

    const companyName = String(name).trim();
    const slug = await uniqueCompanySlug(companyName);

    const company = await Company.create({
      name: companyName,
      slug,
      legalName: String(legalName || companyName).trim(),
      status: 'Active',
      city: String(city || '').trim(),
      address: String(address || '').trim(),
      ownerUserId: req.user._id,
    });

    const hqName = String(branchName || city || 'Head Office').trim() || 'Head Office';
    let code = String(branchCode || branchCodeFromCity(city, companyName)).toUpperCase();
    if (await Branch.exists({ companyId: company._id, code })) {
      code = `${code}1`.slice(0, 8);
    }

    const branch = await Branch.create({
      companyId: company._id,
      name: hqName,
      code,
      city: String(city || '').trim(),
      address: String(address || '').trim(),
      isHeadOffice: true,
      status: 'Active',
    });

    await CompanyMembership.create({
      userId: req.user._id,
      companyId: company._id,
      systemRole: 'company_owner',
      branchId: null,
      isDefault: false,
    });

    for (const deptName of ['IT', 'Sales', 'Finance', 'HR', 'Administration']) {
      await Department.create({
        companyId: company._id,
        branchId: branch._id,
        name: deptName,
        code: deptName.slice(0, 3).toUpperCase(),
      });
    }

    return sendSuccess(
      res,
      {
        company: {
          ...sanitizeCompany(company),
          branchCount: 1,
          employeeCount: 0,
        },
        branch: sanitizeBranch(branch),
      },
      `${companyName} onboarded successfully`,
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Company slug already exists', 409);
    }
    return sendError(res, err.message, 500);
  }
});

/**
 * DELETE /api/org/companies/:id
 * Company Owner only — permanently removes an owned company with no employees.
 */
router.delete('/companies/:id', protect, authorize('manage_companies'), async (req, res) => {
  try {
    const companyId = toObjectId(req.params.id);
    if (!companyId) {
      return sendError(res, 'Invalid company id');
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return sendError(res, 'Company not found', 404);
    }

    const isOwner =
      company.ownerUserId &&
      String(company.ownerUserId) === String(req.user._id);
    const membership = await CompanyMembership.findOne({
      userId: req.user._id,
      companyId,
      systemRole: 'company_owner',
    });

    if (!isOwner && !membership) {
      return sendError(res, 'Forbidden — you do not own this company', 403);
    }

    const employeeCount = await User.countDocuments({
      companyId,
      isActive: { $ne: false },
    });
    if (employeeCount > 0) {
      return sendError(
        res,
        `Cannot delete “${company.name}” while it has ${employeeCount} employee(s). Move or remove them first.`,
        400,
      );
    }

    await Promise.all([
      Team.deleteMany({ companyId }),
      Department.deleteMany({ companyId }),
      Branch.deleteMany({ companyId }),
      CompanyMembership.deleteMany({ companyId }),
      CustomRole.deleteMany({ companyId }),
      LeaveRequest.deleteMany({ companyId }),
      JobPosting.deleteMany({ companyId }),
      Candidate.deleteMany({ companyId }),
    ]);

    await company.deleteOne();

    let switchedCompanyId = null;
    if (req.user.companyId && String(req.user.companyId) === String(companyId)) {
      const nextMembership = await CompanyMembership.findOne({
        userId: req.user._id,
      }).sort({ isDefault: -1, createdAt: 1 });

      const nextCompanyId = nextMembership?.companyId || null;
      const nextBranchId = nextMembership?.branchId || null;
      const nextRole = nextMembership?.systemRole || req.user.systemRole;

      req.user.companyId = nextCompanyId;
      req.user.branchId = nextBranchId;
      if (nextMembership?.systemRole) {
        req.user.systemRole = nextRole;
      }
      await req.user.save();
      switchedCompanyId = nextCompanyId ? String(nextCompanyId) : null;
    }

    return sendSuccess(
      res,
      {
        companyId: String(companyId),
        name: company.name,
        activeCompanyId: switchedCompanyId,
      },
      `${company.name} deleted`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/** Branches — company_owner sees all owned companies; others see active company scope */
router.get('/branches', protect, async (req, res) => {
  try {
    const qCompanyId = toObjectId(req.query.companyId);
    let companyIds = [];

    if (req.user.systemRole === 'company_owner') {
      const memberships = await CompanyMembership.find({ userId: req.user._id });
      const owned = await Company.find({ ownerUserId: req.user._id });
      companyIds = [
        ...new Set([
          ...memberships.map((m) => String(m.companyId)),
          ...owned.map((c) => String(c._id)),
          req.user.companyId ? String(req.user.companyId) : null,
        ].filter(Boolean)),
      ];

      if (qCompanyId) {
        if (!companyIds.includes(String(qCompanyId))) {
          return sendError(res, 'You do not have access to this company', 403);
        }
        companyIds = [String(qCompanyId)];
      }
    } else {
      if (!req.user.companyId) {
        return sendError(res, 'No active company on user', 400);
      }
      companyIds = [String(req.user.companyId)];
    }

    if (!companyIds.length) {
      return sendSuccess(res, {
        branches: [],
        totals: { branches: 0, employees: 0, headOffices: 0 },
      });
    }

    const filter = {
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      filter._id = req.user.branchId;
    }

    const branches = await Branch.find(filter).sort({ isHeadOffice: -1, name: 1 });
    const companies = await Company.find({
      _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    });
    const companyById = new Map(companies.map((c) => [String(c._id), c]));

    const enriched = await Promise.all(
      branches.map(async (b) => {
        const employeeCount = await User.countDocuments({
          branchId: b._id,
          isActive: { $ne: false },
        });
        const company = companyById.get(String(b.companyId));
        return {
          ...sanitizeBranch(b),
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          employeeCount,
        };
      }),
    );

    const totals = {
      branches: enriched.length,
      employees: enriched.reduce((s, b) => s + (b.employeeCount || 0), 0),
      headOffices: enriched.filter((b) => b.isHeadOffice).length,
    };

    return sendSuccess(res, {
      branches: enriched,
      totals,
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * GET /api/org/branches/:id
 * Branch snapshot: departments, branch heads, teams + heads + members.
 */
router.get('/branches/:id', protect, async (req, res) => {
  try {
    const branchId = toObjectId(req.params.id);
    if (!branchId) return sendError(res, 'Invalid branch id');

    const branch = await Branch.findById(branchId);
    if (!branch) return sendError(res, 'Branch not found', 404);

    const allowed = await canAccessCompany(req.user, branch.companyId);
    if (!allowed) {
      return sendError(res, 'You do not have access to this branch', 403);
    }
    if (isBranchScopedRole(req.user.systemRole) && !canAssignToBranch(req.user, branch._id)) {
      return sendError(res, 'You do not have access to this branch', 403);
    }

    const companyId = branch.companyId;
    const [company, departments, teams, usersInBranch] = await Promise.all([
      Company.findById(companyId),
      Department.find({ companyId, branchId }).sort({ name: 1 }),
      Team.find({ companyId, branchId }).sort({ name: 1 }),
      User.find({
        companyId,
        branchId,
        isActive: { $ne: false },
      }).select(
        'name email avatar employeeId role systemRole phone dept status branchId departmentId teamId teamIds',
      ),
    ]);

    const managerIds = [
      ...new Set(teams.map((t) => (t.managerId ? String(t.managerId) : null)).filter(Boolean)),
    ];
    const extraHeadIds = managerIds.filter(
      (id) => !usersInBranch.some((u) => String(u._id) === id),
    );
    const extraHeads = extraHeadIds.length
      ? await User.find({
          _id: { $in: extraHeadIds.map((id) => toObjectId(id)).filter(Boolean) },
        }).select('name email avatar employeeId role systemRole phone dept status')
      : [];

    const peopleById = new Map(
      [...usersInBranch, ...extraHeads].map((u) => [String(u._id), u]),
    );
    const deptById = new Map(departments.map((d) => [String(d._id), d]));

    const branchHeads = usersInBranch
      .filter((u) => u.systemRole === 'branch_head')
      .map(mapOrgMember);
    const hrs = usersInBranch.filter((u) => u.systemRole === 'hr').map(mapOrgMember);

    const departmentRows = departments.map((d) => {
      const did = String(d._id);
      const deptTeams = teams.filter((t) => String(t.departmentId) === did);
      const people = usersInBranch.filter(
        (u) => u.departmentId && String(u.departmentId) === did,
      );
      return {
        ...sanitizeDepartment(d),
        branchName: branch.name,
        branchCode: branch.code,
        teamCount: deptTeams.length,
        employeeCount: people.length,
      };
    });

    const teamRows = await Promise.all(teams.map(async (t) => {
      const tid = String(t._id);
      const members = usersInBranch.filter((u) =>
        getUserTeamIdList(u).some((id) => String(id) === tid),
      );
      await inferAndPersistTeamManager(t, members);
      const manager = t.managerId ? peopleById.get(String(t.managerId)) : null;
      const dept = deptById.get(String(t.departmentId));
      return {
        ...sanitizeTeam(t),
        departmentName: dept?.name || '',
        branchName: branch.name,
        branchCode: branch.code,
        managerName: manager?.name || '',
        managerEmail: manager?.email || '',
        head: manager ? mapOrgMember(manager) : null,
        memberCount: members.length,
        members: members
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map(mapOrgMember),
      };
    }));

    return sendSuccess(res, {
      branch: {
        ...sanitizeBranch(branch),
        companyName: company?.name || '',
        companySlug: company?.slug || '',
        departmentCount: departments.length,
        teamCount: teams.length,
        employeeCount: usersInBranch.length,
      },
      company: company ? sanitizeCompany(company) : null,
      branchHeads,
      hrs,
      departments: departmentRows,
      teams: teamRows,
      totals: {
        departments: departments.length,
        teams: teams.length,
        employees: usersInBranch.length,
        branchHeads: branchHeads.length,
        hrs: hrs.length,
        teamMembers: teamRows.reduce((s, t) => s + (t.memberCount || 0), 0),
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/branches', protect, authorize('create_branch'), async (req, res) => {
  try {
    const { name, code, city, address, isHeadOffice, companyId } = req.body;
    if (!name || !code) {
      return sendError(res, 'name and code are required');
    }

    const targetCompanyId = toObjectId(companyId) || req.user.companyId;
    if (!targetCompanyId) {
      return sendError(res, 'companyId is required');
    }

    if (!assertSameCompany(req.user, targetCompanyId) && req.user.systemRole !== 'company_owner') {
      const owns = await Company.findOne({ _id: targetCompanyId, ownerUserId: req.user._id });
      if (!owns && String(req.user.companyId) !== String(targetCompanyId)) {
        return sendError(res, 'Cannot create branch for another company', 403);
      }
    }

    if (req.user.systemRole === 'company_owner') {
      const owns = await Company.findOne({ _id: targetCompanyId, ownerUserId: req.user._id });
      const member = await CompanyMembership.findOne({
        userId: req.user._id,
        companyId: targetCompanyId,
      });
      if (!owns && !member && String(req.user.companyId) !== String(targetCompanyId)) {
        return sendError(res, 'You do not own this company', 403);
      }
    }

    const makeHeadOffice = !!isHeadOffice;
    if (makeHeadOffice) {
      await Branch.updateMany(
        { companyId: targetCompanyId, isHeadOffice: true },
        { $set: { isHeadOffice: false } },
      );
    }

    const branch = await Branch.create({
      companyId: targetCompanyId,
      name: String(name).trim(),
      code: String(code).toUpperCase().trim(),
      city: city || '',
      address: address || '',
      isHeadOffice: makeHeadOffice,
      status: 'Active',
    });

    for (const deptName of ['IT', 'Sales', 'Finance', 'HR', 'Administration']) {
      const exists = await Department.findOne({
        companyId: targetCompanyId,
        branchId: branch._id,
        name: deptName,
      });
      if (!exists) {
        await Department.create({
          companyId: targetCompanyId,
          branchId: branch._id,
          name: deptName,
          code: deptName.slice(0, 3).toUpperCase(),
        });
      }
    }

    const company = await Company.findById(targetCompanyId);

    return sendSuccess(
      res,
      {
        branch: {
          ...sanitizeBranch(branch),
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          employeeCount: 0,
        },
      },
      'Branch created',
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Branch code already exists in this company');
    }
    return sendError(res, err.message, 500);
  }
});

/** Departments — optional ?companyId= & ?branchId= */
router.get('/departments', protect, async (req, res) => {
  try {
    const qCompanyId = toObjectId(req.query.companyId);
    const qBranch = toObjectId(req.query.branchId);
    let companyIds = [];

    if (req.user.systemRole === 'company_owner') {
      const memberships = await CompanyMembership.find({ userId: req.user._id });
      const owned = await Company.find({ ownerUserId: req.user._id });
      companyIds = [
        ...new Set([
          ...memberships.map((m) => String(m.companyId)),
          ...owned.map((c) => String(c._id)),
          req.user.companyId ? String(req.user.companyId) : null,
        ].filter(Boolean)),
      ];

      if (qCompanyId) {
        if (!companyIds.includes(String(qCompanyId))) {
          return sendError(res, 'You do not have access to this company', 403);
        }
        companyIds = [String(qCompanyId)];
      }
    } else {
      if (!req.user.companyId) {
        return sendError(res, 'No active company on user', 400);
      }
      companyIds = [String(req.user.companyId)];
    }

    if (!companyIds.length) {
      return sendSuccess(res, {
        departments: [],
        totals: { departments: 0, employees: 0, teams: 0 },
      });
    }

    const filter = {
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    };

    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      filter.branchId = req.user.branchId;
    } else if (qBranch) {
      filter.branchId = qBranch;
    }

    const departments = await Department.find(filter).sort({ name: 1 });
    const branchIds = [...new Set(departments.map((d) => String(d.branchId)))];
    const branches = await Branch.find({
      _id: { $in: branchIds.map((id) => toObjectId(id)).filter(Boolean) },
    });
    const companies = await Company.find({
      _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    });
    const branchById = new Map(branches.map((b) => [String(b._id), b]));
    const companyById = new Map(companies.map((c) => [String(c._id), c]));

    const enriched = await Promise.all(
      departments.map(async (d) => {
        const [employeeCount, teamCount] = await Promise.all([
          User.countDocuments({
            $or: [
              { departmentId: d._id },
              // Legacy rows: string dept match while departmentId still null
              {
                departmentId: null,
                companyId: d.companyId,
                branchId: d.branchId,
                dept: new RegExp(
                  `^${String(d.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                  'i',
                ),
              },
            ],
            isActive: { $ne: false },
          }),
          Team.countDocuments({ departmentId: d._id }),
        ]);
        const branch = branchById.get(String(d.branchId));
        const company = companyById.get(String(d.companyId));
        return {
          ...sanitizeDepartment(d),
          branchName: branch?.name || '',
          branchCode: branch?.code || '',
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          employeeCount,
          teamCount,
        };
      }),
    );

    const totals = {
      departments: enriched.length,
      employees: enriched.reduce((s, d) => s + (d.employeeCount || 0), 0),
      teams: enriched.reduce((s, d) => s + (d.teamCount || 0), 0),
    };

    return sendSuccess(res, {
      departments: enriched,
      totals,
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/departments', protect, authorize('create_department'), async (req, res) => {
  try {
    const { name, code, branchId } = req.body;
    if (!name || !branchId) {
      return sendError(res, 'name and branchId are required');
    }

    const branchObjId = toObjectId(branchId);
    if (!branchObjId) {
      return sendError(res, 'Invalid branchId');
    }

    if (isBranchScopedRole(req.user.systemRole) && !canAssignToBranch(req.user, branchObjId)) {
      return sendError(res, 'HR/Branch Head can only create departments in their own branch', 403);
    }

    const branch = await Branch.findById(branchObjId);
    if (!branch) {
      return sendError(res, 'Branch not found', 404);
    }

    const targetCompanyId = branch.companyId;

    if (req.user.systemRole === 'company_owner') {
      const owns = await Company.findOne({ _id: targetCompanyId, ownerUserId: req.user._id });
      const member = await CompanyMembership.findOne({
        userId: req.user._id,
        companyId: targetCompanyId,
      });
      if (!owns && !member && String(req.user.companyId) !== String(targetCompanyId)) {
        return sendError(res, 'You do not own this company', 403);
      }
    } else if (!assertSameCompany(req.user, targetCompanyId)) {
      return sendError(res, 'Cannot create department for another company', 403);
    }

    const department = await Department.create({
      companyId: targetCompanyId,
      branchId: branch._id,
      name: String(name).trim(),
      code: code ? String(code).toUpperCase().trim() : '',
      status: 'Active',
    });

    const company = await Company.findById(targetCompanyId);

    return sendSuccess(
      res,
      {
        department: {
          ...sanitizeDepartment(department),
          branchName: branch.name || '',
          branchCode: branch.code || '',
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          employeeCount: 0,
          teamCount: 0,
        },
      },
      'Department created',
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Department already exists in this branch');
    }
    return sendError(res, err.message, 500);
  }
});

/**
 * GET /api/org/departments/:id
 * Department snapshot: people, teams + heads + members.
 */
router.get('/departments/:id', protect, async (req, res) => {
  try {
    const departmentId = toObjectId(req.params.id);
    if (!departmentId) return sendError(res, 'Invalid department id');

    const department = await Department.findById(departmentId);
    if (!department) return sendError(res, 'Department not found', 404);

    const allowed = await canAccessCompany(req.user, department.companyId);
    if (!allowed) {
      return sendError(res, 'You do not have access to this department', 403);
    }
    if (isBranchScopedRole(req.user.systemRole) && !canAssignToBranch(req.user, department.branchId)) {
      return sendError(res, 'You do not have access to this department', 403);
    }

    const nameRe = new RegExp(
      `^${String(department.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'i',
    );

    const [branch, company, teams, usersInDept] = await Promise.all([
      Branch.findById(department.branchId),
      Company.findById(department.companyId),
      Team.find({ departmentId }).sort({ name: 1 }),
      User.find({
        companyId: department.companyId,
        isActive: { $ne: false },
        $or: [
          { departmentId },
          {
            departmentId: null,
            branchId: department.branchId,
            dept: nameRe,
          },
        ],
      }).select(
        'name email avatar employeeId role systemRole phone dept status branchId departmentId teamId teamIds',
      ),
    ]);

    const managerIds = [
      ...new Set(teams.map((t) => (t.managerId ? String(t.managerId) : null)).filter(Boolean)),
    ];
    const extraHeadIds = managerIds.filter(
      (id) => !usersInDept.some((u) => String(u._id) === id),
    );
    const extraHeads = extraHeadIds.length
      ? await User.find({
          _id: { $in: extraHeadIds.map((id) => toObjectId(id)).filter(Boolean) },
        }).select('name email avatar employeeId role systemRole phone dept status')
      : [];

    const peopleById = new Map(
      [...usersInDept, ...extraHeads].map((u) => [String(u._id), u]),
    );

    const managers = usersInDept.filter((u) => u.systemRole === 'manager').map(mapOrgMember);

    const teamRows = await Promise.all(teams.map(async (t) => {
      const tid = String(t._id);
      const members = usersInDept.filter((u) =>
        getUserTeamIdList(u).some((id) => String(id) === tid),
      );
      await inferAndPersistTeamManager(t, members);
      const manager = t.managerId ? peopleById.get(String(t.managerId)) : null;
      return {
        ...sanitizeTeam(t),
        departmentName: department.name,
        branchName: branch?.name || '',
        branchCode: branch?.code || '',
        managerName: manager?.name || '',
        managerEmail: manager?.email || '',
        head: manager ? mapOrgMember(manager) : null,
        memberCount: members.length,
        members: members
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map(mapOrgMember),
      };
    }));

    return sendSuccess(res, {
      department: {
        ...sanitizeDepartment(department),
        branchName: branch?.name || '',
        branchCode: branch?.code || '',
        companyName: company?.name || '',
        companySlug: company?.slug || '',
        employeeCount: usersInDept.length,
        teamCount: teams.length,
      },
      branch: branch
        ? {
            ...sanitizeBranch(branch),
            companyName: company?.name || '',
            companySlug: company?.slug || '',
          }
        : null,
      company: company ? sanitizeCompany(company) : null,
      managers,
      employees: usersInDept
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(mapOrgMember),
      teams: teamRows,
      totals: {
        teams: teams.length,
        employees: usersInDept.length,
        managers: managers.length,
        teamMembers: teamRows.reduce((s, t) => s + (t.memberCount || 0), 0),
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * DELETE /api/org/departments/:id
 * Same roles as create — blocked while employees or teams remain.
 */
router.delete('/departments/:id', protect, authorize('create_department'), async (req, res) => {
  try {
    const departmentId = toObjectId(req.params.id);
    if (!departmentId) {
      return sendError(res, 'Invalid department id');
    }

    const department = await Department.findById(departmentId);
    if (!department) {
      return sendError(res, 'Department not found', 404);
    }

    if (
      isBranchScopedRole(req.user.systemRole) &&
      !canAssignToBranch(req.user, department.branchId)
    ) {
      return sendError(res, 'You can only delete departments in your own branch', 403);
    }

    if (req.user.systemRole === 'company_owner') {
      const owns = await Company.findOne({
        _id: department.companyId,
        ownerUserId: req.user._id,
      });
      const member = await CompanyMembership.findOne({
        userId: req.user._id,
        companyId: department.companyId,
      });
      if (!owns && !member && String(req.user.companyId) !== String(department.companyId)) {
        return sendError(res, 'You do not own this company', 403);
      }
    } else if (!assertSameCompany(req.user, department.companyId)) {
      return sendError(res, 'Cannot delete department for another company', 403);
    }

    const [employeeCount, teamCount] = await Promise.all([
      User.countDocuments({ departmentId, isActive: { $ne: false } }),
      Team.countDocuments({ departmentId }),
    ]);

    if (employeeCount > 0) {
      return sendError(
        res,
        `Cannot delete “${department.name}” while it has ${employeeCount} employee(s). Reassign them first.`,
        400,
      );
    }
    if (teamCount > 0) {
      return sendError(
        res,
        `Cannot delete “${department.name}” while it has ${teamCount} team(s). Remove teams first.`,
        400,
      );
    }

    await department.deleteOne();

    return sendSuccess(
      res,
      { departmentId: String(departmentId), name: department.name },
      `${department.name} deleted`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/** Teams — optional ?companyId= & ?branchId= & ?departmentId= */
router.get('/teams', protect, async (req, res) => {
  try {
    const qCompanyId = toObjectId(req.query.companyId);
    const qBranch = toObjectId(req.query.branchId);
    const qDept = toObjectId(req.query.departmentId);
    let companyIds = [];

    if (req.user.systemRole === 'company_owner') {
      const memberships = await CompanyMembership.find({ userId: req.user._id });
      const owned = await Company.find({ ownerUserId: req.user._id });
      companyIds = [
        ...new Set([
          ...memberships.map((m) => String(m.companyId)),
          ...owned.map((c) => String(c._id)),
          req.user.companyId ? String(req.user.companyId) : null,
        ].filter(Boolean)),
      ];

      if (qCompanyId) {
        if (!companyIds.includes(String(qCompanyId))) {
          return sendError(res, 'You do not have access to this company', 403);
        }
        companyIds = [String(qCompanyId)];
      }
    } else {
      if (!req.user.companyId) {
        return sendError(res, 'No active company on user', 400);
      }
      companyIds = [String(req.user.companyId)];
    }

    if (!companyIds.length) {
      return sendSuccess(res, {
        teams: [],
        totals: { teams: 0, members: 0, managers: 0 },
      });
    }

    const filter = {
      companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
    };

    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      filter.branchId = req.user.branchId;
    } else if (qBranch) {
      filter.branchId = qBranch;
    }

    if (qDept) filter.departmentId = qDept;

    const teams = await Team.find(filter).sort({ name: 1 });
    const branchIds = [...new Set(teams.map((t) => String(t.branchId)))];
    const deptIds = [...new Set(teams.map((t) => String(t.departmentId)))];
    const managerIds = [
      ...new Set(teams.map((t) => (t.managerId ? String(t.managerId) : null)).filter(Boolean)),
    ];

    const [branches, departments, companies, managers] = await Promise.all([
      Branch.find({ _id: { $in: branchIds.map((id) => toObjectId(id)).filter(Boolean) } }),
      Department.find({ _id: { $in: deptIds.map((id) => toObjectId(id)).filter(Boolean) } }),
      Company.find({ _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } }),
      managerIds.length
        ? User.find({ _id: { $in: managerIds.map((id) => toObjectId(id)).filter(Boolean) } }).select(
            'name email role',
          )
        : Promise.resolve([]),
    ]);

    const branchById = new Map(branches.map((b) => [String(b._id), b]));
    const deptById = new Map(departments.map((d) => [String(d._id), d]));
    const companyById = new Map(companies.map((c) => [String(c._id), c]));
    const managerById = new Map(managers.map((m) => [String(m._id), m]));

    const enriched = await Promise.all(
      teams.map(async (t) => {
        const members = await User.find(
          teamMemberFilter(t._id, { isActive: { $ne: false } }),
        )
          .select('name employeeId role systemRole dept status email avatar teamId teamIds')
          .sort({ name: 1 });

        const branch = branchById.get(String(t.branchId));
        const dept = deptById.get(String(t.departmentId));
        const company = companyById.get(String(t.companyId));
        let manager = t.managerId ? managerById.get(String(t.managerId)) : null;
        if (!manager) {
          const inferredId = await inferAndPersistTeamManager(t, members);
          if (inferredId) {
            manager =
              members.find((m) => String(m._id) === String(inferredId)) ||
              managerById.get(String(inferredId)) ||
              null;
          }
        }

        const memberPayload = members.map((m) => {
          const allTeamIds = getUserTeamIdList(m).map(String);
          const otherTeamIds = allTeamIds.filter((id) => id !== String(t._id));
          const otherTeams = otherTeamIds
            .map((id) => {
              const ot = teams.find((x) => String(x._id) === id);
              return ot
                ? { id: String(ot._id), name: ot.name }
                : null;
            })
            .filter(Boolean);
          return {
            id: String(m._id),
            employeeId: m.employeeId,
            name: m.name,
            role: m.role,
            systemRole: m.systemRole,
            dept: m.dept,
            status: m.status || 'Active',
            email: m.email,
            avatar: resolveAvatar(m.avatar, m.name),
            teamIds: allTeamIds,
            otherTeams,
          };
        });

        return {
          ...sanitizeTeam(t),
          departmentName: dept?.name || '',
          branchName: branch?.name || '',
          branchCode: branch?.code || '',
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          managerName: manager?.name || '',
          managerEmail: manager?.email || '',
          memberCount: memberPayload.length,
          members: memberPayload,
        };
      }),
    );

    const totals = {
      teams: enriched.length,
      members: enriched.reduce((s, t) => s + (t.memberCount || 0), 0),
      managers: enriched.filter((t) => t.managerId).length,
    };

    return sendSuccess(res, {
      teams: enriched,
      totals,
      activeCompanyId: req.user.companyId ? String(req.user.companyId) : null,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * POST /api/org/teams/assign
 * Company Owner adds (or exclusively moves) a user onto a team.
 * Body: { userId, teamId, mode?: 'add' | 'move' }
 * - add (default): user can stay on other teams too
 * - move: replace all memberships with this team only
 */
router.post('/teams/assign', protect, authorize('create_team', 'manage_companies'), async (req, res) => {
  try {
    const teamId = toObjectId(req.body.teamId);
    const mode = req.body.mode === 'move' ? 'move' : 'add';
    if (!req.body.userId || !teamId) {
      return sendError(res, 'userId and teamId are required');
    }

    const [user, team] = await Promise.all([
      User.findOne(buildUserLookupFilter(req.body.userId)),
      Team.findById(teamId),
    ]);

    if (!user || user.isActive === false) {
      return sendError(res, 'User not found', 404);
    }
    if (!team) {
      return sendError(res, 'Team not found', 404);
    }

    const ownsTeamCompany = await canAccessCompany(req.user, team.companyId);
    if (!ownsTeamCompany) {
      return sendError(res, 'You do not own this team’s company', 403);
    }

    if (
      isBranchScopedRole(req.user.systemRole) &&
      !canAssignToBranch(req.user, team.branchId)
    ) {
      return sendError(res, 'You can only manage teams in your own branch', 403);
    }

    if (isTeamScopedRole(req.user.systemRole)) {
      const myTeams = getUserTeamIdList(req.user).map(String);
      const isMgr = team.managerId && String(team.managerId) === String(req.user._id);
      if (!isMgr && !myTeams.includes(String(team._id))) {
        return sendError(res, 'You can only manage your own teams', 403);
      }
    }

    if (user.companyId) {
      const ownsUserCompany = await canAccessCompany(req.user, user.companyId);
      if (!ownsUserCompany) {
        return sendError(res, 'You do not own this user’s company', 403);
      }
    }

    if (mode === 'add' && userBelongsToTeam(user, team._id)) {
      return sendError(res, `${user.name} is already on ${team.name}`, 409);
    }

    const previousTeamIds = getUserTeamIdList(user).map(String);

    if (mode === 'move') {
      // Clear manager link on teams they leave
      const leaving = previousTeamIds.filter((id) => id !== String(team._id));
      if (leaving.length) {
        await Team.updateMany(
          {
            _id: { $in: leaving.map((id) => toObjectId(id)).filter(Boolean) },
            managerId: user._id,
          },
          { $set: { managerId: null } },
        );
      }
      setUserPrimaryTeamOnly(user, team._id);
      // Align home org fields on exclusive move
      const dept = await Department.findById(team.departmentId);
      user.companyId = team.companyId;
      user.branchId = team.branchId;
      user.departmentId = team.departmentId;
      if (dept?.name) user.dept = dept.name;
      if (team.managerId && String(team.managerId) !== String(user._id)) {
        user.managerId = team.managerId;
      }
    } else {
      addUserToTeam(user, team._id);
      if (!user.companyId) user.companyId = team.companyId;
      if (!user.branchId) user.branchId = team.branchId;
    }

    if (!team.managerId && user.systemRole === 'manager') {
      team.managerId = user._id;
      await team.save();
    }

    await user.save();

    const branch = await Branch.findById(team.branchId);
    const dept = await Department.findById(team.departmentId);

    return sendSuccess(
      res,
      {
        user: {
          id: String(user._id),
          name: user.name,
          employeeId: user.employeeId,
          teamId: user.teamId ? String(user.teamId) : null,
          teamIds: getUserTeamIdList(user).map(String),
          teamName: team.name,
          departmentId: team.departmentId ? String(team.departmentId) : null,
          departmentName: dept?.name || '',
          branchId: team.branchId ? String(team.branchId) : null,
          branchName: branch?.name || '',
          companyId: String(team.companyId),
        },
        mode,
        fromTeamIds: previousTeamIds,
        toTeamId: String(team._id),
      },
      mode === 'move'
        ? `${user.name} moved to ${team.name}`
        : `${user.name} added to ${team.name}`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * POST /api/org/teams/remove-member
 * Company Owner removes a user from one team (keeps other team memberships).
 * Body: { userId, teamId }
 */
router.post('/teams/remove-member', protect, authorize('create_team', 'manage_companies'), async (req, res) => {
  try {
    const teamId = toObjectId(req.body.teamId);
    if (!req.body.userId || !teamId) {
      return sendError(res, 'userId and teamId are required');
    }

    const [user, team] = await Promise.all([
      User.findOne(buildUserLookupFilter(req.body.userId)),
      Team.findById(teamId),
    ]);
    if (!user) return sendError(res, 'User not found', 404);
    if (!team) return sendError(res, 'Team not found', 404);

    const owns = await canAccessCompany(req.user, team.companyId);
    if (!owns) {
      return sendError(res, 'You do not own this team’s company', 403);
    }

    if (
      isBranchScopedRole(req.user.systemRole) &&
      !canAssignToBranch(req.user, team.branchId)
    ) {
      return sendError(res, 'You can only manage teams in your own branch', 403);
    }

    if (!userBelongsToTeam(user, teamId)) {
      return sendError(res, `${user.name} is not on ${team.name}`, 400);
    }

    removeUserFromTeam(user, teamId);
    if (team.managerId && String(team.managerId) === String(user._id)) {
      team.managerId = null;
      await team.save();
    }
    await user.save();

    return sendSuccess(
      res,
      {
        userId: String(user._id),
        teamId: String(teamId),
        teamIds: getUserTeamIdList(user).map(String),
      },
      `${user.name} removed from ${team.name}`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.get('/teams/:id/members', protect, async (req, res) => {
  try {
    const teamId = toObjectId(req.params.id);
    if (!teamId) return sendError(res, 'Invalid team id');

    const team = await Team.findById(teamId);
    if (!team) return sendError(res, 'Team not found', 404);

    if (req.user.systemRole === 'company_owner') {
      const owns = await Company.findOne({ _id: team.companyId, ownerUserId: req.user._id });
      const member = await CompanyMembership.findOne({
        userId: req.user._id,
        companyId: team.companyId,
      });
      if (!owns && !member && String(req.user.companyId) !== String(team.companyId)) {
        return sendError(res, 'You do not have access to this team', 403);
      }
    } else if (!assertSameCompany(req.user, team.companyId)) {
      return sendError(res, 'You do not have access to this team', 403);
    }

    if (isBranchScopedRole(req.user.systemRole) && !canAssignToBranch(req.user, team.branchId)) {
      return sendError(res, 'You do not have access to this team', 403);
    }

    const members = await User.find(
      teamMemberFilter(team._id, { isActive: { $ne: false } }),
    ).sort({ name: 1 });

    const branch = await Branch.findById(team.branchId);
    const dept = await Department.findById(team.departmentId);

    return sendSuccess(res, {
      team: {
        ...sanitizeTeam(team),
        departmentName: dept?.name || '',
        branchName: branch?.name || '',
      },
      members: members.map((m) => ({
        id: String(m._id),
        employeeId: m.employeeId,
        name: m.name,
        role: m.role,
        systemRole: m.systemRole,
        dept: m.dept,
        status: m.status || 'Active',
        email: m.email,
        avatar: resolveAvatar(m.avatar, m.name),
        teamIds: getUserTeamIdList(m).map(String),
      })),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

router.post('/teams', protect, authorize('create_team'), async (req, res) => {
  try {
    const { name, departmentId, managerId } = req.body;
    if (!name || !departmentId) {
      return sendError(res, 'name and departmentId are required');
    }

    const deptObjId = toObjectId(departmentId);
    if (!deptObjId) return sendError(res, 'Invalid departmentId');

    const dept = await Department.findById(deptObjId);
    if (!dept) {
      return sendError(res, 'Department not found', 404);
    }

    const targetCompanyId = dept.companyId;

    if (req.user.systemRole === 'company_owner') {
      const owns = await Company.findOne({ _id: targetCompanyId, ownerUserId: req.user._id });
      const member = await CompanyMembership.findOne({
        userId: req.user._id,
        companyId: targetCompanyId,
      });
      if (!owns && !member && String(req.user.companyId) !== String(targetCompanyId)) {
        return sendError(res, 'You do not own this company', 403);
      }
    } else if (!assertSameCompany(req.user, targetCompanyId)) {
      return sendError(res, 'Cannot create team for another company', 403);
    }

    if (isBranchScopedRole(req.user.systemRole) && !canAssignToBranch(req.user, dept.branchId)) {
      return sendError(res, 'HR/Branch Head can only create teams in their own branch', 403);
    }

    if (
      !isCompanyWideRole(req.user.systemRole) &&
      !isBranchScopedRole(req.user.systemRole) &&
      req.user.systemRole === 'manager'
    ) {
      if (!req.user.branchId || String(req.user.branchId) !== String(dept.branchId)) {
        return sendError(res, 'Cannot create team outside your branch', 403);
      }
    }

    let resolvedManagerId = toObjectId(managerId) || null;
    if (resolvedManagerId) {
      const manager = await User.findOne({
        _id: resolvedManagerId,
        companyId: targetCompanyId,
        isActive: { $ne: false },
      });
      if (!manager) {
        return sendError(res, 'Manager not found in this company', 404);
      }
    }

    const team = await Team.create({
      companyId: targetCompanyId,
      branchId: dept.branchId,
      departmentId: dept._id,
      name: String(name).trim(),
      managerId: resolvedManagerId,
      status: 'Active',
    });

    if (resolvedManagerId) {
      const mgrUser = await User.findById(resolvedManagerId);
      if (mgrUser) {
        addUserToTeam(mgrUser, team._id);
        await mgrUser.save();
      }
    }

    const [branch, company, manager] = await Promise.all([
      Branch.findById(dept.branchId),
      Company.findById(targetCompanyId),
      resolvedManagerId ? User.findById(resolvedManagerId).select('name email') : null,
    ]);

    return sendSuccess(
      res,
      {
        team: {
          ...sanitizeTeam(team),
          departmentName: dept.name || '',
          branchName: branch?.name || '',
          branchCode: branch?.code || '',
          companyName: company?.name || '',
          companySlug: company?.slug || '',
          managerName: manager?.name || '',
          managerEmail: manager?.email || '',
          memberCount: 0,
        },
      },
      'Team created',
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Team already exists in this department');
    }
    return sendError(res, err.message, 500);
  }
});

/**
 * PATCH /api/org/teams/:id
 * Set or clear the team head (managerId).
 */
router.patch('/teams/:id', protect, authorize('create_team', 'manage_companies'), async (req, res) => {
  try {
    const teamId = toObjectId(req.params.id);
    if (!teamId) return sendError(res, 'Invalid team id');

    const team = await Team.findById(teamId);
    if (!team) return sendError(res, 'Team not found', 404);

    const ownsTeamCompany = await canAccessCompany(req.user, team.companyId);
    if (!ownsTeamCompany) {
      return sendError(res, 'You do not have access to this team', 403);
    }
    if (isBranchScopedRole(req.user.systemRole) && !canAssignToBranch(req.user, team.branchId)) {
      return sendError(res, 'You can only manage teams in your own branch', 403);
    }

    if (req.body.managerId === null || req.body.managerId === '') {
      team.managerId = null;
    } else if (req.body.managerId) {
      const manager = await User.findOne(buildUserLookupFilter(req.body.managerId));
      if (!manager || manager.isActive === false) {
        return sendError(res, 'Manager not found', 404);
      }
      if (manager.companyId && String(manager.companyId) !== String(team.companyId)) {
        return sendError(res, 'Manager must belong to the same company', 403);
      }
      addUserToTeam(manager, team._id);
      await manager.save();
      team.managerId = manager._id;
    }

    await team.save();
    const mgr = team.managerId
      ? await User.findById(team.managerId).select('name email')
      : null;

    return sendSuccess(res, {
      team: {
        ...sanitizeTeam(team),
        managerName: mgr?.name || '',
        managerEmail: mgr?.email || '',
      },
    }, mgr ? `${mgr.name} is now team manager` : 'Team manager cleared');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * DELETE /api/org/teams/:id
 * Company Owner only.
 * Body (optional): { reassignToTeamId }
 * - If team has members, reassignToTeamId is required — members move there first, then delete.
 * - Empty teams can be deleted without reassignment.
 */
router.delete('/teams/:id', protect, authorize('create_team', 'manage_companies'), async (req, res) => {
  try {
    const teamId = toObjectId(req.params.id);
    if (!teamId) {
      return sendError(res, 'Invalid team id');
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return sendError(res, 'Team not found', 404);
    }

    const owns = await canAccessCompany(req.user, team.companyId);
    if (!owns) {
      return sendError(res, 'Forbidden — you do not own this team’s company', 403);
    }

    if (
      isBranchScopedRole(req.user.systemRole) &&
      !canAssignToBranch(req.user, team.branchId)
    ) {
      return sendError(res, 'You can only manage teams in your own branch', 403);
    }

    const members = await User.find(
      teamMemberFilter(teamId, { isActive: { $ne: false } }),
    );

    let reassignedTo = null;
    let reassignedCount = 0;

    if (members.length > 0) {
      const reassignToTeamId = toObjectId(req.body?.reassignToTeamId);
      if (!reassignToTeamId) {
        return sendError(
          res,
          `This team has ${members.length} member(s). Choose another team to move them to before deleting.`,
          400,
        );
      }
      if (String(reassignToTeamId) === String(teamId)) {
        return sendError(res, 'Choose a different team to move members into', 400);
      }

      const target = await Team.findById(reassignToTeamId);
      if (!target) {
        return sendError(res, 'Destination team not found', 404);
      }

      const ownsTarget = await canAccessCompany(req.user, target.companyId);
      if (!ownsTarget) {
        return sendError(res, 'You do not own the destination team’s company', 403);
      }

      const dept = await Department.findById(target.departmentId);

      for (const user of members) {
        removeUserFromTeam(user, teamId);
        addUserToTeam(user, target._id);
        // Keep home org on destination for primary continuity
        if (!user.teamId || String(user.teamId) === String(teamId)) {
          user.teamId = target._id;
        }
        if (dept?.name && String(user.departmentId) === String(team.departmentId)) {
          user.departmentId = target.departmentId;
          user.dept = dept.name;
          user.branchId = target.branchId;
        }
        await user.save();
      }

      reassignedTo = {
        id: String(target._id),
        name: target.name,
      };
      reassignedCount = members.length;
    }

    // Ensure no leftover memberships on the deleted team
    const leftovers = await User.find(teamMemberFilter(teamId));
    for (const user of leftovers) {
      removeUserFromTeam(user, teamId);
      await user.save();
    }

    const name = team.name;
    await team.deleteOne();

    return sendSuccess(
      res,
      {
        teamId: String(teamId),
        name,
        reassignedCount,
        reassignedTo,
      },
      reassignedCount > 0
        ? `${name} deleted — ${reassignedCount} member(s) moved to ${reassignedTo.name}`
        : `${name} deleted`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/** Full org tree for active company (for create-user pickers) */
router.get('/tree', protect, async (req, res) => {
  try {
    if (!req.user.companyId) {
      return sendError(res, 'No active company on user', 400);
    }

    const branchFilter = { companyId: req.user.companyId };
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      branchFilter._id = req.user.branchId;
    }

    const branches = await Branch.find(branchFilter).sort({ name: 1 });
    const branchIds = branches.map((b) => b._id);
    const departments = await Department.find({
      companyId: req.user.companyId,
      branchId: { $in: branchIds },
    }).sort({ name: 1 });
    const teams = await Team.find({
      companyId: req.user.companyId,
      branchId: { $in: branchIds },
    }).sort({ name: 1 });

    const company = await Company.findById(req.user.companyId);

    return sendSuccess(res, {
      company: company ? sanitizeCompany(company) : null,
      branches: branches.map(sanitizeBranch),
      departments: departments.map(sanitizeDepartment),
      teams: teams.map(sanitizeTeam),
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
