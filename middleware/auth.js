const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendError } = require('../utils/helpers');

async function protect(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 'Not authorized — no token provided', 401);
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'hrcore_dev_secret');
    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
      return sendError(res, 'User not found or deactivated', 401);
    }

    req.user = user;
    next();
  } catch {
    return sendError(res, 'Not authorized — invalid token', 401);
  }
}

module.exports = { protect };
