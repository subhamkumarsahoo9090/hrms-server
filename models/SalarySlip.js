const mongoose = require('mongoose');

const salarySlipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true },
    basic: { type: Number, required: true },
    allowances: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    pf: { type: Number, default: 0 },
    net: { type: Number, required: true },
  },
  { timestamps: true }
);

salarySlipSchema.index({ userId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('SalarySlip', salarySlipSchema);
