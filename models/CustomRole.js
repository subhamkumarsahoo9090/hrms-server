const mongoose = require('mongoose');

const customRoleSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

customRoleSchema.index(
  { companyId: 1, name: 1 },
  { unique: true, partialFilterExpression: { companyId: { $type: 'objectId' } } },
);

module.exports = mongoose.model('CustomRole', customRoleSchema);
