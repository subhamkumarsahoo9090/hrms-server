const mongoose = require('mongoose');

const menuFeedbackSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    employeeName: { type: String, required: true },
    dept: { type: String, required: true },
    liked: { type: Boolean, default: true },
    comment: { type: String, default: '' },
    time: { type: String, default: '' },
    date: { type: String, default: '' },
  },
  { timestamps: true },
);

menuFeedbackSchema.index({ userId: 1, itemId: 1 });

module.exports = mongoose.model('MenuFeedback', menuFeedbackSchema);
