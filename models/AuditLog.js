const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorName: { type: String, default: 'System' },
    action: { type: String, required: true },
    category: {
      type: String,
      enum: ['config', 'users', 'permissions', 'org', 'payroll', 'leave', 'attendance', 'other'],
      default: 'other',
      index: true,
    },
    entityType: { type: String, default: '' },
    entityId: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
