const express = require('express');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const LeaveRequest = require('../models/LeaveRequest');
const SalarySlip = require('../models/SalarySlip');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Team = require('../models/Team');
const SystemSettings = require('../models/SystemSettings');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError } = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');

const router = express.Router();

async function resolveCompanyIds(user) {
  if (user.systemRole === 'company_owner') {
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
  if (user.companyId) return [String(user.companyId)];
  return [];
}

function relativeTime(date) {
  if (!date) return '';
  const diffMs = Date.now() - new Date(date).getTime();
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function mapLog(doc) {
  return {
    id: String(doc._id),
    actor: doc.actorName || 'System',
    actorId: doc.actorId ? String(doc.actorId) : null,
    action: doc.action,
    category: doc.category || 'other',
    entityType: doc.entityType || '',
    entityId: doc.entityId || '',
    time: relativeTime(doc.createdAt),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    companyId: doc.companyId ? String(doc.companyId) : null,
  };
}

/**
 * Build a synthetic feed when AuditLog collection is still empty,
 * so Audit Logs / SA dashboard are useful immediately.
 */
async function synthesizeEvents(companyIds, limit = 40) {
  const ids = companyIds.map((id) => toObjectId(id)).filter(Boolean);
  if (!ids.length) return [];

  const since = new Date();
  since.setDate(since.getDate() - 90);

  const [users, leaves, slips, branches, departments, teams, settings, logins] =
    await Promise.all([
      User.find({
        companyId: { $in: ids },
        createdAt: { $gte: since },
      })
        .select('name employeeId systemRole createdAt companyId')
        .sort({ createdAt: -1 })
        .limit(20),
      LeaveRequest.find({
        companyId: { $in: ids },
        updatedAt: { $gte: since },
        status: { $in: ['Approved', 'Rejected'] },
      })
        .populate('userId', 'name')
        .select('leaveType status updatedAt companyId employeeId')
        .sort({ updatedAt: -1 })
        .limit(15),
      SalarySlip.find({ createdAt: { $gte: since } })
        .populate({
          path: 'userId',
          select: 'name companyId',
          match: { companyId: { $in: ids } },
        })
        .sort({ createdAt: -1 })
        .limit(20),
      Branch.find({ companyId: { $in: ids }, createdAt: { $gte: since } })
        .select('name code createdAt companyId')
        .sort({ createdAt: -1 })
        .limit(10),
      Department.find({ companyId: { $in: ids }, createdAt: { $gte: since } })
        .select('name createdAt companyId')
        .sort({ createdAt: -1 })
        .limit(10),
      Team.find({ companyId: { $in: ids }, createdAt: { $gte: since } })
        .select('name createdAt companyId')
        .sort({ createdAt: -1 })
        .limit(10),
      SystemSettings.find({ updatedAt: { $gte: since } })
        .sort({ updatedAt: -1 })
        .limit(10),
      User.find({
        ...ACTIVE_EMPLOYEE_FILTER,
        companyId: { $in: ids },
        lastLoginAt: { $gte: since },
      })
        .select('name lastLoginAt companyId branchId')
        .sort({ lastLoginAt: -1 })
        .limit(15),
    ]);

  const events = [];

  users.forEach((u) => {
    events.push({
      id: `user-${u._id}`,
      actor: 'System',
      action: `Created user ${u.name}${u.employeeId ? ` (${u.employeeId})` : ''}`,
      category: 'users',
      time: relativeTime(u.createdAt),
      createdAt: u.createdAt?.toISOString?.() || null,
      companyId: u.companyId ? String(u.companyId) : null,
    });
  });

  leaves.forEach((l) => {
    const who = l.userId?.name || l.employeeId || 'employee';
    events.push({
      id: `leave-${l._id}`,
      actor: 'Approver',
      action: `${l.status} ${l.leaveType || 'leave'} for ${who}`,
      category: 'leave',
      time: relativeTime(l.updatedAt),
      createdAt: l.updatedAt?.toISOString?.() || null,
      companyId: l.companyId ? String(l.companyId) : null,
    });
  });

  slips.forEach((s) => {
    if (!s.userId) return;
    events.push({
      id: `slip-${s._id}`,
      actor: 'Payroll',
      action: `Generated payslip for ${s.userId.name} · ${s.month}`,
      category: 'payroll',
      time: relativeTime(s.createdAt),
      createdAt: s.createdAt?.toISOString?.() || null,
      companyId: s.userId.companyId ? String(s.userId.companyId) : null,
    });
  });

  branches.forEach((b) => {
    events.push({
      id: `branch-${b._id}`,
      actor: 'Org',
      action: `Created branch ${b.name} (${b.code})`,
      category: 'org',
      time: relativeTime(b.createdAt),
      createdAt: b.createdAt?.toISOString?.() || null,
      companyId: b.companyId ? String(b.companyId) : null,
    });
  });

  departments.forEach((d) => {
    events.push({
      id: `dept-${d._id}`,
      actor: 'Org',
      action: `Created department ${d.name}`,
      category: 'org',
      time: relativeTime(d.createdAt),
      createdAt: d.createdAt?.toISOString?.() || null,
      companyId: d.companyId ? String(d.companyId) : null,
    });
  });

  teams.forEach((t) => {
    events.push({
      id: `team-${t._id}`,
      actor: 'Org',
      action: `Created team ${t.name}`,
      category: 'org',
      time: relativeTime(t.createdAt),
      createdAt: t.createdAt?.toISOString?.() || null,
      companyId: t.companyId ? String(t.companyId) : null,
    });
  });

  settings.forEach((s) => {
    events.push({
      id: `setting-${s._id}`,
      actor: s.updatedBy || 'Admin',
      action: `Updated setting “${s.key}”`,
      category: 'config',
      time: relativeTime(s.updatedAt),
      createdAt: s.updatedAt?.toISOString?.() || null,
      companyId: null,
    });
  });

  logins.forEach((u) => {
    events.push({
      id: `login-${u._id}-${u.lastLoginAt?.getTime?.() || ''}`,
      actor: u.name,
      action: `${u.name} signed in`,
      category: 'attendance',
      time: relativeTime(u.lastLoginAt),
      createdAt: u.lastLoginAt?.toISOString?.() || null,
      companyId: u.companyId ? String(u.companyId) : null,
    });
  });

  return events
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, limit);
}

// GET /api/audit-logs
router.get('/', protect, authorize('manage_system_settings'), async (req, res) => {
  try {
    const companyIds = await resolveCompanyIds(req.user);
    const category = String(req.query.category || '').trim().toLowerCase();
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const filter = {};
    if (companyIds.length) {
      filter.$or = [
        { companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } },
        { companyId: null },
      ];
    }
    if (category && category !== 'all') {
      filter.category = category;
    }

    let logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit);
    let items = logs.map(mapLog);

    if (!items.length) {
      items = await synthesizeEvents(companyIds, limit);
      if (category && category !== 'all') {
        items = items.filter((i) => i.category === category);
      }
    }

    if (q) {
      items = items.filter(
        (i) =>
          i.action.toLowerCase().includes(q) ||
          (i.actor || '').toLowerCase().includes(q) ||
          (i.category || '').toLowerCase().includes(q),
      );
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const storedRecent = await AuditLog.countDocuments({
      ...filter,
      createdAt: { $gte: thirtyDaysAgo },
    });

    const categoryCounts = {
      config: 0,
      users: 0,
      permissions: 0,
      other: 0,
    };
    items.forEach((i) => {
      if (i.category === 'config') categoryCounts.config += 1;
      else if (i.category === 'users') categoryCounts.users += 1;
      else if (i.category === 'permissions') categoryCounts.permissions += 1;
      else categoryCounts.other += 1;
    });

    const signIns = items
      .filter((i) => i.category === 'attendance' || /signed in/i.test(i.action))
      .slice(0, 12)
      .map((i) => ({
        name: i.actor,
        action: 'signed in',
        branch: '',
        time: i.time,
      }));

    return sendSuccess(res, {
      logs: items,
      activity: signIns,
      totals: {
        events30d: storedRecent || items.length,
        config: categoryCounts.config,
        users: categoryCounts.users,
        permissions: categoryCounts.permissions,
      },
      source: logs.length ? 'audit' : 'synthesized',
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
