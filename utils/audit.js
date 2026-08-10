const AuditLog = require('../models/AuditLog');

/**
 * Persist an audit event. Failures are swallowed so business flows never break.
 */
async function writeAudit({
  companyId = null,
  actor = null,
  action,
  category = 'other',
  entityType = '',
  entityId = '',
  meta = {},
}) {
  try {
    if (!action) return null;
    return await AuditLog.create({
      companyId: companyId || actor?.companyId || null,
      actorId: actor?._id || null,
      actorName: actor?.name || 'System',
      action: String(action),
      category,
      entityType,
      entityId: entityId ? String(entityId) : '',
      meta,
    });
  } catch (err) {
    console.warn('[audit]', err.message);
    return null;
  }
}

module.exports = { writeAudit };
