const mongoose = require('mongoose');

const delayRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    empName: { type: String, required: true },
    dept: { type: String, required: true },
    requestedTime: { type: String, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DelayRequest', delayRequestSchema);
