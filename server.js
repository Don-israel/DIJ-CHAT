
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }
});

const PORT = Number(process.env.PORT || 3000);
const PREMIUM_DURATION_DAYS = 30;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PREMIUM_PRICE_KOBO = Number(process.env.PREMIUM_PRICE_KOBO || 0);
const APP_BASE_URL =
  process.env.APP_BASE_URL || `http://localhost:${PORT}`;

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  throw new Error(
    "Set ADMIN_USERNAME and ADMIN_PASSWORD in your .env file."
  );
}

if (
  !process.env.SESSION_SECRET ||
  process.env.SESSION_SECRET.length < 32
) {
  throw new Error(
    "Set SESSION_SECRET in .env to a random value of at least 32 characters."
  );
}

// ==================================================
// DATABASE
// ==================================================

const db = new Database("dijchat.db");

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT 'private',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing(
  "users",
  "account_status",
  "TEXT NOT NULL DEFAULT 'active'"
);

addColumnIfMissing(
  "users",
  "premium_expires_at",
  "TEXT DEFAULT NULL"
);

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    amount_kobo INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    starts_at TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    event_id TEXT UNIQUE,
    reference TEXT,
    event_type TEXT NOT NULL,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ==================================================
// ADMIN ACCOUNT
// ==================================================

const adminUsername = process.env.ADMIN_USERNAME.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;

const existingAdmin = db.prepare(
  "SELECT id, role FROM users WHERE username = ?"
).get(adminUsername);

if (!existingAdmin) {
  db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, 'admin')
  `).run(
    adminUsername,
    bcrypt.hashSync(adminPassword, 12)
  );

  console.log("Administrator account created.");
} else if (existingAdmin.role !== "admin") {
  db.prepare(
    "UPDATE users SET role = 'admin' WHERE id = ?"
  ).run(existingAdmin.id);
}

// ==================================================
// SECURITY AND MIDDLEWARE
// ==================================================

app.use(helmet({
  contentSecurityPolicy: false
}));

app.post(
  "/api/billing/paystack/webhook",
  express.raw({
    type: "application/json",
    limit: "1mb"
  }),
  handlePaystackWebhook
);

app.use(express.json({ limit: "1mb" }));

const sessionMiddleware = session({
  name: "dijchat.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

io.engine.use(sessionMiddleware);

// ==================================================
// HELPERS
// ==================================================

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  const user = db.prepare(`
    SELECT id, username, role,
           account_status, premium_expires_at
    FROM users
    WHERE id = ?
  `).get(req.session.user.id);

  if (!user || user.account_status !== "active") {
    req.session.destroy(() => {});

    return res.status(403).json({
      error: "This account is unavailable."
    });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role
  };

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({
      error: "Administrator access required."
    });
  }

  const admin = db.prepare(`
    SELECT id, role, account_status
    FROM users
    WHERE id = ?
  `).get(req.session.user.id);

  if (
    !admin ||
    admin.role !== "admin" ||
    admin.account_status !== "active"
  ) {
    return res.status(403).json({
      error: "Administrator access required."
    });
  }

  next();
}

function validUserId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isConversationMember(conversationId, userId) {
  return !!db.prepare(`
    SELECT 1
    FROM conversation_members
    WHERE conversation_id = ?
      AND user_id = ?
  `).get(conversationId, userId);
}

function auditAdmin(adminId, action, details = "") {
  db.prepare(`
    INSERT INTO admin_audit (admin_id, action, details)
    VALUES (?, ?, ?)
  `).run(adminId, action, String(details).slice(0, 1000));
}

function getPremiumStatus(userId) {
  const user = db.prepare(`
    SELECT premium_expires_at
    FROM users
    WHERE id = ?
  `).get(userId);

  const expiresAt = user?.premium_expires_at || null;

  const active = Boolean(
    expiresAt && new Date(expiresAt).getTime() > Date.now()
  );

  return {
    isPremium: active,
    expiresAt: active ? expiresAt : null
  };
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

async function paystackRequest(endpoint, method = "GET", body) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error("Online payments are not configured yet.");
  }

  const response = await fetch(
    `https://api.paystack.co${endpoint}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }
  );

  const data = await response.json();

  if (!response.ok || !data.status) {
    throw new Error(
      data.message || "Payment provider request failed."
    );
  }

  return data.data;
}

function activatePaidSubscription(userId, reference, amountKobo) {
  const now = new Date();

  const current = db.prepare(`
    SELECT premium_expires_at
    FROM users
    WHERE id = ?
  `).get(userId);

  const existingExpiry = current?.premium_expires_at
    ? new Date(current.premium_expires_at)
    : null;

  const startsAt = now.toISOString();
  const base =
    existingExpiry && existingExpiry > now
      ? existingExpiry
      : now;

  const expiresAt = addDays(base, PREMIUM_DURATION_DAYS);

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET premium_expires_at = ?
      WHERE id = ?
    `).run(expiresAt, userId);

    db.prepare(`
      UPDATE subscriptions
      SET status = 'active',
          starts_at = ?,
          expires_at = ?
      WHERE reference = ?
        AND user_id = ?
    `).run(startsAt, expiresAt, reference, userId);
  });

  transaction();
  return expiresAt;
}

// ==================================================
// REGISTER
// ==================================================

app.post("/api/auth/register", registerLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string"
  ) {
    return res.status(400).json({
      error: "Username and password are required."
    });
  }

  const cleanUsername = username.trim().toLowerCase();

  if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
    return res.status(400).json({
      error: "Username must be 3–20 characters using letters, numbers or underscores."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Password must be between 8 and 128 characters."
    });
  }

  const existing = db.prepare(
    "SELECT id FROM users WHERE username = ?"
  ).get(cleanUsername);

  if (existing) {
    return res.status(409).json({
      error: "Username already exists."
    });
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  const result = db.prepare(`
    INSERT INTO users (username, password_hash)
    VALUES (?, ?)
  `).run(cleanUsername, passwordHash);

  res.status(201).json({
    success: true,
    user: {
      id: result.lastInsertRowid,
      username: cleanUsername,
      role: "user"
    }
  });
});

// ==================================================
// LOGIN
// ==================================================

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string"
  ) {
    return res.status(400).json({
      error: "Username and password are required."
    });
  }

  const user = db.prepare(`
    SELECT *
    FROM users
    WHERE username = ?
  `).get(username.trim().toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({
      error: "Incorrect username or password."
    });
  }

  if (user.account_status !== "active") {
    return res.status(403).json({
      error: "This account has been suspended or disabled."
    });
  }

  req.session.regenerate(err => {
    if (err) {
      return res.status(500).json({
        error: "Could not create session."
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    res.json({
      success: true,
      user: req.session.user,
      premium: getPremiumStatus(user.id)
    });
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      premium: getPremiumStatus(req.user.id),
      accountStatus: req.user.account_status
    }
  });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({
        error: "Logout failed."
      });
    }

    res.clearCookie("dijchat.sid");
    res.json({ success: true });
  });
});
require("./profiles")(app, db, requireAuth);
// ==================================================
// USER SEARCH
// ==================================================

app.get("/api/users", requireAuth, (req, res) => {
  const search = String(req.query.search || "").trim();

  if (search.length < 2 || search.length > 20) {
    return res.json({ users: [] });
  }

  const users = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username LIKE ?
      AND id != ?
      AND account_status = 'active'
    LIMIT 20
  `).all(`%${search}%`, req.session.user.id);

  res.json({ users });
});

// ==================================================
// CREATE PRIVATE CONVERSATION
// ==================================================

app.post("/api/conversations", requireAuth, (req, res) => {
  const { username } = req.body || {};

  if (typeof username !== "string") {
    return res.status(400).json({
      error: "Username is required."
    });
  }

  const otherUser = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username = ?
      AND account_status = 'active'
  `).get(username.trim().toLowerCase());

  if (!otherUser) {
    return res.status(404).json({
      error: "User not found."
    });
  }

  const currentUserId = req.session.user.id;

  if (otherUser.id === currentUserId) {
    return res.status(400).json({
      error: "You cannot start a conversation with yourself."
    });
  }

  const existingConversation = db.prepare(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_members a
      ON a.conversation_id = c.id
    JOIN conversation_members b
      ON b.conversation_id = c.id
    WHERE c.type = 'private'
      AND a.user_id = ?
      AND b.user_id = ?
    LIMIT 1
  `).get(currentUserId, otherUser.id);

  if (existingConversation) {
    return res.json({
      conversationId: existingConversation.id
    });
  }

  const createConversation = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO conversations (type)
      VALUES ('private')
    `).run();

    const conversationId = result.lastInsertRowid;

    const addMember = db.prepare(`
      INSERT INTO conversation_members
        (conversation_id, user_id)
      VALUES (?, ?)
    `);

    addMember.run(conversationId, currentUserId);
    addMember.run(conversationId, otherUser.id);

    return conversationId;
  });

  res.status(201).json({
    conversationId: createConversation()
  });
});

// ==================================================
// GET CONVERSATIONS
// FIXED: RETURNS other_user_id FOR CALLING
// ==================================================

app.get("/api/conversations", requireAuth, (req, res) => {
  const conversations = db.prepare(`
    SELECT
      c.id,
      c.type,
      c.created_at,

      (
        SELECT u.id
        FROM conversation_members cm2
        JOIN users u ON u.id = cm2.user_id
        WHERE cm2.conversation_id = c.id
          AND cm2.user_id != ?
        LIMIT 1
      ) AS other_user_id,

      (
        SELECT u.username
        FROM conversation_members cm2
        JOIN users u ON u.id = cm2.user_id
        WHERE cm2.conversation_id = c.id
          AND cm2.user_id != ?
        LIMIT 1
      ) AS other_username,

      (
        SELECT m.content
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.id DESC
        LIMIT 1
      ) AS last_message

    FROM conversations c

    JOIN conversation_members cm
      ON cm.conversation_id = c.id

    WHERE cm.user_id = ?

    ORDER BY c.id DESC
  `).all(
    req.session.user.id,
    req.session.user.id,
    req.session.user.id
  );

  res.json({ conversations });
});

// ==================================================
// GET MESSAGES
// ==================================================

app.get(
  "/api/conversations/:id/messages",
  requireAuth,
  (req, res) => {
    const conversationId = validUserId(req.params.id);

    if (!conversationId) {
      return res.status(400).json({
        error: "Invalid conversation ID."
      });
    }

    if (!isConversationMember(conversationId, req.session.user.id)) {
      return res.status(403).json({
        error: "You are not a member of this conversation."
      });
    }

    const messages = db.prepare(`
      SELECT
        m.id,
        m.conversation_id,
        m.content,
        m.created_at,
        u.id AS sender_id,
        u.username AS sender_username
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.id DESC
      LIMIT 50
    `).all(conversationId);

    res.json({
      messages: messages.reverse()
    });
  }
);

// ==================================================
// PREMIUM STATUS
// ==================================================

app.get("/api/premium/status", requireAuth, (req, res) => {
  res.json({
    ...getPremiumStatus(req.session.user.id),
    providerConfigured: Boolean(
      PAYSTACK_SECRET_KEY && PREMIUM_PRICE_KOBO > 0
    ),
    priceKobo: PREMIUM_PRICE_KOBO || null,
    currency: "NGN",
    durationDays: PREMIUM_DURATION_DAYS
  });
});

app.get("/api/billing/config", requireAuth, (req, res) => {
  res.json({
    provider: "Paystack",
    configured: Boolean(
      PAYSTACK_SECRET_KEY && PREMIUM_PRICE_KOBO > 0
    ),
    priceKobo: PREMIUM_PRICE_KOBO || null,
    currency: "NGN",
    durationDays: PREMIUM_DURATION_DAYS
  });
});

// ==================================================
// PAYSTACK PAYMENT INITIALIZATION
// ==================================================

app.post(
  "/api/billing/paystack/initialize",
  requireAuth,
  paymentLimiter,
  async (req, res) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY ||
        !Number.isSafeInteger(PREMIUM_PRICE_KOBO) ||
        PREMIUM_PRICE_KOBO <= 0
      ) {
        return res.status(503).json({
          error: "Premium payments are not configured yet."
        });
      }

      const userId = req.session.user.id;

      const user = db.prepare(`
        SELECT username FROM users WHERE id = ?
      `).get(userId);

      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim()
          : "";

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > 254
      ) {
        return res.status(400).json({
          error: "Enter a valid email address for your payment receipt."
        });
      }

      const reference =
        `dij_${userId}_${crypto.randomBytes(12).toString("hex")}`;

      db.prepare(`
        INSERT INTO subscriptions
          (user_id, provider, reference, amount_kobo, status)
        VALUES (?, 'paystack', ?, ?, 'pending')
      `).run(userId, reference, PREMIUM_PRICE_KOBO);

      const payment = await paystackRequest(
        "/transaction/initialize",
        "POST",
        {
          email,
          amount: PREMIUM_PRICE_KOBO,
          currency: "NGN",
          reference,
          callback_url: `${APP_BASE_URL}/?payment=complete`,
          metadata: {
            user_id: userId,
            username: user.username,
            product: "DIJ CHAT Premium"
          }
        }
      );

      res.json({
        authorizationUrl: payment.authorization_url,
        reference: payment.reference
      });
    } catch (error) {
      console.error("Payment initialization error:", error.message);

      res.status(500).json({
        error: error.message || "Could not initialize payment."
      });
    }
  }
);

// ==================================================
// VERIFY PREMIUM PAYMENT
// ==================================================

app.post(
  "/api/billing/paystack/verify",
  requireAuth,
  paymentLimiter,
  async (req, res) => {
    try {
      const reference = req.body?.reference;

      if (
        typeof reference !== "string" ||
        reference.length > 100
      ) {
        return res.status(400).json({
          error: "A valid payment reference is required."
        });
      }

      const subscription = db.prepare(`
        SELECT *
        FROM subscriptions
        WHERE reference = ?
          AND user_id = ?
          AND provider = 'paystack'
      `).get(reference, req.session.user.id);

      if (!subscription) {
        return res.status(404).json({
          error: "Payment reference not found."
        });
      }

      if (subscription.status === "active") {
        return res.json({
          success: true,
          premium: getPremiumStatus(req.session.user.id)
        });
      }

      const payment = await paystackRequest(
        `/transaction/verify/${encodeURIComponent(reference)}`
      );

      if (
        payment.status !== "success" ||
        Number(payment.amount) !== Number(subscription.amount_kobo) ||
        payment.currency !== "NGN" ||
        payment.reference !== reference
      ) {
        return res.status(400).json({
          error: "Payment could not be verified."
        });
      }

      const expiresAt = activatePaidSubscription(
        req.session.user.id,
        reference,
        subscription.amount_kobo
      );

      res.json({
        success: true,
        premium: {
          isPremium: true,
          expiresAt
        }
      });
    } catch (error) {
      console.error("Payment verification error:", error.message);

      res.status(500).json({
        error: "Could not verify payment."
      });
    }
  }
);

// ==================================================
// PAYSTACK WEBHOOK
// ==================================================

function handlePaystackWebhook(req, res) {
  if (!PAYSTACK_SECRET_KEY) {
    return res.sendStatus(503);
  }

  const signature = req.headers["x-paystack-signature"];

  const expected = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest("hex");

  if (!signature || !safeEqual(signature, expected)) {
    return res.sendStatus(401);
  }

  let event;

  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (_) {
    return res.sendStatus(400);
  }

  if (
    event.event !== "charge.success" ||
    !event.data?.reference
  ) {
    return res.sendStatus(200);
  }

  const reference = String(event.data.reference);

  const subscription = db.prepare(`
    SELECT *
    FROM subscriptions
    WHERE reference = ?
      AND provider = 'paystack'
  `).get(reference);

  if (!subscription) {
    return res.sendStatus(200);
  }

  const eventId = String(event.data.id || reference);

  try {
    const alreadyProcessed = db.prepare(`
      SELECT id
      FROM payment_events
      WHERE event_id = ?
    `).get(eventId);

    if (alreadyProcessed) {
      return res.sendStatus(200);
    }

    if (
      event.data.status !== "success" ||
      Number(event.data.amount) !== Number(subscription.amount_kobo) ||
      event.data.currency !== "NGN"
    ) {
      return res.sendStatus(200);
    }

    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO payment_events
          (provider, event_id, reference, event_type)
        VALUES ('paystack', ?, ?, ?)
      `).run(eventId, reference, event.event);

      activatePaidSubscription(
        subscription.user_id,
        reference,
        subscription.amount_kobo
      );
    });

    transaction();
    return res.sendStatus(200);
  } catch (error) {
    console.error("Paystack webhook processing error:", error);
    return res.sendStatus(500);
  }
}

// ==================================================
// ADMIN DASHBOARD
// ==================================================

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const totalUsers = db.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).get().count;

  const activeUsers = db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE account_status = 'active'
  `).get().count;

  const suspendedUsers = db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE account_status = 'suspended'
  `).get().count;

  const premiumUsers = db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE premium_expires_at IS NOT NULL
      AND premium_expires_at > ?
  `).get(new Date().toISOString()).count;

  const pendingPayments = db.prepare(`
    SELECT COUNT(*) AS count
    FROM subscriptions
    WHERE status = 'pending'
  `).get().count;

  auditAdmin(
    req.session.user.id,
    "VIEW_OVERVIEW",
    "Viewed admin dashboard overview"
  );

  res.json({
    totalUsers,
    activeUsers,
    suspendedUsers,
    premiumUsers,
    pendingPayments
  });
});

// ==================================================
// ADMIN USER MANAGEMENT
// ==================================================

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const search = String(req.query.search || "")
    .trim()
    .slice(0, 30);

  const users = search
    ? db.prepare(`
        SELECT
          id, username, role, account_status,
          created_at, premium_expires_at
        FROM users
        WHERE username LIKE ?
        ORDER BY id DESC
        LIMIT 200
      `).all(`%${search}%`)
    : db.prepare(`
        SELECT
          id, username, role, account_status,
          created_at, premium_expires_at
        FROM users
        ORDER BY id DESC
        LIMIT 200
      `).all();

  auditAdmin(
    req.session.user.id,
    "VIEW_USERS",
    `Viewed users; search=${search || "none"}`
  );

  res.json({ users });
});

// ==================================================
// ADMIN GRANT PREMIUM
// ==================================================

app.post(
  "/api/admin/users/:id/premium",
  requireAdmin,
  (req, res) => {
    const userId = validUserId(req.params.id);
    const days = Number(
      req.body?.days || PREMIUM_DURATION_DAYS
    );

    if (
      !userId ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 3650
    ) {
      return res.status(400).json({
        error: "Provide a valid user ID and duration (1–3650 days)."
      });
    }

    const target = db.prepare(`
      SELECT id, username
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!target) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    const current = db.prepare(`
      SELECT premium_expires_at
      FROM users
      WHERE id = ?
    `).get(userId);

    const now = new Date();

    const existingExpiry = current.premium_expires_at
      ? new Date(current.premium_expires_at)
      : null;

    const base =
      existingExpiry && existingExpiry > now
        ? existingExpiry
        : now;

    const expiresAt = addDays(base, days);

    db.prepare(`
      UPDATE users
      SET premium_expires_at = ?
      WHERE id = ?
    `).run(expiresAt, userId);

    auditAdmin(
      req.session.user.id,
      "GRANT_PREMIUM",
      `Granted ${days} days of Premium to user ${target.username} (ID ${userId}); expires ${expiresAt}`
    );

    res.json({
      success: true,
      userId,
      expiresAt
    });
  }
);

// ==================================================
// ADMIN REVOKE PREMIUM
// ==================================================

app.delete(
  "/api/admin/users/:id/premium",
  requireAdmin,
  (req, res) => {
    const userId = validUserId(req.params.id);

    if (!userId) {
      return res.status(400).json({
        error: "Invalid user ID."
      });
    }

    const target = db.prepare(`
      SELECT id, username
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!target) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    db.prepare(`
      UPDATE users
      SET premium_expires_at = NULL
      WHERE id = ?
    `).run(userId);

    db.prepare(`
      UPDATE subscriptions
      SET status = 'revoked'
      WHERE user_id = ?
        AND status = 'active'
    `).run(userId);

    auditAdmin(
      req.session.user.id,
      "REVOKE_PREMIUM",
      `Revoked Premium from user ${target.username} (ID ${userId})`
    );

    res.json({ success: true });
  }
);

// ==================================================
// ADMIN SUSPEND / REACTIVATE
// ==================================================

app.post(
  "/api/admin/users/:id/status",
  requireAdmin,
  (req, res) => {
    const userId = validUserId(req.params.id);
    const status = req.body?.status;

    if (
      !userId ||
      !["active", "suspended"].includes(status)
    ) {
      return res.status(400).json({
        error: "Invalid user ID or status."
      });
    }

    if (userId === req.session.user.id) {
      return res.status(400).json({
        error: "You cannot suspend your own administrator account."
      });
    }

    const target = db.prepare(`
      SELECT id, username, role
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!target) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    if (target.role === "admin") {
      return res.status(403).json({
        error: "This endpoint cannot suspend another administrator."
      });
    }

    db.prepare(`
      UPDATE users
      SET account_status = ?
      WHERE id = ?
    `).run(status, userId);

    auditAdmin(
      req.session.user.id,
      status === "suspended"
        ? "SUSPEND_USER"
        : "REACTIVATE_USER",
      `${status} user ${target.username} (ID ${userId})`
    );

    if (status === "suspended") {
      io.to(`user:${userId}`).disconnectSockets(true);
    }

    res.json({
      success: true,
      userId,
      status
    });
  }
);

// ==================================================
// ADMIN SUBSCRIPTIONS
// ==================================================

app.get(
  "/api/admin/subscriptions",
  requireAdmin,
  (req, res) => {
    const subscriptions = db.prepare(`
      SELECT
        s.id,
        s.user_id,
        u.username,
        s.provider,
        s.reference,
        s.amount_kobo,
        s.status,
        s.starts_at,
        s.expires_at,
        s.created_at
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.id DESC
      LIMIT 200
    `).all();

    auditAdmin(
      req.session.user.id,
      "VIEW_SUBSCRIPTIONS",
      "Viewed subscription records"
    );

    res.json({ subscriptions });
  }
);

// ==================================================
// ADMIN AUDIT LOGS
// ==================================================

app.get("/api/admin/audit", requireAdmin, (req, res) => {
  const logs = db.prepare(`
    SELECT
      admin_audit.*,
      users.username AS admin_username
    FROM admin_audit
    LEFT JOIN users
      ON users.id = admin_audit.admin_id
    ORDER BY admin_audit.id DESC
    LIMIT 200
  `).all();

  res.json({ logs });
});

// ==================================================
// SOCKET.IO AUTHENTICATION
// ==================================================

io.use((socket, next) => {
  const sessionUser = socket.request.session?.user;

  if (!sessionUser) {
    return next(new Error("Authentication required."));
  }

  const user = db.prepare(`
    SELECT id, username, role, account_status
    FROM users
    WHERE id = ?
  `).get(sessionUser.id);

  if (!user || user.account_status !== "active") {
    return next(new Error("Account unavailable."));
  }

  socket.user = user;
  next();
});

// ==================================================
// REAL-TIME MESSAGING AND CALLING
// ==================================================

io.on("connection", socket => {
  const ownUserRoom = `user:${socket.user.id}`;

  socket.join(ownUserRoom);

  console.log(`${socket.user.username} connected.`);

  // ----------------------------------------------
  // JOIN CONVERSATION
  // ----------------------------------------------

  socket.on("conversation:join", conversationId => {
    const id = validUserId(conversationId);

    if (!id || !isConversationMember(id, socket.user.id)) {
      return;
    }

    socket.join(`conversation:${id}`);
  });

  // ----------------------------------------------
  // LEAVE CONVERSATION
  // ----------------------------------------------

  socket.on("conversation:leave", conversationId => {
    const id = validUserId(conversationId);

    if (id) {
      socket.leave(`conversation:${id}`);
    }
  });

  // ----------------------------------------------
  // SEND MESSAGE
  // ----------------------------------------------

  socket.on("message:send", (data, callback) => {
    const respond =
      typeof callback === "function"
        ? callback
        : () => {};

    try {
      const conversationId = validUserId(
        data?.conversationId
      );

      const content = data?.content;

      if (!conversationId) {
        return respond({
          error: "Invalid conversation."
        });
      }

      if (
        typeof content !== "string" ||
        content.trim().length === 0 ||
        content.length > 5000
      ) {
        return respond({
          error: "Message must contain 1–5000 characters."
        });
      }

      if (!isConversationMember(conversationId, socket.user.id)) {
        return respond({
          error: "You are not a member of this conversation."
        });
      }

      const result = db.prepare(`
        INSERT INTO messages
          (conversation_id, sender_id, content)
        VALUES (?, ?, ?)
      `).run(
        conversationId,
        socket.user.id,
        content.trim()
      );

      const message = db.prepare(`
        SELECT
          m.id,
          m.conversation_id,
          m.content,
          m.created_at,
          u.id AS sender_id,
          u.username AS sender_username
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?
      `).get(result.lastInsertRowid);

      io.to(`conversation:${conversationId}`).emit(
        "message:new",
        message
      );

      respond({
        success: true,
        message
      });
    } catch (error) {
      console.error("Message error:", error);

      respond({
        error: "Could not send message."
      });
    }
  });

  // ==============================================
  // VOICE AND VIDEO CALL SIGNALING
  // ==============================================

  const relayCallSignal = eventName => {
    socket.on(eventName, (data, callback) => {
      const respond =
        typeof callback === "function"
          ? callback
          : () => {};

      const conversationId = validUserId(
        data?.conversationId
      );

      const targetUserId = validUserId(
        data?.targetUserId
      );

      if (!conversationId || !targetUserId) {
        return respond({
          error: "Invalid call destination."
        });
      }

      if (targetUserId === socket.user.id) {
        return respond({
          error: "You cannot call yourself."
        });
      }

      if (
        !isConversationMember(
          conversationId,
          socket.user.id
        ) ||
        !isConversationMember(
          conversationId,
          targetUserId
        )
      ) {
        return respond({
          error: "Call participants must belong to the conversation."
        });
      }

      const targetUser = db.prepare(`
        SELECT id, account_status
        FROM users
        WHERE id = ?
      `).get(targetUserId);

      if (
        !targetUser ||
        targetUser.account_status !== "active"
      ) {
        return respond({
          error: "The other user is unavailable."
        });
      }

      const payload = {
        ...data,
        conversationId,
        targetUserId,
        fromUserId: socket.user.id,
        fromUsername: socket.user.username
      };

      io.to(`user:${targetUserId}`).emit(
        eventName,
        payload
      );

      respond({
        success: true
      });
    });
  };

  [
    "call:invite",
    "call:accept",
    "call:reject",
    "call:offer",
    "call:answer",
    "call:ice-candidate",
    "call:end"
  ].forEach(relayCallSignal);

  // ----------------------------------------------
  // DISCONNECT
  // ----------------------------------------------

  socket.on("disconnect", () => {
    console.log(
      `${socket.user.username} disconnected.`
    );
  });
});

// ==================================================
// FRONTEND
// ==================================================

app.use(
  express.static(path.join(__dirname, "public"))
);

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ==================================================
// ERROR HANDLING
// ==================================================

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

// ==================================================
// START DIJ CHAT SERVER
// ==================================================

server.listen(PORT, () => {
  console.log("==================================");
  console.log("       DIJ CHAT SERVER");
  console.log("==================================");
  console.log(`Running at: ${APP_BASE_URL}`);
  console.log("Messaging: Enabled");
  console.log("Voice/Video Signaling: Enabled");
  console.log("Premium APIs: Enabled");
  console.log("Admin Dashboard APIs: Enabled");
  console.log("==================================");
});
