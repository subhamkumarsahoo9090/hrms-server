const mongoose = require('mongoose');

const lunchReservationSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    empId: { type: String, required: true },
    name: { type: String, required: true },
    dept: { type: String, required: true },
    selection: { type: String, enum: ['Standard', 'Vegan', 'Opt-Out'], required: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

lunchReservationSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('LunchReservation', lunchReservationSchema);
