const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const CompanyMembership = require('../models/CompanyMembership');
const LeaveRequest = require('../models/LeaveRequest');
const AttendanceLog = require('../models/AttendanceLog');
const SalarySlip = require('../models/SalarySlip');
const Task = require('../models/Task');
const { protect } = require('../middleware/auth');
const { uploadAvatar } = require('../middleware/uploadAvatar');
const { deleteStoredAvatar } = require('../utils/avatar');
const { sendSuccess, sendError, sanitizeUser, resolveAvatar } = require('../utils/helpers');
const { toObjectId } = require('../utils/scope');

const router = express.Router();

const LEAVE_POLICY = [
  { type: 'Casual Leave', allotted: 12 },
  { type: 'Sick Leave', allotted: 10 },
  { type: 'Earned Leave', allotted: 15 },
  { type: 'Comp Off', allotted: 5 },
];

function formatInr(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

async function buildProfilePayload(userDoc) {
  const user = sanitizeUser(userDoc);
  const [
    company,
    branch,
    department,
    team,
    manager,
    companies,
    leaveApproved,
    monthLogs,
    slips,
    openTasks,
    completedTasks,
  ] = await Promise.all([
    userDoc.companyId ? Company.findById(userDoc.companyId).select('name slug city status') : null,
    userDoc.branchId ? Branch.findById(userDoc.branchId).select('name code city') : null,
    userDoc.departmentId
      ? Department.findById(userDoc.departmentId).select('name code')
      : null,
    userDoc.teamId ? Team.findById(userDoc.teamId).select('name status') : null,
    userDoc.managerId
      ? User.findById(userDoc.managerId).select('name role systemRole avatar employeeId')
      : null,
    getAccessibleCompanies(userDoc),
    LeaveRequest.find({
      userId: userDoc._id,
      status: 'Approved',
    }).select('leaveType days'),
    (() => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      const end = now.toISOString().slice(0, 10);
      return AttendanceLog.find({
        userId: userDoc._id,
        date: { $gte: start, $lte: end },
      }).select('timeIn status');
    })(),
    SalarySlip.find({ userId: userDoc._id }).sort({ createdAt: -1 }).limit(1),
    Task.countDocuments({
      assigneeId: userDoc._id,
      status: { $ne: 'Completed' },
    }),
    Task.countDocuments({
      assigneeId: userDoc._id,
      status: 'Completed',
    }),
  ]);

  const usedByType = new Map();
  leaveApproved.forEach((l) => {
    const key = l.leaveType || 'Casual Leave';
    usedByType.set(key, (usedByType.get(key) || 0) + (Number(l.days) || 0));
  });
  const balances = LEAVE_POLICY.map((p) => {
    const used = Math.min(p.allotted, usedByType.get(p.type) || 0);
    return {
      type: p.type,
      allotted: p.allotted,
      used,
      remaining: Math.max(0, p.allotted - used),
    };
  });
  const leaveBalanceDays = balances.reduce((s, b) => s + b.remaining, 0);

  const presentDays = monthLogs.filter(
    (l) => l.timeIn || ['Present', 'Late', 'Remote'].includes(l.status),
  ).length;
  const workingDays = Math.max(1, new Date().getDate());
  const attendanceRate = Math.round((presentDays / workingDays) * 1000) / 10;

  const lastSlip = slips[0] || null;

  return {
    user,
    company: company
      ? {
          id: String(company._id),
          name: company.name,
          slug: company.slug,
          city: company.city || '',
          status: company.status || 'Active',
        }
      : null,
    branch: branch
      ? {
          id: String(branch._id),
          name: branch.name,
          code: branch.code || '',
          city: branch.city || '',
        }
      : null,
    department: department
      ? {
          id: String(department._id),
          name: department.name,
          code: department.code || '',
        }
      : null,
    team: team
      ? {
          id: String(team._id),
          name: team.name,
          status: team.status || 'Active',
        }
      : null,
    manager: manager
      ? {
          id: String(manager._id),
          name: manager.name,
          role: manager.role || manager.systemRole,
          employeeId: manager.employeeId,
          avatar: resolveAvatar(manager.avatar, manager.name),
        }
      : null,
    companies,
    stats: {
      leaveBalanceDays,
      leaveBalanceLabel: `${leaveBalanceDays} Days`,
      leaveBalances: balances,
      attendanceRate,
      attendanceRateLabel: `${attendanceRate}%`,
      presentDaysMtd: presentDays,
      lastPayslipNet: lastSlip ? Number(lastSlip.net) || 0 : 0,
      lastPayslipLabel: lastSlip ? formatInr(lastSlip.net) : '—',
      lastPayslipMonth: lastSlip?.month || null,
      openTasks,
      completedTasks,
      salaryLabel: formatInr(user.salary || 0),
    },
  };
}

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET || 'hrcore_dev_secret', {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
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

async function getAccessibleCompanies(user) {
  const memberships = await CompanyMembership.find({ userId: user._id });
  const ids = new Set(memberships.map((m) => String(m.companyId)));
  const owned = await Company.find({ ownerUserId: user._id });
  owned.forEach((c) => ids.add(String(c._id)));
  if (user.companyId) ids.add(String(user.companyId));

  const companies = await Company.find({
    _id: { $in: [...ids].map((id) => toObjectId(id)).filter(Boolean) },
  }).sort({ name: 1 });

  return companies.map((c) => ({
    id: String(c._id),
    name: c.name,
    slug: c.slug,
    city: c.city,
    status: c.status,
  }));
}

async function authPayload(user) {
  return {
    token: signToken(user._id),
    user: sanitizeUser(user),
    companies: await getAccessibleCompanies(user),
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 'Email and password are required');
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return sendError(res, 'Invalid email or password', 401);
    }

    if (!user.isActive) {
      return sendError(res, 'Your account has been deactivated. Contact HR.', 403);
    }

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    return sendSuccess(res, await authPayload(user), 'Login successful');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * POST /api/auth/signup
 * Public SaaS onboarding — creates Company Owner + first company + HQ branch.
 * Body: {
 *   name, email, password,
 *   companyName, companyCity?, companyAddress?,
 *   branchName?, branchCode?
 * }
 */
router.post('/signup', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      companyName,
      companyCity = '',
      companyAddress = '',
      branchName,
      branchCode,
    } = req.body;

    if (!name || !email || !password || !companyName) {
      return sendError(res, 'Name, email, password and company name are required');
    }

    if (String(password).length < 6) {
      return sendError(res, 'Password must be at least 6 characters');
    }

    const emailNorm = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: emailNorm });
    if (existing) {
      return sendError(res, 'An account with this email already exists', 409);
    }

    const slug = await uniqueCompanySlug(companyName);
    const company = await Company.create({
      name: String(companyName).trim(),
      slug,
      legalName: String(companyName).trim(),
      status: 'Active',
      city: String(companyCity || '').trim(),
      address: String(companyAddress || '').trim(),
    });

    const hqName = String(branchName || companyCity || 'Head Office').trim() || 'Head Office';
    let code = String(branchCode || branchCodeFromCity(companyCity, companyName)).toUpperCase();
    if (await Branch.exists({ companyId: company._id, code })) {
      code = `${code}1`.slice(0, 8);
    }

    const branch = await Branch.create({
      companyId: company._id,
      name: hqName,
      code,
      city: String(companyCity || '').trim(),
      address: String(companyAddress || '').trim(),
      isHeadOffice: true,
      status: 'Active',
    });

    const owner = await User.create({
      employeeId: 'OWN001',
      name: String(name).trim(),
      email: emailNorm,
      password: String(password),
      role: 'Company Owner',
      systemRole: 'company_owner',
      dept: 'Administration',
      companyId: company._id,
      branchId: branch._id,
      status: 'Active',
      avatar: '🏢',
      isActive: true,
    });

    company.ownerUserId = owner._id;
    await company.save();

    await CompanyMembership.create({
      userId: owner._id,
      companyId: company._id,
      systemRole: 'company_owner',
      branchId: null,
      isDefault: true,
    });

    return sendSuccess(
      res,
      {
        ...(await authPayload(owner)),
        company: {
          id: String(company._id),
          name: company.name,
          slug: company.slug,
          city: company.city,
        },
        branch: {
          id: String(branch._id),
          name: branch.name,
          code: branch.code,
        },
      },
      'Company Owner account created',
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Email or company slug already exists', 409);
    }
    return sendError(res, err.message, 500);
  }
});

// POST /api/auth/biometric
router.post('/biometric', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return sendError(res, 'Email is required for biometric login');
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return sendError(res, 'User not found', 404);
    }

    if (!user.isActive) {
      return sendError(res, 'Your account has been deactivated. Contact HR.', 403);
    }

    return sendSuccess(res, await authPayload(user), 'Biometric login successful');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  return sendSuccess(res, {
    user: sanitizeUser(req.user),
    companies: await getAccessibleCompanies(req.user),
  });
});

// GET /api/auth/profile — full dynamic profile for the logged-in user
router.get('/profile', protect, async (req, res) => {
  try {
    const fresh = await User.findById(req.user._id);
    if (!fresh) return sendError(res, 'User not found', 404);
    return sendSuccess(res, await buildProfilePayload(fresh));
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/auth/profile — self-service update (name, phone)
router.patch('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return sendError(res, 'User not found', 404);

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (name.length < 2) {
        return sendError(res, 'Name must be at least 2 characters');
      }
      user.name = name;
    }

    if (req.body.phone !== undefined) {
      user.phone = String(req.body.phone || '').trim().slice(0, 20);
    }

    await user.save();
    return sendSuccess(res, await buildProfilePayload(user), 'Profile updated');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

/**
 * POST /api/auth/switch-company
 * CEO (company_owner) switches active company context.
 * Body: { companyId }
 */
router.post('/switch-company', protect, async (req, res) => {
  try {
    const companyId = toObjectId(req.body.companyId);
    if (!companyId) {
      return sendError(res, 'companyId is required');
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return sendError(res, 'Company not found', 404);
    }

    const membership = await CompanyMembership.findOne({
      userId: req.user._id,
      companyId,
    });
    const isOwner = company.ownerUserId && String(company.ownerUserId) === String(req.user._id);

    if (!membership && !isOwner) {
      return sendError(res, 'You do not have access to this company', 403);
    }

    req.user.companyId = companyId;
    req.user.systemRole = membership?.systemRole || (isOwner ? 'company_owner' : req.user.systemRole);
    req.user.branchId = membership?.branchId || null;
    req.user.departmentId = null;
    req.user.teamId = null;
    if (isOwner && !membership) {
      req.user.systemRole = 'company_owner';
      req.user.role = 'Company Owner';
    }
    await req.user.save();

    return sendSuccess(
      res,
      await authPayload(req.user),
      `Switched to ${company.name}`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/auth/profile/avatar — any logged-in user uploads their own photo
router.post('/profile/avatar', protect, (req, res) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) {
      return sendError(res, err.message || 'Upload failed', 400);
    }

    if (!req.file) {
      return sendError(res, 'No image file provided');
    }

    try {
      const previousAvatar = req.user.avatar;
      const avatarPath = `/uploads/avatars/${req.file.filename}`;

      req.user.avatar = avatarPath;
      await req.user.save();

      deleteStoredAvatar(previousAvatar);

      const fresh = await User.findById(req.user._id);
      return sendSuccess(
        res,
        await buildProfilePayload(fresh || req.user),
        'Profile photo updated',
      );
    } catch (saveErr) {
      return sendError(res, saveErr.message, 500);
    }
  });
});

// POST /api/auth/logout
router.post('/logout', protect, async (_req, res) => {
  return sendSuccess(res, null, 'Logged out successfully');
});

/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 */
router.post('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return sendError(res, 'Current password and new password are required');
    }
    if (String(newPassword).length < 6) {
      return sendError(res, 'New password must be at least 6 characters');
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user || !(await user.comparePassword(currentPassword))) {
      return sendError(res, 'Current password is incorrect', 401);
    }

    user.password = String(newPassword);
    await user.save();

    return sendSuccess(res, null, 'Password updated successfully');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
