const mongoose = require('mongoose');

const attendanceLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    status: { type: String, default: 'Present' },
    timeIn: { type: String, default: '' },
    timeOut: { type: String, default: '' },
    delayReason: { type: String, default: null },
  },
  { timestamps: true }
);

attendanceLogSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AttendanceLog', attendanceLogSchema);
