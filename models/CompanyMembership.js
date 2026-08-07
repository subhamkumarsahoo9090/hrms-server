const mongoose = require('mongoose');
const { SYSTEM_ROLES } = require('../constants/permissions');

/**
 * Links a user to a company (CEO can own/access multiple companies).
 * Active context on User.companyId / branchId is switched from these memberships.
 */
const companyMembershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    systemRole: {
      type: String,
      enum: SYSTEM_ROLES,
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
    },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

companyMembershipSchema.index({ userId: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('CompanyMembership', companyMembershipSchema);
