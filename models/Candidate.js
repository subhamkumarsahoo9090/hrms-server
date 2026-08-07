const mongoose = require('mongoose');

const CANDIDATE_STAGES = [
  'Applied',
  'Shortlisted',
  'Interviewed',
  'Offer',
  'Hired',
  'Rejected',
];

const candidateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
    },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: '' },
    stage: {
      type: String,
      enum: CANDIDATE_STAGES,
      default: 'Applied',
      index: true,
    },
    interviewAt: { type: Date, default: null },
    interviewStage: { type: String, default: '' },
    notes: { type: String, default: '' },
    offerSentAt: { type: Date, default: null },
    hiredAt: { type: Date, default: null },
  },
  { timestamps: true },
);

candidateSchema.index({ jobId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('Candidate', candidateSchema);
module.exports.CANDIDATE_STAGES = CANDIDATE_STAGES;
