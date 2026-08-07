const express = require('express');
const JobPosting = require('../models/JobPosting');
const Candidate = require('../models/Candidate');
const { CANDIDATE_STAGES } = require('../models/Candidate');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const Branch = require('../models/Branch');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { isBranchScopedRole } = require('../constants/permissions');
const { toObjectId, assertSameCompany } = require('../utils/scope');
const { sendSuccess, sendError } = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');

const router = express.Router();

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function resolveOwnerCompanyIds(user) {
  const memberships = await CompanyMembership.find({ userId: user._id });
  const owned = await Company.find({ ownerUserId: user._id });
  return [
    ...new Set([
      ...memberships.map((m) => String(m.companyId)),
      ...owned.map((c) => String(c._id)),
      user.companyId ? String(user.companyId) : null,
    ].filter(Boolean)),
  ];
}

async function resolveCompanyIds(user) {
  if (user.systemRole === 'company_owner') {
    return resolveOwnerCompanyIds(user);
  }
  if (user.companyId) return [String(user.companyId)];
  return [];
}

function companyFilter(companyIds) {
  return {
    companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
  };
}

function formatWhen(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startTomorrow = new Date(startToday);
  startTomorrow.setDate(startTomorrow.getDate() + 1);
  const startDayAfter = new Date(startTomorrow);
  startDayAfter.setDate(startDayAfter.getDate() + 1);
  const time = d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  if (d >= startToday && d < startTomorrow) return `Today · ${time}`;
  if (d >= startTomorrow && d < startDayAfter) return `Tomorrow · ${time}`;
  const day = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  return `${day} · ${time}`;
}

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

async function assertCompanyAccess(actor, companyId) {
  if (actor.systemRole === 'company_owner') {
    const owned = await resolveOwnerCompanyIds(actor);
    return owned.includes(String(companyId));
  }
  return assertSameCompany(actor, companyId);
}

// GET /api/recruitment/overview
router.get('/overview', protect, authorize('manage_recruitment'), async (req, res) => {
  try {
    const companyIds = await resolveCompanyIds(req.user);
    if (!companyIds.length) {
      return sendSuccess(res, {
        summary: {
          openPositions: 0,
          applicants: 0,
          interviewsScheduled: 0,
          offersSent: 0,
        },
        jobs: [],
        pipeline: [],
        interviews: [],
        joineesTrend: [],
        scopeLabel: 'No company',
      });
    }

    const filter = companyFilter(companyIds);
    if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
      filter.$or = [{ branchId: req.user.branchId }, { branchId: null }];
    }

    const [jobs, candidates, companies, branches] = await Promise.all([
      JobPosting.find(filter).sort({ createdAt: -1 }),
      Candidate.find(filter).sort({ interviewAt: 1, createdAt: -1 }),
      Company.find({ _id: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) } }),
      Branch.find({
        companyId: { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) },
      }),
    ]);

    const jobById = new Map(jobs.map((j) => [String(j._id), j]));
    const applicantsByJob = new Map();
    candidates.forEach((c) => {
      const id = String(c.jobId);
      applicantsByJob.set(id, (applicantsByJob.get(id) || 0) + 1);
    });

    const openPositions = jobs.filter((j) => j.status === 'Active').length;
    const applicants = candidates.length;
    const now = new Date();
    const interviewsScheduled = candidates.filter(
      (c) =>
        c.interviewAt &&
        new Date(c.interviewAt) >= now &&
        ['Shortlisted', 'Interviewed', 'Offer'].includes(c.stage),
    ).length;
    const offersSent = candidates.filter(
      (c) => c.stage === 'Offer' || c.offerSentAt || c.stage === 'Hired',
    ).length;

    const stageCounts = {
      Applied: 0,
      Shortlisted: 0,
      Interviewed: 0,
    };
    candidates.forEach((c) => {
      if (c.stage === 'Applied') stageCounts.Applied += 1;
      else if (c.stage === 'Shortlisted') stageCounts.Shortlisted += 1;
      else if (['Interviewed', 'Offer', 'Hired'].includes(c.stage)) {
        stageCounts.Interviewed += 1;
      }
    });

    const pipeline = [
      { label: 'Applied', value: stageCounts.Applied || applicants },
      { label: 'Shortlisted', value: stageCounts.Shortlisted },
      { label: 'Interviewed', value: stageCounts.Interviewed },
    ];
    // If all zero but we have applicants in Applied only, Applied already set
    if (applicants > 0 && stageCounts.Applied === 0 && stageCounts.Shortlisted === 0) {
      pipeline[0].value = applicants;
    }

    const jobsOut = jobs.map((j) => ({
      id: String(j._id),
      title: j.title,
      department: j.department,
      description: j.description || '',
      openings: j.openings,
      status: j.status,
      applicants: applicantsByJob.get(String(j._id)) || 0,
      branchId: j.branchId ? String(j.branchId) : null,
      companyId: String(j.companyId),
      createdAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    }));

    const upcoming = candidates
      .filter((c) => c.interviewAt && new Date(c.interviewAt) >= now)
      .slice(0, 12)
      .map((c) => {
        const job = jobById.get(String(c.jobId));
        return {
          id: String(c._id),
          name: c.name,
          email: c.email,
          role: job?.title || 'Open Role',
          stage: c.interviewStage || c.stage,
          when: formatWhen(c.interviewAt),
          interviewAt: new Date(c.interviewAt).toISOString(),
          avatar: initials(c.name),
          jobId: String(c.jobId),
        };
      });

    // Joinees: hired candidates by month, fallback to new employees
    const joineesTrend = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      const hired = candidates.filter((c) => {
        if (c.stage !== 'Hired') return false;
        const t = c.hiredAt || c.updatedAt;
        if (!t) return false;
        const dt = new Date(t);
        return dt >= start && dt <= end;
      }).length;

      let value = hired;
      if (!value) {
        value = await User.countDocuments({
          ...ACTIVE_EMPLOYEE_FILTER,
          ...companyFilter(companyIds),
          createdAt: { $gte: start, $lte: end },
        });
      }
      joineesTrend.push({ label: MONTH_SHORT[d.getMonth()], value });
    }

    const primaryCompany = companies[0];
    const primaryBranch =
      (req.user.branchId &&
        branches.find((b) => String(b._id) === String(req.user.branchId))) ||
      branches.find((b) => b.isHeadOffice) ||
      branches[0];

    const scopeLabel = [
      req.user.systemRole === 'hr' ? 'HR' : null,
      primaryBranch?.name || primaryCompany?.name || 'Organisation',
    ]
      .filter(Boolean)
      .join(' · ');

    return sendSuccess(res, {
      summary: {
        openPositions,
        applicants,
        interviewsScheduled,
        offersSent,
      },
      jobs: jobsOut,
      pipeline,
      interviews: upcoming,
      joineesTrend,
      stages: CANDIDATE_STAGES,
      scopeLabel,
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/recruitment/jobs
router.post('/jobs', protect, authorize('manage_recruitment'), async (req, res) => {
  try {
    const { title, department, description, openings, branchId, companyId, status } = req.body;
    if (!title || !department) {
      return sendError(res, 'title and department are required');
    }

    let targetCompanyId = toObjectId(companyId) || req.user.companyId;
    if (!targetCompanyId) return sendError(res, 'companyId is required', 400);
    if (!(await assertCompanyAccess(req.user, targetCompanyId))) {
      return sendError(res, 'Forbidden', 403);
    }

    let targetBranchId = toObjectId(branchId) || req.user.branchId || null;
    if (isBranchScopedRole(req.user.systemRole)) {
      targetBranchId = req.user.branchId;
      if (!targetBranchId) return sendError(res, 'branchId is required', 400);
    }

    if (targetBranchId) {
      const branch = await Branch.findOne({ _id: targetBranchId, companyId: targetCompanyId });
      if (!branch) return sendError(res, 'Branch not found in company', 404);
    }

    const job = await JobPosting.create({
      companyId: targetCompanyId,
      branchId: targetBranchId,
      title: String(title).trim(),
      department: String(department).trim(),
      description: description || '',
      openings: Number(openings) > 0 ? Number(openings) : 1,
      status: status === 'Closed' || status === 'On Hold' ? status : 'Active',
      createdBy: req.user._id,
    });

    return sendSuccess(
      res,
      {
        job: {
          id: String(job._id),
          title: job.title,
          department: job.department,
          description: job.description,
          openings: job.openings,
          status: job.status,
          applicants: 0,
          branchId: job.branchId ? String(job.branchId) : null,
          companyId: String(job.companyId),
        },
      },
      'Job posting created',
      201,
    );
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/recruitment/jobs/:id
router.patch('/jobs/:id', protect, authorize('manage_recruitment'), async (req, res) => {
  try {
    const job = await JobPosting.findById(req.params.id);
    if (!job) return sendError(res, 'Job not found', 404);
    if (!(await assertCompanyAccess(req.user, job.companyId))) {
      return sendError(res, 'Forbidden', 403);
    }

    const { title, department, description, openings, status } = req.body;
    if (title !== undefined) job.title = String(title).trim();
    if (department !== undefined) job.department = String(department).trim();
    if (description !== undefined) job.description = description;
    if (openings !== undefined) job.openings = Number(openings) || job.openings;
    if (status && ['Active', 'Closed', 'On Hold'].includes(status)) job.status = status;
    await job.save();

    const applicants = await Candidate.countDocuments({ jobId: job._id });
    return sendSuccess(res, {
      job: {
        id: String(job._id),
        title: job.title,
        department: job.department,
        description: job.description,
        openings: job.openings,
        status: job.status,
        applicants,
        branchId: job.branchId ? String(job.branchId) : null,
        companyId: String(job.companyId),
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

// POST /api/recruitment/candidates
router.post('/candidates', protect, authorize('manage_recruitment'), async (req, res) => {
  try {
    const { jobId, name, email, phone, stage, interviewAt, interviewStage, notes } = req.body;
    if (!jobId || !name || !email) {
      return sendError(res, 'jobId, name and email are required');
    }

    const job = await JobPosting.findById(jobId);
    if (!job) return sendError(res, 'Job not found', 404);
    if (!(await assertCompanyAccess(req.user, job.companyId))) {
      return sendError(res, 'Forbidden', 403);
    }

    const resolvedStage = CANDIDATE_STAGES.includes(stage) ? stage : 'Applied';
    const candidate = await Candidate.create({
      companyId: job.companyId,
      branchId: job.branchId,
      jobId: job._id,
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      phone: phone || '',
      stage: resolvedStage,
      interviewAt: interviewAt ? new Date(interviewAt) : null,
      interviewStage: interviewStage || '',
      notes: notes || '',
      offerSentAt: resolvedStage === 'Offer' ? new Date() : null,
      hiredAt: resolvedStage === 'Hired' ? new Date() : null,
    });

    return sendSuccess(
      res,
      {
        candidate: {
          id: String(candidate._id),
          name: candidate.name,
          email: candidate.email,
          stage: candidate.stage,
          jobId: String(candidate.jobId),
          interviewAt: candidate.interviewAt
            ? new Date(candidate.interviewAt).toISOString()
            : null,
        },
      },
      'Candidate added',
      201,
    );
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 'Candidate already applied to this job');
    }
    return sendError(res, err.message, 500);
  }
});

// PATCH /api/recruitment/candidates/:id
router.patch('/candidates/:id', protect, authorize('manage_recruitment'), async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return sendError(res, 'Candidate not found', 404);
    if (!(await assertCompanyAccess(req.user, candidate.companyId))) {
      return sendError(res, 'Forbidden', 403);
    }

    const { stage, interviewAt, interviewStage, notes, phone } = req.body;
    if (stage && CANDIDATE_STAGES.includes(stage)) {
      candidate.stage = stage;
      if (stage === 'Offer' && !candidate.offerSentAt) candidate.offerSentAt = new Date();
      if (stage === 'Hired' && !candidate.hiredAt) candidate.hiredAt = new Date();
    }
    if (interviewAt !== undefined) {
      candidate.interviewAt = interviewAt ? new Date(interviewAt) : null;
    }
    if (interviewStage !== undefined) candidate.interviewStage = interviewStage;
    if (notes !== undefined) candidate.notes = notes;
    if (phone !== undefined) candidate.phone = phone;
    await candidate.save();

    return sendSuccess(res, {
      candidate: {
        id: String(candidate._id),
        name: candidate.name,
        email: candidate.email,
        stage: candidate.stage,
        jobId: String(candidate.jobId),
        interviewAt: candidate.interviewAt
          ? new Date(candidate.interviewAt).toISOString()
          : null,
      },
    });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
});

module.exports = router;
