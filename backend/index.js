const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");
const { pool } = require("./db");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function start() {
  try {
    console.log("Startup: beginning");

    const BUCKET_NAME = requireEnv("BUCKET_NAME");
    console.log("Startup: BUCKET_NAME loaded");

    const PORT = process.env.PORT || 8080;

    const storage = new Storage();
    const bucket = storage.bucket(BUCKET_NAME);
    console.log("Startup: storage ready");

    admin.initializeApp();
    console.log("Startup: firebase ready");

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "20mb" }));

    app.get("/health", (req, res) => {
      res.json({ ok: true });
    });

    async function requireFirebaseUser(req, res, next) {
      try {
        const header = req.headers.authorization || "";
        const match = header.match(/^Bearer (.+)$/);

        if (!match) {
          return res.status(401).json({ error: "Missing Bearer token" });
        }

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

    async function mapAttachmentsForPosts(postIds) {
      let attachmentsByPost = {};

      if (postIds.length === 0) return attachmentsByPost;

      const attRes = await pool.query(
        `SELECT post_id, object_path, content_type, original_name
         FROM post_attachments
         WHERE post_id = ANY($1::bigint[])`,
        [postIds]
      );

      attachmentsByPost = attRes.rows.reduce((acc, row) => {
        if (!acc[row.post_id]) acc[row.post_id] = [];
        acc[row.post_id].push(row);
        return acc;
      }, {});

      return attachmentsByPost;
    }

    async function buildPostResponse(posts) {
      const postIds = posts.map((p) => p.id);
      const attachmentsByPost = await mapAttachmentsForPosts(postIds);

      const result = [];
      for (const p of posts) {
        const atts = attachmentsByPost[p.id] || [];
        const mapped = [];

        for (const a of atts) {
          const file = bucket.file(a.object_path);
          const [url] = await file.getSignedUrl({
            version: "v4",
            action: "read",
            expires: Date.now() + 10 * 60 * 1000
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
          attachments: mapped,
          replyCount: p.reply_count
        });
      }

      return result;
    }

    app.post("/users/me", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const { username } = req.body || {};

      if (!username || !String(username).trim()) {
        return res.status(400).json({ error: "username required" });
      }

      const cleanedUsername = String(username).trim().toLowerCase();

      try {
        const existing = await pool.query(
          `SELECT id, firebase_uid FROM users WHERE username = $1`,
          [cleanedUsername]
        );

        if (existing.rowCount > 0 && existing.rows[0].firebase_uid !== uid) {
          return res.status(409).json({ error: "username already taken" });
        }

        await pool.query(
          `
          INSERT INTO users (firebase_uid, username)
          VALUES ($1, $2)
          ON CONFLICT (firebase_uid)
          DO UPDATE SET username = EXCLUDED.username
          `,
          [uid, cleanedUsername]
        );

        res.json({ ok: true, username: cleanedUsername });
      } catch (e) {
        console.error("users/me error:", e);
        res.status(500).json({ error: "failed to save username" });
      }
    });

    app.get("/users/me", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;

      try {
        const userRes = await pool.query(
          `SELECT id, username, firebase_uid
           FROM users
           WHERE firebase_uid = $1`,
          [uid]
        );

        if (userRes.rowCount === 0) {
          return res.status(404).json({ error: "user not found" });
        }

        const user = userRes.rows[0];

        const postsCountRes = await pool.query(
          `SELECT COUNT(*)::int AS posts_count
           FROM posts
           WHERE author_user_id = $1`,
          [user.id]
        );

        res.json({
          username: user.username || user.firebase_uid,
          displayName: user.username || user.firebase_uid,
          profileImageUrl: null,
          followersCount: 0,
          followingCount: 0,
          postsCount: postsCountRes.rows[0].posts_count
        });
      } catch (e) {
        console.error("users/me get error:", e);
        res.status(500).json({ error: "failed to load current user profile" });
      }
    });

    app.get("/users/:username", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const userRes = await pool.query(
          `SELECT id, username, firebase_uid
           FROM users
           WHERE LOWER(username) = $1`,
          [username]
        );

        if (userRes.rowCount === 0) {
          return res.status(404).json({ error: "user not found" });
        }

        const user = userRes.rows[0];

        const postsCountRes = await pool.query(
          `SELECT COUNT(*)::int AS posts_count
           FROM posts
           WHERE author_user_id = $1`,
          [user.id]
        );

        res.json({
          username: user.username || user.firebase_uid,
          displayName: user.username || user.firebase_uid,
          profileImageUrl: null,
          followersCount: 0,
          followingCount: 0,
          postsCount: postsCountRes.rows[0].posts_count
        });
      } catch (e) {
        console.error("get user profile error:", e);
        res.status(500).json({ error: "failed to load user profile" });
      }
    });

    app.get("/users/:username/posts", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const postsRes = await pool.query(
          `SELECT
              p.id,
              p.title,
              p.body,
              p.created_at,
              COALESCE(u.username, u.firebase_uid) AS author_name,
              COUNT(r.id)::int AS reply_count
           FROM posts p
           JOIN users u ON u.id = p.author_user_id
           LEFT JOIN post_replies r ON r.post_id = p.id
           WHERE LOWER(COALESCE(u.username, u.firebase_uid)) = $1
           GROUP BY p.id, u.username, u.firebase_uid
           ORDER BY p.created_at DESC`,
          [username]
        );

        const result = await buildPostResponse(postsRes.rows);
        res.json(result);
      } catch (e) {
        console.error("get user posts error:", e);
        res.status(500).json({ error: "failed to load user posts" });
      }
    });

    app.post("/uploads/signed-url", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const { contentType, originalName } = req.body || {};

      if (!contentType || !originalName) {
        return res.status(400).json({ error: "contentType and originalName required" });
      }

      try {
        const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, "_");
        const objectPath = `uploads/${uid}/${Date.now()}-${safeName}`;
        const file = bucket.file(objectPath);

        const [uploadUrl] = await file.getSignedUrl({
          version: "v4",
          action: "write",
          expires: Date.now() + 10 * 60 * 1000,
          contentType
        });

        res.json({ uploadUrl, objectPath });
      } catch (e) {
        console.error("signed-url error:", e);
        res.status(500).json({
          error: "failed to generate signed url",
          details: e.message || String(e)
        });
      }
    });

    app.post("/posts", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const { title, body, attachments } = req.body || {};

      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: "title required" });
      }

      if (!body || !String(body).trim()) {
        return res.status(400).json({ error: "body required" });
      }

      try {
        let userRes = await pool.query(
          `SELECT id FROM users WHERE firebase_uid = $1`,
          [uid]
        );

        if (userRes.rowCount === 0) {
          await pool.query(
            `INSERT INTO users (firebase_uid) VALUES ($1) ON CONFLICT DO NOTHING`,
            [uid]
          );

          userRes = await pool.query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [uid]
          );
        }

        const authorUserId = userRes.rows[0].id;

        const postRes = await pool.query(
          `INSERT INTO posts (author_user_id, title, body)
           VALUES ($1, $2, $3)
           RETURNING id, created_at`,
          [authorUserId, String(title).trim(), String(body).trim()]
        );

        const postId = postRes.rows[0].id;

        const list = Array.isArray(attachments) ? attachments : [];
        for (const a of list) {
          if (!a || !a.objectPath) continue;

          await pool.query(
            `INSERT INTO post_attachments (post_id, object_path, content_type, original_name)
             VALUES ($1, $2, $3, $4)`,
            [
              postId,
              a.objectPath,
              a.contentType || null,
              a.originalName || null
            ]
          );
        }

        res.json({
          ok: true,
          postId,
          createdAt: postRes.rows[0].created_at
        });
      } catch (e) {
        console.error("create post error:", e);
        res.status(500).json({ error: "failed to create post" });
      }
    });

    app.post("/posts/:postId/replies", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const postId = Number(req.params.postId);
      const { body } = req.body || {};

      if (!postId || Number.isNaN(postId)) {
        return res.status(400).json({ error: "invalid post id" });
      }

      if (!body || !String(body).trim()) {
        return res.status(400).json({ error: "reply body required" });
      }

      try {
        const userRes = await pool.query(
          `SELECT id FROM users WHERE firebase_uid = $1`,
          [uid]
        );

        if (userRes.rowCount === 0) {
          return res.status(404).json({ error: "user not found" });
        }

        const authorUserId = userRes.rows[0].id;

        const postRes = await pool.query(
          `SELECT id FROM posts WHERE id = $1`,
          [postId]
        );

        if (postRes.rowCount === 0) {
          return res.status(404).json({ error: "post not found" });
        }

        const replyRes = await pool.query(
          `INSERT INTO post_replies (post_id, author_user_id, body)
           VALUES ($1, $2, $3)
           RETURNING id, created_at`,
          [postId, authorUserId, String(body).trim()]
        );

        res.json({
          ok: true,
          replyId: replyRes.rows[0].id,
          createdAt: replyRes.rows[0].created_at
        });
      } catch (e) {
        console.error("create reply error:", e);
        res.status(500).json({ error: "failed to create reply" });
      }
    });

    app.get("/posts/:postId/replies", requireFirebaseUser, async (req, res) => {
      const postId = Number(req.params.postId);

      if (!postId || Number.isNaN(postId)) {
        return res.status(400).json({ error: "invalid post id" });
      }

      try {
        const repliesRes = await pool.query(
          `SELECT
              r.id,
              r.body,
              r.created_at,
              COALESCE(u.username, u.firebase_uid) AS author_name
           FROM post_replies r
           JOIN users u ON u.id = r.author_user_id
           WHERE r.post_id = $1
           ORDER BY r.created_at ASC`,
          [postId]
        );

        const result = repliesRes.rows.map((r) => ({
          id: r.id,
          body: r.body,
          createdAt: r.created_at,
          authorName: r.author_name
        }));

        res.json(result);
      } catch (e) {
        console.error("get replies error:", e);
        res.status(500).json({ error: "failed to load replies" });
      }
    });

    app.get("/feed", requireFirebaseUser, async (req, res) => {
      try {
        const postsRes = await pool.query(
          `SELECT
              p.id,
              p.title,
              p.body,
              p.created_at,
              COALESCE(u.username, u.firebase_uid) AS author_name,
              COUNT(r.id)::int AS reply_count
           FROM posts p
           JOIN users u ON u.id = p.author_user_id
           LEFT JOIN post_replies r ON r.post_id = p.id
           GROUP BY p.id, u.username, u.firebase_uid
           ORDER BY p.created_at DESC
           LIMIT 50`
        );

        const result = await buildPostResponse(postsRes.rows);
        res.json(result);
      } catch (e) {
        console.error("feed error:", e);
        res.status(500).json({ error: "failed to load feed" });
      }
    });

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Startup: API listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();
