# HR Core — HR Management Platform

**HR Core** is a full-stack Human Resources management platform consisting of a React Native mobile app and a Node.js REST API backend. It covers attendance tracking, lunch catering, payroll, employee directory, internal communications, and role-based access control.

> *Transforming Knowledge into Wealth.*

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Getting Started](#getting-started)
6. [Role Hierarchy & Permissions](#role-hierarchy--permissions)
7. [API Reference](#api-reference)
8. [Database Schema](#database-schema)
9. [Mobile App Screens](#mobile-app-screens)
10. [Environment Variables](#environment-variables)

---

## Project Overview

| Component | Path | Description |
|-----------|------|-------------|
| **Mobile App** | `hrmanage/` | React Native 0.86 app with dark-themed UI, 5 main tabs, role-based dashboards |
| **Backend API** | `backend/` | Express 5 + MongoDB REST API with JWT auth and RBAC middleware |
| **Database** | MongoDB | Document store for users, attendance, payroll, catering, etc. |

The mobile app currently uses in-memory mock data via `AppContext.tsx`. The backend mirrors every feature in the UI and is ready to be wired up with `fetch`/`axios` calls.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Native Mobile App                      │
│                        (hrmanage/)                               │
│  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ │
│  │   Home   │ │ Attendance │ │ Catering │ │ Salary │ │  Team  │ │
│  └────┬─────┘ └─────┬──────┘ └────┬─────┘ └───┬────┘ └───┬────┘ │
│       │             │             │           │          │       │
│       └─────────────┴─────────────┴───────────┴──────────┘       │
│                              │                                    │
│                    AppContext.tsx (State)                         │
│                    permissions/index.ts (RBAC)                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │  HTTP / REST (JWT Bearer)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Express 5 API Server                         │
│                        (backend/)                                │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────────────────┐ │
│  │  Routes  │→ │ Middleware │→ │  Controllers / Route Handlers│ │
│  └──────────┘  │ auth + RBAC│  └─────────────────────────────┘ │
│                └────────────┘                                     │
│                              │                                    │
│                    Mongoose ODM (Models)                          │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │      MongoDB         │
                    │   (hrcore database)  │
                    └─────────────────────┘
```

### Request Flow

1. User logs in via mobile app → `POST /api/auth/login`
2. Server validates credentials, returns JWT token + user profile
3. App stores token and sends `Authorization: Bearer <token>` on every request
4. `protect` middleware verifies JWT and attaches `req.user`
5. `authorize(permission)` middleware checks role against permission matrix
6. Route handler reads/writes MongoDB and returns `{ success, data, message }`

### Authentication

- **JWT** tokens (default 7-day expiry)
- **bcrypt** password hashing (12 rounds)
- **Biometric login** stub: `POST /api/auth/biometric` (email-only, for demo)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile | React Native 0.86, TypeScript, React Context |
| Backend | Node.js, Express 5, Mongoose 9 |
| Database | MongoDB |
| Auth | JSON Web Tokens, bcryptjs |
| Dev Tools | morgan (logging), cors, dotenv, colors |

---

## Project Structure

```
HRMANAGEMENT/
├── README.md                    ← This file
├── backend/
│   ├── index.js                 ← Server entry point
│   ├── package.json
│   ├── .env.example
│   ├── config/
│   │   └── db.js                ← MongoDB connection
│   ├── constants/
│   │   └── permissions.js       ← Role-permission matrix (mirrors mobile app)
│   ├── middleware/
│   │   ├── auth.js              ← JWT verification
│   │   └── authorize.js         ← Permission gate
│   ├── models/                  ← Mongoose schemas (12 collections)
│   ├── routes/                  ← REST route handlers (11 modules)
│   └── utils/
│       ├── helpers.js
│       └── seed.js              ← Demo data seeder
│
└── hrmanage/                    ← React Native mobile app
    ├── App.tsx
    └── src/
        ├── context/AppContext.tsx
        ├── data/mockData.ts
        ├── permissions/index.ts
        ├── types/index.ts
        ├── screens/               ← 7 screens
        ├── components/          ← 15+ UI components
        └── theme/
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- MongoDB 6+ (local or Atlas)
- React Native dev environment (for mobile app)

### Backend Setup

```bash
cd backend
cp .env.example .env          # Edit MONGODB_URI and JWT_SECRET
npm install
npm run seed                  # Populate demo data
npm run dev                   # Start with hot reload
```

Server runs at **http://localhost:5000**

Health check: `GET http://localhost:5000/api/health`

### Demo Login Credentials

All seeded users share password: **`password123`**

| Role | Email |
|------|-------|
| Super Admin | admin@hrcore.com |
| HR Lead | sarah.connor@hrcore.com |
| HR Recruiter | robert.vance@hrcore.com |
| Manager | emily.blunt@hrcore.com |
| Developer | john.doe@hrcore.com |
| Designer | alice.smith@hrcore.com |
| Sales | michael.chen@hrcore.com |
| Accountant | priya.sharma@hrcore.com |

### Mobile App Setup

```bash
cd hrmanage
npm install
npx react-native run-android    # or run-ios
```

**Important:** Start the backend server before launching the app. The mobile app connects to:

| Platform | API URL |
|----------|---------|
| Android emulator | `http://10.0.2.2:5000/api` |
| iOS simulator | `http://localhost:5000/api` |
| Physical device | Set your PC's LAN IP in `hrmanage/src/config/api.ts` |

On login, pick a role tab to auto-fill the demo email, then sign in with password `password123`. JWT tokens are persisted via AsyncStorage for session restore.

---

## Role Hierarchy & Permissions

### Role Hierarchy

```
Super Admin
└── HR
    ├── Manager
    ├── Developer
    ├── Sales Person
    ├── Designer
    ├── Accountant
    ├── Marketing
    └── Custom Roles (created by Super Admin / HR)
```

### System Roles

| Role Key | Display Label | Category |
|----------|---------------|----------|
| `super_admin` | Super Admin | Admin |
| `hr` | HR | Admin |
| `manager` | Manager | Management |
| `developer` | Developer | Staff |
| `sales` | Sales Person | Staff |
| `designer` | Designer | Staff |
| `accountant` | Accountant | Staff |
| `marketing` | Marketing | Staff |
| `custom` | Custom Role | Staff (user-defined) |

---

### Who Can Do What — Complete Permission Matrix

| Permission | Super Admin | HR | Manager | Staff* | Description |
|------------|:-----------:|:--:|:-------:|:------:|-------------|
| `create_hr` | ✅ | ❌ | ❌ | ❌ | Create HR user accounts |
| `create_roles` | ✅ | ✅ | ❌ | ❌ | Define custom job roles |
| `create_employees` | ✅ | ✅ | ❌ | ❌ | Register new employees |
| `edit_employees` | ✅ | ✅ | ❌ | ❌ | Edit employee details & salary |
| `delete_employees` | ✅ | ✅ | ❌ | ❌ | Deactivate/remove employees |
| `manage_salary` | ✅ | ✅ | ❌ | ❌ | View org-wide salary data |
| `generate_payslip` | ✅ | ✅ | ❌ | ❌ | Batch-generate payslips |
| `view_own_payslip` | ✅ | ✅ | ✅ | ✅ | View & download own payslips |
| `view_all_attendance` | ✅ | ✅ | ✅ | ❌ | See org-wide attendance today |
| `view_team_attendance` | ✅ | ✅ | ✅ | ❌ | Approve/reject delay requests |
| `clock_in` | ✅ | ✅ | ✅ | ✅ | Check in for the day |
| `clock_out` | ✅ | ✅ | ✅ | ✅ | Check out for the day |
| `break_in_out` | ✅ | ✅ | ✅ | ✅ | Start/end 1-hour daily break |
| `manage_messages` | ✅ | ✅ | ❌ | ❌ | Broadcast messages to all staff |
| `view_messages` | ✅ | ✅ | ✅ | ❌ | Read internal messages |
| `view_emails` | ✅ | ✅ | ✅ | ❌ | Read system emails |
| `view_absent_users` | ✅ | ✅ | ✅ | ✅ | See who is absent today |
| `manage_system_settings` | ✅ | ❌ | ❌ | ❌ | Configure global system settings |
| `manage_catering` | ❌ | ✅ | ❌ | ❌ | Edit lunch menu & view analytics |

\*Staff = developer, sales, designer, accountant, marketing, custom

---

### Role-Specific Capabilities

#### Super Admin 🛡️

The highest privilege level. Controls the entire platform.

| Can Do | Cannot Do |
|--------|-----------|
| Create HR accounts | Edit lunch menu (HR-only) |
| Create employees & custom roles | — |
| Manage all salaries & payslips | — |
| View all attendance & approve delays | — |
| Broadcast messages | — |
| Configure system settings (work hours, break duration, payroll cycle) | — |
| View absent users | — |
| Clock in/out & take breaks (like any user) | — |

**Home Dashboard:** System latency stats, compliance metrics, database sync status, system settings panel.

---

#### HR 🏢

Day-to-day HR operations lead. Cannot create other HR accounts or change system settings.

| Can Do | Cannot Do |
|--------|-----------|
| Create employees & custom roles | Create HR accounts |
| Edit/delete employees & salaries | Manage system settings |
| Generate batch payslips | — |
| Edit daily lunch menu | — |
| View catering analytics & headcount | — |
| Broadcast internal messages | — |
| View all attendance & approve delay requests | — |
| View absent users | — |

**Home Dashboard:** Pending payruns, employee count, HR operations panel, communications card.

---

#### Manager 💼

Team oversight without HR admin powers.

| Can Do | Cannot Do |
|--------|-----------|
| View org-wide attendance snapshot | Create/edit/delete employees |
| Approve or reject delay requests | Manage salary or generate payslips |
| View internal messages & emails | Broadcast messages |
| View absent users | Edit lunch menu or system settings |
| Clock in/out & take breaks | Create roles |
| View & download own payslips | — |

**Home Dashboard:** Team status (engineers active, on leave), attendance overview.

---

#### Staff (Developer, Sales, Designer, Accountant, Marketing, Custom) 👤

Individual contributors with self-service access.

| Can Do | Cannot Do |
|--------|-----------|
| Clock in/out daily | View other employees' attendance |
| Start/end 1-hour break | Approve delay requests |
| Submit delay requests | Manage employees or salary |
| View & download own payslips | Edit lunch menu |
| Select lunch meal (Standard/Vegan/Opt-Out) | Broadcast messages |
| Like/comment on menu items | View org-wide salary data |
| View absent users list | Access system settings |
| View own attendance history | — |

**Home Dashboard:** Personal workspace shortcuts to attendance and salary slip.

---

## API Reference

Base URL: `http://localhost:5000/api`

All protected routes require header: `Authorization: Bearer <token>`

Response format:
```json
{ "success": true, "message": "...", "data": { ... } }
```

### Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/login` | Public | Login with email + password |
| POST | `/auth/biometric` | Public | Biometric login (email only) |
| GET | `/auth/me` | Required | Get current user profile |
| POST | `/auth/logout` | Required | Logout (client-side token discard) |

### Users (HR Management)

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| POST | `/users/hr` | `create_hr` | Super Admin creates HR account |

### Employees

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/employees` | Required | List all active employees |
| GET | `/employees/:id` | Required | Get employee by ID |
| POST | `/employees` | `create_employees` | Create new employee |
| PATCH | `/employees/:id` | `edit_employees` | Update employee (salary, dept, etc.) |
| DELETE | `/employees/:id` | `delete_employees` | Deactivate employee |

### Custom Roles

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/roles/custom` | Required | List custom roles |
| POST | `/roles/custom` | `create_roles` | Create custom role |
| DELETE | `/roles/custom/:id` | `create_roles` | Delete custom role |

### Attendance

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/attendance/history` | Required | Own attendance history (30 days) |
| GET | `/attendance/today` | Required | Own check-in status today |
| GET | `/attendance/all` | `view_all_attendance` | Org-wide attendance today |
| POST | `/attendance/check-in` | `clock_in` | Check in |
| POST | `/attendance/check-out` | `clock_out` | Check out |

### Breaks

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/breaks/logs` | Required | Own break history |
| GET | `/breaks/status` | Required | Current break timer status |
| POST | `/breaks/start` | `break_in_out` | Start 1-hour break |
| POST | `/breaks/end` | `break_in_out` | End break |

### Delay Requests

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/delay-requests` | `view_team_attendance` | All delay requests |
| GET | `/delay-requests/mine` | Required | Own delay requests |
| POST | `/delay-requests` | Required | Submit delay request |
| PATCH | `/delay-requests/:id` | `view_team_attendance` | Approve/Reject |

### Catering

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/catering/menu/today` | Required | Today's lunch menu |
| PUT | `/catering/menu/today` | `manage_catering` | Update menu (HR only) |
| GET | `/catering/menu/feedback` | Required | All menu feedback |
| POST | `/catering/menu/feedback` | Required | Submit feedback |
| POST | `/catering/menu/feedback/:itemId/like` | Required | Toggle like on menu item |
| GET | `/catering/lunch/reservations` | Required | All lunch RSVPs today |
| GET | `/catering/lunch/my-reservation` | Required | Own lunch RSVP |
| POST | `/catering/lunch/reservations` | Required | Set meal selection |
| GET | `/catering/analytics` | `manage_catering` | Headcount extrapolation |

### Salary / Payroll

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/salary/slips` | `view_own_payslip` | Own payslips |
| GET | `/salary/slips/all` | `manage_salary` | All employee payslips |
| GET | `/salary/slips/:id/download` | `view_own_payslip` | Download payslip data |
| POST | `/salary/generate-batch` | `generate_payslip` | Generate payslips for all |
| POST | `/salary/slips` | `generate_payslip` | Generate single payslip |

### Communications

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/communications/messages` | `view_messages` | Internal messages |
| GET | `/communications/emails` | `view_emails` | System emails |
| POST | `/communications/messages/broadcast` | `manage_messages` | Broadcast to all staff |
| PATCH | `/communications/messages/:id/read` | `view_messages` | Mark message read |
| PATCH | `/communications/emails/:id/read` | `view_emails` | Mark email read |

### Absences

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/absences/today` | `view_absent_users` | Today's absent list |
| POST | `/absences` | `edit_employees` | Record absence |
| DELETE | `/absences/:empId` | `edit_employees` | Remove absence record |

### System Settings

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/settings` | `manage_system_settings` | Get all settings |
| PATCH | `/settings` | `manage_system_settings` | Update settings |
| GET | `/settings/roles` | Required | Role labels & permission matrix |

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | Public | Server health check |

---

## Database Schema

### Collections

| Collection | Model File | Key Fields |
|------------|-----------|------------|
| `users` | User.js | employeeId, name, email, password, systemRole, dept, salary, status |
| `customroles` | CustomRole.js | name, description, createdBy |
| `attendancelogs` | AttendanceLog.js | userId, date, status, timeIn, timeOut, delayReason |
| `breaklogs` | BreakLog.js | userId, date, startTime, endTime, duration, status |
| `delayrequests` | DelayRequest.js | userId, empName, requestedTime, reason, status |
| `salaryslips` | SalarySlip.js | userId, month, basic, allowances, bonus, tax, pf, net |
| `menus` | Menu.js | date, mainCourse, sides, dessert, veganOption, isLunchActive |
| `menufeedbacks` | MenuFeedback.js | itemId, userId, liked, comment |
| `lunchreservations` | LunchReservation.js | userId, date, selection, notes |
| `messages` | Message.js | from, subject, body, isBroadcast, recipients |
| `emails` | Email.js | userId, from, subject, preview, unread |
| `absences` | Absence.js | empId, name, dept, reason, date |
| `systemsettings` | SystemSettings.js | key, value, updatedBy |

### Departments

Engineering, Human Resources, Product Design, Operations, Sales, Finance, Marketing, Administration, General

---

## Mobile App Screens

| Tab | Screen | Key Features |
|-----|--------|-------------|
| **Home** | HomeScreen | Role dashboard, admin panels, absent users, communications |
| **Attendance** | AttendanceScreen | Check in/out, break timer, delay requests, history |
| **Catering** | CateringScreen | Menu, RSVPs, feedback, HR menu editor |
| **Salary** | SalaryScreen | Payslip list, download, HR batch generation |
| **Team** | DirectoryScreen | Employee search, salary edit, delete |

Additional: AuthScreen (login), SplashScreen, SideNav, NotificationCenter

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | API server port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/hrcore` | MongoDB connection string |
| `JWT_SECRET` | — | Secret for signing JWT tokens |
| `JWT_EXPIRES_IN` | `7d` | Token expiry duration |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |

---

## License

ISC
