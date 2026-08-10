const mongoose = require('mongoose');

function toId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch {
    return null;
  }
}

function uniqueObjectIds(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = toId(raw);
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Mongo filter: user is a member of this team (primary or multi). */
function teamMemberFilter(teamId, extra = {}) {
  const id = toId(teamId);
  return {
    ...extra,
    $or: [{ teamId: id }, { teamIds: id }],
  };
}

function getUserTeamIdList(user) {
  const list = [];
  if (user?.teamId) list.push(user.teamId);
  if (Array.isArray(user?.teamIds)) list.push(...user.teamIds);
  return uniqueObjectIds(list);
}

function userBelongsToTeam(user, teamId) {
  const key = String(teamId);
  return getUserTeamIdList(user).some((id) => String(id) === key);
}

/**
 * Add team to user's memberships. Does not remove other teams.
 * Sets primary teamId only when missing.
 */
function addUserToTeam(user, teamId) {
  const id = toId(teamId);
  if (!id) return false;
  const next = getUserTeamIdList(user);
  const already = next.some((x) => String(x) === String(id));
  if (!already) next.push(id);
  user.teamIds = next;
  if (!user.teamId) user.teamId = id;
  return !already;
}

/**
 * Remove team from memberships. Repoints primary teamId if needed.
 */
function removeUserFromTeam(user, teamId) {
  const key = String(teamId);
  const next = getUserTeamIdList(user).filter((id) => String(id) !== key);
  user.teamIds = next;
  if (user.teamId && String(user.teamId) === key) {
    user.teamId = next[0] || null;
  }
  return true;
}

/**
 * Replace all team memberships with a single team (exclusive move).
 */
function setUserPrimaryTeamOnly(user, teamId) {
  const id = toId(teamId);
  user.teamId = id;
  user.teamIds = id ? [id] : [];
}

module.exports = {
  teamMemberFilter,
  getUserTeamIdList,
  userBelongsToTeam,
  addUserToTeam,
  removeUserFromTeam,
  setUserPrimaryTeamOnly,
  uniqueObjectIds,
};
