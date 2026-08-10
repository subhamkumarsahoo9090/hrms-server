const mongoose = require('mongoose');

const breakSessionSchema = new mongoose.Schema(
  {
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },
    durationSeconds: { type: Number, default: 0 },
  },
  { _id: false },
);

const breakLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    /** Current or last session start */
    startTime: { type: String, default: '' },
    /** Last session end */
    endTime: { type: String, default: '' },
    /** Total used today as HH:MM:SS */
    duration: { type: String, default: '' },
    /** not_started | active | available | completed */
    status: { type: String, default: 'not_started' },
    /** Seconds consumed in closed sessions only */
    usedSeconds: { type: Number, default: 0 },
    allowanceSeconds: { type: Number, default: 3600 },
    sessions: { type: [breakSessionSchema], default: [] },
  },
  { timestamps: true },
);

breakLogSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('BreakLog', breakLogSchema);
