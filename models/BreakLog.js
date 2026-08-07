const mongoose = require('mongoose');

const breakLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },
    duration: { type: String, default: '' },
    status: { type: String, default: 'not_started' },
  },
  { timestamps: true }
);

breakLogSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('BreakLog', breakLogSchema);
