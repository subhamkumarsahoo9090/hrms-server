const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    /** Optional — if set, holiday applies only to that branch */
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    /** ISO date YYYY-MM-DD */
    date: { type: String, required: true, index: true },
    optional: { type: Boolean, default: false },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

holidaySchema.index({ companyId: 1, date: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Holiday', holidaySchema);
