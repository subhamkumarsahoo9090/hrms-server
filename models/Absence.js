const mongoose = require('mongoose');

const absenceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    empId: { type: String, required: true },
    name: { type: String, required: true },
    dept: { type: String, required: true },
    reason: { type: String, required: true },
    avatar: { type: String, default: '👤' },
    date: { type: String, required: true },
  },
  { timestamps: true }
);

absenceSchema.index({ empId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Absence', absenceSchema);
