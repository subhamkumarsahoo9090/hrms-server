const Team = require('../models/Team');
const User = require('../models/User');
const { STAFF_ROLES } = require('../constants/permissions');
const { getUserTeamIdList } = require('./teamMembership');

const APPROVER_ROLE_LABELS = {
  manager: 'Team Manager',
  hr: 'HR',
  branch_head: 'Branch Head',
  super_admin: 'Super Admin',
  company_owner: 'CEO',
};

/**
 * Approval chain by requester role:
 * Employee → Manager → HR
 * Manager → HR
 * HR → Branch Head
 * Branch Head → Super Admin
 * Super Admin → CEO (company_owner)
 */
function approvalChainForRequester(systemRole) {
  const role = String(systemRole || '');
  if (role === 'company_owner') return [];
  if (role === 'super_admin') return ['company_owner'];
  if (role === 'branch_head') return ['super_admin'];
  if (role === 'hr') return ['branch_head'];
  if (role === 'manager') return ['hr'];
  // staff / employee / custom
  return ['manager', 'hr'];
}

function isStaffRequester(systemRole) {
  return STAFF_ROLES.includes(systemRole) || !APPROVER_ROLE_LABELS[systemRole];
}

function nextApproverRole(chain, currentRole) {
  if (!chain?.length) return null;
  if (!currentRole) return chain[0];
  const idx = chain.indexOf(currentRole);
  if (idx < 0) return chain[0];
  return chain[idx + 1] || null;
}

function workflowLabel() {
  return 'Employee → Team Manager → HR · HR → Branch Head · Branch Head → Super Admin · Super Admin → CEO';
}

async function isTeamManagerOf(actor, employee) {
  if (!actor || !employee) return false;
  if (String(employee.managerId || '') === String(actor._id)) return true;

  const managedTeams = await Team.find({
    managerId: actor._id,
    ...(actor.companyId ? { companyId: actor.companyId } : {}),
  }).select('_id');
  if (!managedTeams.length) return false;

  const managedIds = new Set(managedTeams.map((t) => String(t._id)));
  const empTeams = getUserTeamIdList(employee).map(String);
  return empTeams.some((id) => managedIds.has(id));
}

/**
 * Can this actor act on the leave at its current approval stage?
 */
async function canActOnLeaveStage(actor, leave, requester) {
  if (!actor || !leave) return false;
  if (String(leave.userId) === String(actor._id)) return false; // no self-approve

  const stage = leave.currentApproverRole;
  if (!stage) return false;
  if (actor.systemRole !== stage) return false;

  if (stage === 'manager') {
    return isTeamManagerOf(actor, requester);
  }

  if (stage === 'hr' || stage === 'branch_head') {
    if (actor.branchId && leave.branchId) {
      return String(actor.branchId) === String(leave.branchId);
    }
    if (actor.companyId && leave.companyId) {
      return String(actor.companyId) === String(leave.companyId);
    }
    return true;
  }

  if (stage === 'super_admin') {
    return (
      actor.systemRole === 'super_admin' &&
      String(actor.companyId || '') === String(leave.companyId || '')
    );
  }

  if (stage === 'company_owner') {
    return actor.systemRole === 'company_owner';
  }

  return false;
}

async function ensureLeaveChainFields(leave, requester) {
  const role = requester?.systemRole || leave.requesterRole || 'developer';
  const chain = leave.approvalChain?.length
    ? leave.approvalChain
    : approvalChainForRequester(role);

  let dirty = false;
  if (!leave.requesterRole) {
    leave.requesterRole = role;
    dirty = true;
  }
  if (!leave.approvalChain?.length) {
    leave.approvalChain = chain;
    dirty = true;
  }
  if (leave.status === 'Pending' && !leave.currentApproverRole) {
    leave.currentApproverRole = chain[0] || null;
    dirty = true;
  }
  return dirty;
}

module.exports = {
  APPROVER_ROLE_LABELS,
  approvalChainForRequester,
  isStaffRequester,
  nextApproverRole,
  workflowLabel,
  isTeamManagerOf,
  canActOnLeaveStage,
  ensureLeaveChainFields,
};
