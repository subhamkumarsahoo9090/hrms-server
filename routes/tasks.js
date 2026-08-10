const express = require('express');
const Task = require('../models/Task');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Team = require('../models/Team');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const {
  isBranchScopedRole,
  isTeamScopedRole,
  hasPermission,
} = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const { sendSuccess, sendError, resolveAvatar } = require('../utils/helpers');
const { ATTENDANCE_SCOPE_FILTER } = require('../utils/absences');
const { getUserTeamIdList } = require('../utils/teamMembership');
const { seedTasks } = require('../utils/seedTasks');

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

function taskScopeMeta(user) {
  const canManage = hasPermission(user.systemRole, 'manage_tasks');
  switch (user.systemRole) {
    case 'company_owner':
      return {
        scope: 'company',
        scopeLabel: 'All owned companies',
        isSelfService: false,
        canManage,
      };
    case 'super_admin':
      return {
        scope: 'company',
        scopeLabel: 'Company-wide',
        isSelfService: false,
        canManage,
      };
    case 'branch_head':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch',
        isSelfService: false,
        canManage,
      };
    case 'hr':
      return {
        scope: 'branch',
        scopeLabel: 'Your branch (HR)',
        isSelfService: false,
        canManage,
      };
    case 'manager':
      return {
        scope: 'team',
        scopeLabel: 'Your team',
        isSelfService: false,
        canManage,
      };
    default:
      return {
        scope: 'self',
        scopeLabel: 'Assigned to you',
        isSelfService: true,
        canManage: false,
      };
  }
}

async function resolveTeamMemberIds(user) {
  const teamIds = getUserTeamIdList(user);
  const managed = await Team.find({
    managerId: user._id,
    ...(user.companyId ? { companyId: user.companyId } : {}),
  }).select('_id');
  const allTeamIds = [
    ...new Set([...teamIds.map(String), ...managed.map((t) => String(t._id))]),
  ]
    .map((id) => toObjectId(id))
    .filter(Boolean);

  if (!allTeamIds.length) {
    const reportees = await User.find({
      ...ATTENDANCE_SCOPE_FILTER,
      managerId: user._id,
    }).select('_id');
    return reportees.map((u) => u._id);
  }

  const members = await User.find({
    ...ATTENDANCE_SCOPE_FILTER,
    $or: [
      { teamId: { $in: allTeamIds } },
      { teamIds: { $in: allTeamIds } },
      { managerId: user._id },
    ],
  }).select('_id');
  return members.map((u) => u._id);
}

/** Users this role can assign tasks to (and whose tasks they can see). */
async function resolveAssignableUsers(user) {
  const companyIds = await resolveCompanyIds(user);
  const companyFilter = companyIds.length
    ? { companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } }
    : {};

  if (user.systemRole === 'company_owner' || user.systemRole === 'super_admin') {
    return User.find({ ...ATTENDANCE_SCOPE_FILTER, ...companyFilter })
      .select('_id name employeeId avatar role dept companyId branchId teamId')
      .sort({ name: 1 })
      .limit(500);
  }

  if (isBranchScopedRole(user.systemRole)) {
    const filter = {
      ...ATTENDANCE_SCOPE_FILTER,
      ...companyFilter,
      ...(user.branchId ? { branchId: user.branchId } : {}),
    };
    return User.find(filter)
      .select('_id name employeeId avatar role dept companyId branchId teamId')
      .sort({ name: 1 })
      .limit(300);
  }

  if (isTeamScopedRole(user.systemRole) || user.systemRole === 'manager') {
    const ids = await resolveTeamMemberIds(user);
    return User.find({
      ...ATTENDANCE_SCOPE_FILTER,
      _id: { $in: [...ids, user._id] },
    })
      .select('_id name employeeId avatar role dept companyId branchId teamId')
      .sort({ name: 1 });
  }

  return User.find({ _id: user._id }).select(
    '_id name employeeId avatar role dept companyId branchId teamId',
  );
}

/** Assigners see all tasks in scope; employees see only their assigned tasks. */
async function buildTaskFilter(user) {
  if (!hasPermission(user.systemRole, 'manage_tasks')) {
    return { assigneeId: user._id };
  }

  const assignees = await resolveAssignableUsers(user);
  const ids = assignees.map((u) => u._id);
  // Include tasks they assigned even if assignee left scope
  return {
    $or: [{ assigneeId: { $in: ids } }, { assignerId: user._id }],
  };
}

async function assertAssigneeInScope(actor, assignee) {
  if (!hasPermission(actor.systemRole, 'manage_tasks')) {
    return false;
  }
  const allowed = await resolveAssignableUsers(actor);
  return allowed.some((u) => String(u._id) === String(assignee._id));
}

function mapTask(task) {
  const assignee = task.assigneeId && typeof task.assigneeId === 'object' ? task.assigneeId : null;
  const assigner = task.assignerId && typeof task.assignerId === 'object' ? task.assignerId : null;
  return {
    id: String(task._id),
    title: task.title,
    description: task.description || '',
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate || '',
    due: task.dueDate
      ? new Date(task.dueDate).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : '—',
    assigneeId: assignee?._id ? String(assignee._id) : String(task.assigneeId || ''),
    assignee: assignee?.name || 'Unassigned',
    avatar: resolveAvatar(assignee?.avatar, assignee?.name),
    employeeId: assignee?.employeeId || '',
    assignerId: assigner?._id
      ? String(assigner._id)
      : task.assignerId
        ? String(task.assignerId)
        : null,
    assigner: assigner?.name || '—',
    assignerRole: assigner?.systemRole || assigner?.role || '',
    teamId: task.teamId ? String(task.teamId) : null,
    createdAt: task.createdAt ? new Date(task.createdAt).toISOString() : null,
  };
}

// GET /api/tasks
router.get('/', protect, authorize('view_tasks'), async (req, res) => {
  try {
    const scopeMeta = taskScopeMeta(req.user);
    const filter = await buildTaskFilter(req.user);
    const status = String(req.query.status || '').trim();
    const priority = String(req.query.priority || '').trim();
    const q = String(req.query.q || '').trim().toLowerCase();

    if (status && status !== 'All') filter.status = status;
    if (priority && priority !== 'All') filter.priority = priority;

    let tasks = await Task.find(filter)
      .populate('assigneeId', 'name avatar employeeId')
      .populate('assignerId', 'name systemRole role')
      .sort({ dueDate: 1, createdAt: -1 })
      .limit(400);

    let mapped = tasks.map(mapTask);
    if (q) {
      mapped = mapped.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.assignee.toLowerCase().includes(q) ||
          (t.assigner || '').toLowerCase().includes(q),
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const totals = {
      total: mapped.length,
      completed: mapped.filter((t) => t.status === 'Completed').length,
      inProgress: mapped.filter((t) => t.status === 'In Progress').length,
      pending: mapped.filter((t) => t.status === 'Pending').length,
      overdue: mapped.filter(
        (t) => t.status !== 'Completed' && t.dueDate && t.dueDate < today,
      ).length,
    };

    return sendSuccess(res, {
      tasks: mapped,
      totals,
      byStatus: [
        { label: 'Completed', value: totals.completed },
        { label: 'In Progress', value: totals.inProgress },
        { label: 'Pending', value: totals.pending },
      ],
      byPriority: [
        { label: 'High', value: mapped.filter((t) => t.priority === 'High').length },
        { label: 'Medium', value: mapped.filter((t) => t.priority === 'Medium').length },
        { label: 'Low', value: mapped.filter((t) => t.priority === 'Low').length },
      ],
      canManage: scopeMeta.canManage,
      canCreateOwn: true,
      scope: scopeMeta.scope,
      scopeLabel: scopeMeta.scopeLabel,
      isSelfService: scopeMeta.isSelfService,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// GET /api/tasks/assignees
router.get('/assignees', protect, authorize('manage_tasks', 'create_own_task'), async (req, res) => {
  try {
    const canManage = hasPermission(req.user.systemRole, 'manage_tasks');
    const users = canManage
      ? await resolveAssignableUsers(req.user)
      : await User.find({ _id: req.user._id }).select(
          '_id name employeeId avatar role dept companyId branchId teamId',
        );
    const scopeMeta = taskScopeMeta(req.user);
    return sendSuccess(res, {
      assignees: users.map((u) => ({
        id: String(u._id),
        name: u.name,
        employeeId: u.employeeId,
        role: u.role,
        dept: u.dept,
        avatar: resolveAvatar(u.avatar, u.name),
      })),
      canManage,
      selfOnly: !canManage,
      scope: scopeMeta.scope,
      scopeLabel: canManage ? scopeMeta.scopeLabel : 'Yourself only',
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/tasks/seed — dummy tasks for demo
router.post('/seed', protect, authorize('manage_tasks'), async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const perUser = Math.min(5, Math.max(1, Number(req.body?.perUser) || 2));
    const result = await seedTasks({ force, perUser });
    return sendSuccess(
      res,
      result,
      `Created ${result.created} tasks for ${result.usersScanned} users`,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/tasks — managers assign in scope; anyone can create their own task
router.post('/', protect, authorize('manage_tasks', 'create_own_task'), async (req, res) => {
  try {
    const { title, description, assigneeId, priority, dueDate, teamId } = req.body;
    if (!title) {
      return sendError(res, 'title is required');
    }

    const canManage = hasPermission(req.user.systemRole, 'manage_tasks');
    const requestedId = assigneeId
      ? String(toObjectId(assigneeId) || assigneeId)
      : String(req.user._id);

    // Non-managers may only create tasks for themselves
    if (!canManage && requestedId !== String(req.user._id)) {
      return sendError(res, 'You can only create tasks for yourself', 403);
    }

    const assignee = await User.findById(
      canManage ? toObjectId(assigneeId) || assigneeId || req.user._id : req.user._id,
    );
    if (!assignee || assignee.isActive === false) {
      return sendError(res, 'Assignee not found', 404);
    }

    if (canManage && String(assignee._id) !== String(req.user._id)) {
      const ok = await assertAssigneeInScope(req.user, assignee);
      if (!ok) {
        return sendError(res, 'Can only assign tasks within your role scope', 403);
      }
    }

    const isSelfTask = String(assignee._id) === String(req.user._id);
    const task = await Task.create({
      title: String(title).trim(),
      description:
        description ||
        (isSelfTask && !canManage
          ? 'Self-created (manager/higher authority unavailable).'
          : ''),
      companyId: assignee.companyId || req.user.companyId || null,
      branchId: assignee.branchId || req.user.branchId || null,
      teamId: toObjectId(teamId) || assignee.teamId || null,
      assigneeId: assignee._id,
      assignerId: req.user._id,
      priority: ['High', 'Medium', 'Low'].includes(priority) ? priority : 'Medium',
      status: 'Pending',
      dueDate: dueDate || '',
    });

    await task.populate('assigneeId', 'name avatar employeeId');
    await task.populate('assignerId', 'name systemRole role');
    return sendSuccess(
      res,
      { task: mapTask(task) },
      isSelfTask ? 'Personal task created' : 'Task created',
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', protect, authorize('view_tasks'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return sendError(res, 'Task not found', 404);

    const isAssignee = String(task.assigneeId) === String(req.user._id);
    const canManage = hasPermission(req.user.systemRole, 'manage_tasks');

    if (canManage) {
      const filter = await buildTaskFilter(req.user);
      const inScope = await Task.exists({ _id: task._id, ...filter });
      if (!inScope && !isAssignee) {
        return sendError(res, 'Forbidden', 403);
      }
    } else if (!isAssignee) {
      return sendError(res, 'Forbidden', 403);
    }

    if (req.body.status) {
      const next = String(req.body.status);
      if (!['Pending', 'In Progress', 'Completed'].includes(next)) {
        return sendError(res, 'Invalid status');
      }
      task.status = next;
    }

    if (canManage) {
      if (req.body.priority && ['High', 'Medium', 'Low'].includes(req.body.priority)) {
        task.priority = req.body.priority;
      }
      if (req.body.title) task.title = String(req.body.title).trim();
      if (req.body.description !== undefined) task.description = String(req.body.description);
      if (req.body.dueDate !== undefined) task.dueDate = String(req.body.dueDate);
      if (req.body.assigneeId) {
        const assignee = await User.findById(req.body.assigneeId);
        if (!assignee) return sendError(res, 'Assignee not found', 404);
        const ok = await assertAssigneeInScope(req.user, assignee);
        if (!ok) return sendError(res, 'Assignee outside your scope', 403);
        task.assigneeId = assignee._id;
        task.companyId = assignee.companyId || task.companyId;
        task.branchId = assignee.branchId || task.branchId;
        task.teamId = assignee.teamId || task.teamId;
      }
    }

    await task.save();
    await task.populate('assigneeId', 'name avatar employeeId');
    await task.populate('assignerId', 'name systemRole role');
    return sendSuccess(res, { task: mapTask(task) }, 'Task updated');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', protect, authorize('manage_tasks'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return sendError(res, 'Task not found', 404);

    const filter = await buildTaskFilter(req.user);
    const inScope = await Task.exists({ _id: task._id, ...filter });
    if (!inScope) {
      return sendError(res, 'Forbidden', 403);
    }

    await task.deleteOne();
    return sendSuccess(res, null, 'Task deleted');
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
