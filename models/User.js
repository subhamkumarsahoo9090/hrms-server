const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { SYSTEM_ROLES } = require('../constants/permissions');
const { DEFAULT_SHIFT_START, DEFAULT_SHIFT_END } = require('../constants/shifts');

const userSchema = new mongoose.Schema(
  {
    employeeId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, required: true },
    systemRole: { type: String, enum: SYSTEM_ROLES, required: true },
    /** Display label (kept for backwards compatibility) */
    dept: { type: String, required: true },

    /** Org scope — multi-company / multi-branch */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true,
    },
    /** Primary / home team (backwards compatible) */
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      default: null,
      index: true,
    },
    /** All teams this user belongs to (multi-team) */
    teamIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
      default: [],
      index: true,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    status: { type: String, default: 'Active' },
    avatar: { type: String, default: '👤' },
    lastLoginAt: { type: Date, default: null },
    delayCount: { type: Number, default: 0 },
    salary: { type: Number, default: 0 },
    phone: { type: String, default: '', trim: true },
    shiftStart: { type: String, default: DEFAULT_SHIFT_START },
    shiftEnd: { type: String, default: DEFAULT_SHIFT_END },
    customRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomRole', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/** Unique email + employeeId per company (global unique removed for multi-company SaaS) */
userSchema.index(
  { companyId: 1, email: 1 },
  { unique: true, partialFilterExpression: { companyId: { $type: 'objectId' } } },
);
userSchema.index(
  { companyId: 1, employeeId: 1 },
  { unique: true, partialFilterExpression: { companyId: { $type: 'objectId' } } },
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
