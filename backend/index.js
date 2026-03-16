const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");
const { pool } = require("./db");

// ---------- Config helpers ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const BUCKET_NAME = requireEnv("BUCKET_NAME");
const PORT = process.env.PORT || 8080;

const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

// ---------- Firebase Admin ----------
/**
 * On Cloud Run, you normally don't need a serviceAccount JSON file.
 * Cloud Run uses the service account attached to the service.
 */
admin.initializeApp();

// ---------- Auth middleware ----------
async function requireFirebaseUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const idToken = match[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUid = decoded.uid;
    req.firebaseEmail = decoded.email || null;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // metadata only; uploads go to signed URL

app.get("/health", (req, res) => res.json({ ok: true }));

// Ensure user row exists
app.post("/users/me", requireFirebaseUser, async (req, res) => {
  const uid = req.firebaseUid;

  // You can extend this later to accept username/displayName updates.
  const q = `
    INSERT INTO users (firebase_uid)
    VALUES ($1)
    ON CONFLICT (firebase_uid) DO NOTHING
    RETURNING id
  `;
  await pool.query(q, [uid]);
  res.json({ ok: true });
});

// Signed upload URL for ANY file
app.post("/uploads/signed-url", requireFirebaseUser, async (req, res) => {
  const uid = req.firebaseUid;
  const { contentType, originalName } = req.body || {};

  if (!contentType || !originalName) {
    return res.status(400).json({ error: "contentType and originalName required" });
  }

  // Make a safe object path
  const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectPath = `uploads/${uid}/${Date.now()}-${safeName}`;

  const file = bucket.file(objectPath);

  const [uploadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    contentType
  });

  res.json({ uploadUrl, objectPath });
});

// Create a text post with optional attachments
app.post("/posts", requireFirebaseUser, async (req, res) => {
  const uid = req.firebaseUid;
  const { title, body, attachments } = req.body || {};

  if (!title || !body) {
    return res.status(400).json({ error: "title and body required" });
  }

  // 1) Get user_id for this firebase uid
  const userRes = await pool.query(`SELECT id FROM users WHERE firebase_uid = $1`, [uid]);
  if (userRes.rowCount === 0) {
    // user row might not exist if /users/me wasn't called
    await pool.query(`INSERT INTO users (firebase_uid) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
  }
  const userRes2 = await pool.query(`SELECT id FROM users WHERE firebase_uid = $1`, [uid]);
  const authorUserId = userRes2.rows[0].id;

  // 2) Insert post
  const postRes = await pool.query(
    `INSERT INTO posts (author_user_id, title, body)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [authorUserId, title, body]
  );

  const postId = postRes.rows[0].id;

  // 3) Insert attachments (optional)
  const list = Array.isArray(attachments) ? attachments : [];
  for (const a of list) {
    if (!a || !a.objectPath) continue;
    await pool.query(
      `INSERT INTO post_attachments (post_id, object_path, content_type, original_name)
       VALUES ($1, $2, $3, $4)`,
      [postId, a.objectPath, a.contentType || null, a.originalName || null]
    );
  }

  res.json({ ok: true, postId });
});

// Feed: latest posts + attachments
app.get("/feed", requireFirebaseUser, async (req, res) => {
  // Basic feed: latest 50
  const postsRes = await pool.query(
    `SELECT p.id, p.title, p.body, p.created_at,
            COALESCE(u.username, u.firebase_uid) AS author_name
     FROM posts p
     JOIN users u ON u.id = p.author_user_id
     ORDER BY p.created_at DESC
     LIMIT 50`
  );

  const posts = postsRes.rows;

  // Grab attachments for all posts in one query
  const postIds = posts.map(p => p.id);
  let attachmentsByPost = {};
  if (postIds.length > 0) {
    const attRes = await pool.query(
      `SELECT post_id, object_path, content_type, original_name
       FROM post_attachments
       WHERE post_id = ANY($1::bigint[])`,
      [postIds]
    );

    attachmentsByPost = attRes.rows.reduce((acc, row) => {
      acc[row.post_id] = acc[row.post_id] || [];
      acc[row.post_id].push(row);
      return acc;
    }, {});
  }

  // For demo: return signed READ urls so bucket can stay private
  const result = [];
  for (const p of posts) {
    const atts = attachmentsByPost[p.id] || [];
    const mapped = [];

    for (const a of atts) {
      const file = bucket.file(a.object_path);
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 10 * 60 * 1000 // 10 minutes
      });

      mapped.push({
        url,
        contentType: a.content_type,
        originalName: a.original_name
      });
    }

    result.push({
      id: p.id,
      title: p.title,
      body: p.body,
      createdAt: p.created_at,
      authorName: p.author_name,
      attachments: mapped
    });
  }

  res.json(result);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API listening on port ${PORT}`);
});
