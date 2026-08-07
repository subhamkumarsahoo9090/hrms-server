const { hasPermission } = require('../constants/permissions');
const { sendError } = require('../utils/helpers');

function authorize(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 'Not authorized', 401);
    }

    const allowed = permissions.some((p) => hasPermission(req.user.systemRole, p));

    if (!allowed) {
      return sendError(res, 'Forbidden — insufficient permissions', 403);
    }

    next();
  };
}

module.exports = { authorize };
