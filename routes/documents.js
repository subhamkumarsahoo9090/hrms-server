const express = require('express');
const EmployeeDocument = require('../models/EmployeeDocument');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanyMembership = require('../models/CompanyMembership');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/authorize');
const { isBranchScopedRole } = require('../constants/permissions');
const { toObjectId } = require('../utils/scope');
const {
  sendSuccess,
  sendError,
  resolveAvatar,
  buildUserLookupFilter,
} = require('../utils/helpers');
const { ACTIVE_EMPLOYEE_FILTER } = require('../utils/absences');

const router = express.Router();

const DOC_TYPES = ['Identity', 'Education', 'Banking', 'Offer', 'Other'];

async function resolveCompanyIds(user) {
  if (user.systemRole === 'company_owner') {
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
  if (user.companyId) return [String(user.companyId)];
  return [];
}

function mapDoc(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    type: doc.type,
    status: doc.status,
    notes: doc.notes || '',
    uploaded:
      doc.createdAt
        ? new Date(doc.createdAt).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })
        : '',
    uploadedAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    employee: doc.userId?.name || 'Employee',
    employeeId: doc.userId?.employeeId || '',
    avatar: resolveAvatar(doc.userId?.avatar, doc.userId?.name),
    userId: doc.userId?._id ? String(doc.userId._id) : String(doc.userId),
    reviewedBy: doc.reviewedBy || '',
  };
}

async function seedDocsIfEmpty(scopeUserIds, actors) {
  const count = await EmployeeDocument.countDocuments({
    userId: { $in: scopeUserIds },
  });
  if (count > 0 || !scopeUserIds.length) return;

  const samples = actors.slice(0, 8);
  const types = ['Identity', 'Education', 'Banking', 'Offer'];
  const docs = [];
  samples.forEach((u, i) => {
    docs.push({
      userId: u._id,
      companyId: u.companyId || null,
      branchId: u.branchId || null,
      name: `${types[i % types.length]} — ${u.name}`,
      type: types[i % types.length],
      status: i % 3 === 0 ? 'Verified' : i % 3 === 1 ? 'Pending' : 'Pending',
      uploadedBy: 'System',
    });
  });
  if (docs.length) await EmployeeDocument.insertMany(docs);
}

// GET /api/documents
router.get(
  '/',
  protect,
  authorize('create_employees', 'edit_employees', 'view_own_payslip'),
  async (req, res) => {
    try {
      const companyIds = await resolveCompanyIds(req.user);
      const userFilter = { ...ACTIVE_EMPLOYEE_FILTER };
      if (companyIds.length) {
        userFilter.companyId = {
          $in: companyIds.map((id) => toObjectId(id)).filter(Boolean),
        };
      }
      if (isBranchScopedRole(req.user.systemRole) && req.user.branchId) {
        userFilter.branchId = req.user.branchId;
      }

      // Employees viewing own docs only
      const isStaffOnly =
        !['company_owner', 'super_admin', 'branch_head', 'hr', 'manager'].includes(
          req.user.systemRole,
        );

      let scopeUsers;
      if (isStaffOnly) {
        scopeUsers = [req.user];
      } else {
        scopeUsers = await User.find(userFilter)
          .select('_id name employeeId avatar companyId branchId')
          .limit(200);
      }

      const scopeIds = scopeUsers.map((u) => u._id);
      if (!isStaffOnly) {
        await seedDocsIfEmpty(scopeIds, scopeUsers);
      }

      const type = String(req.query.type || '').trim();
      const status = String(req.query.status || '').trim();
      const q = String(req.query.q || '').trim().toLowerCase();

      const filter = { userId: { $in: scopeIds } };
      if (type && type !== 'All' && DOC_TYPES.includes(type)) filter.type = type;
      if (status && status !== 'All') filter.status = status;

      let docs = await EmployeeDocument.find(filter)
        .populate('userId', 'name employeeId avatar')
        .sort({ createdAt: -1 })
        .limit(200);

      let mapped = docs.map(mapDoc);
      if (q) {
        mapped = mapped.filter(
          (d) =>
            d.name.toLowerCase().includes(q) ||
            d.employee.toLowerCase().includes(q) ||
            d.type.toLowerCase().includes(q),
        );
      }

      const totals = {
        total: mapped.length,
        verified: mapped.filter((d) => d.status === 'Verified').length,
        pending: mapped.filter((d) => d.status === 'Pending').length,
        rejected: mapped.filter((d) => d.status === 'Rejected').length,
      };

      return sendSuccess(res, {
        documents: mapped,
        totals,
        types: DOC_TYPES,
      });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// POST /api/documents
router.post(
  '/',
  protect,
  authorize('create_employees', 'edit_employees'),
  async (req, res) => {
    try {
      const { userId, name, type, notes } = req.body;
      if (!userId || !name) return sendError(res, 'userId and name are required');

      const user = await User.findOne(buildUserLookupFilter(userId));
      if (!user) return sendError(res, 'Employee not found', 404);

      if (
        isBranchScopedRole(req.user.systemRole) &&
        req.user.branchId &&
        String(user.branchId) !== String(req.user.branchId)
      ) {
        return sendError(res, 'Employee is outside your branch', 403);
      }

      const docType = DOC_TYPES.includes(type) ? type : 'Other';
      const doc = await EmployeeDocument.create({
        userId: user._id,
        companyId: user.companyId || null,
        branchId: user.branchId || null,
        name: String(name).trim(),
        type: docType,
        status: 'Pending',
        notes: notes || '',
        uploadedBy: req.user.name,
      });

      await doc.populate('userId', 'name employeeId avatar');
      return sendSuccess(res, { document: mapDoc(doc) }, 'Document registered', 201);
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

// PATCH /api/documents/:id — verify / reject
router.patch(
  '/:id',
  protect,
  authorize('create_employees', 'edit_employees'),
  async (req, res) => {
    try {
      const doc = await EmployeeDocument.findById(req.params.id).populate(
        'userId',
        'name employeeId avatar branchId',
      );
      if (!doc) return sendError(res, 'Document not found', 404);

      if (
        isBranchScopedRole(req.user.systemRole) &&
        req.user.branchId &&
        doc.userId?.branchId &&
        String(doc.userId.branchId) !== String(req.user.branchId)
      ) {
        return sendError(res, 'Document is outside your branch', 403);
      }

      if (req.body.status) {
        const next = String(req.body.status);
        if (!['Pending', 'Verified', 'Rejected'].includes(next)) {
          return sendError(res, 'Invalid status');
        }
        doc.status = next;
        doc.reviewedBy = req.user.name;
        doc.reviewedAt = new Date();
      }
      if (req.body.notes !== undefined) doc.notes = String(req.body.notes);
      if (req.body.name) doc.name = String(req.body.name).trim();
      if (req.body.type && DOC_TYPES.includes(req.body.type)) doc.type = req.body.type;

      await doc.save();
      return sendSuccess(res, { document: mapDoc(doc) }, 'Document updated');
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  },
);

module.exports = router;
