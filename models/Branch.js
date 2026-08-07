const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    city: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    isHeadOffice: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['Active', 'Inactive'],
      default: 'Active',
    },
  },
  { timestamps: true },
);

branchSchema.index({ companyId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Branch', branchSchema);
