const mongoose = require('mongoose');

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    legalName: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['Active', 'Inactive', 'Suspended'],
      default: 'Active',
    },
    /** CEO / Company Owner user */
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    city: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    logo: { type: String, default: '' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Company', companySchema);
