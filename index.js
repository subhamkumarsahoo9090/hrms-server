require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const colors = require('colors');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const employeeRoutes = require('./routes/employees');
const roleRoutes = require('./routes/roles');
const orgRoutes = require('./routes/org');
const attendanceRoutes = require('./routes/attendance');
const breakRoutes = require('./routes/breaks');
const delayRoutes = require('./routes/delays');
const cateringRoutes = require('./routes/catering');
const salaryRoutes = require('./routes/salary');
const communicationsRoutes = require('./routes/communications');
const absenceRoutes = require('./routes/absences');
const leaveRoutes = require('./routes/leave');
const recruitmentRoutes = require('./routes/recruitment');
const reportsRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const dashboardRoutes = require('./routes/dashboard');
const analyticsRoutes = require('./routes/analytics');
const chatRoutes = require('./routes/chat');
const notificationRoutes = require('./routes/notifications');
const performanceRoutes = require('./routes/performance');
const onboardingRoutes = require('./routes/onboarding');
const documentsRoutes = require('./routes/documents');
const taskRoutes = require('./routes/tasks');
const auditRoutes = require('./routes/audit');
const holidayRoutes = require('./routes/holidays');

const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'HR Core API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/breaks', breakRoutes);
app.use('/api/delay-requests', delayRoutes);
app.use('/api/catering', cateringRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/communications', communicationsRoutes);
app.use('/api/absences', absenceRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/recruitment', recruitmentRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/holidays', holidayRoutes);

app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(colors.red(err.stack));
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(colors.green.bold(`\n🚀 HR Core API running on http://localhost:${PORT}`));
  console.log(colors.cyan(`   LAN access:   http://192.168.1.28:${PORT}/api/health`));
  console.log(colors.cyan(`   Health check: http://localhost:${PORT}/api/health\n`));
});

module.exports = app;
