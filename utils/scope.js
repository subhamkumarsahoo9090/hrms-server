const mongoose = require('mongoose');
const {
  isCompanyWideRole,
  isBranchScopedRole,
  isTeamScopedRole,
  hasPermission,
} = require('../constants/permissions');

/**
 * Mongo filter for listing users visible to the actor.
 * - company_owner / super_admin → whole company
 * - branch_head / hr → own branch only
 * - manager → own team + direct reportees (managerId)
 * - staff → self only
 */
function buildUserScopeFilter(actor) {
  if (!actor?.companyId) {
    return { _id: actor._id };
  }

  const companyId = actor.companyId;
  const base = { companyId };

  if (isCompanyWideRole(actor.systemRole)) {
    return base;
  }

  if (isBranchScopedRole(actor.systemRole)) {
    if (!actor.branchId) {
      return { _id: actor._id };
    }
    return { ...base, branchId: actor.branchId };
  }

  if (isTeamScopedRole(actor.systemRole)) {
    const or = [{ _id: actor._id }];
    if (actor.teamId) {
      or.push({ teamId: actor.teamId });
      or.push({ teamIds: actor.teamId });
    }
    if (Array.isArray(actor.teamIds)) {
      for (const tid of actor.teamIds) {
        or.push({ teamId: tid });
        or.push({ teamIds: tid });
      }
    }
    or.push({ managerId: actor._id });
    return { ...base, $or: or };
  }

  // Staff — self only for directory management; list may still show teammates via separate endpoints
  return { ...base, _id: actor._id };
}

/**
 * Can actor place a new user into targetBranchId?
 * HR / branch_head cannot create for another branch.
 */
function canAssignToBranch(actor, targetBranchId) {
  if (!actor?.companyId) return false;
  if (isCompanyWideRole(actor.systemRole)) return true;

  if (isBranchScopedRole(actor.systemRole)) {
    if (!actor.branchId || !targetBranchId) return false;
    return String(actor.branchId) === String(targetBranchId);
  }

  return false;
}

/**
 * Can actor view/edit this target employee record?
 */
function canAccessEmployee(actor, target) {
  if (!actor || !target) return false;

  // Never allow lower roles to manage company_owner / super_admin above them
  const protectedRoles = ['company_owner'];
  if (protectedRoles.includes(target.systemRole) && actor.systemRole !== 'company_owner') {
    return false;
  }
  if (
    target.systemRole === 'super_admin' &&
    !['company_owner', 'super_admin'].includes(actor.systemRole)
  ) {
    return false;
  }

  if (!actor.companyId || !target.companyId) {
    return String(actor._id) === String(target._id);
  }

  if (String(actor.companyId) !== String(target.companyId)) {
    return false;
  }

  if (isCompanyWideRole(actor.systemRole)) return true;

  if (isBranchScopedRole(actor.systemRole)) {
    return actor.branchId && target.branchId && String(actor.branchId) === String(target.branchId);
  }

  if (isTeamScopedRole(actor.systemRole)) {
    if (String(actor._id) === String(target._id)) return true;
    const actorTeams = new Set();
    if (actor.teamId) actorTeams.add(String(actor.teamId));
    for (const tid of actor.teamIds || []) actorTeams.add(String(tid));
    if (target.teamId && actorTeams.has(String(target.teamId))) return true;
    for (const tid of target.teamIds || []) {
      if (actorTeams.has(String(tid))) return true;
    }
    return target.managerId && String(target.managerId) === String(actor._id);
  }

  return String(actor._id) === String(target._id);
}

function assertSameCompany(actor, companyId) {
  if (!actor?.companyId || !companyId) return false;
  return String(actor.companyId) === String(companyId);
}

function idEquals(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.isObjectIdOrHexString(id)) return new mongoose.Types.ObjectId(id);
  return null;
}

module.exports = {
  buildUserScopeFilter,
  canAssignToBranch,
  canAccessEmployee,
  assertSameCompany,
  idEquals,
  toObjectId,
  hasPermission,
};
