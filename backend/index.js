// Import Express, which is used to create the HTTP API server.
const express = require("express");

// Import CORS middleware so the Android client can make requests
// to the backend from a different origin.
const cors = require("cors");

// Import the Firebase Admin SDK.
// This is used on the backend to verify Firebase Authentication ID tokens.
const admin = require("firebase-admin");

// Import Google Cloud Storage SDK.
// This is used to generate signed upload/download URLs for media files.
const { Storage } = require("@google-cloud/storage");

// Import the PostgreSQL connection pool from db.js.
const { pool } = require("./db");


// Helper function to safely read required environment variables.
// If a value is missing, the server throws an error during startup
// instead of failing later in a harder-to-debug way.
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}


// Main async startup function.
// Wrapping startup in an async function allows the application
// to use await cleanly during initialisation and fail safely if needed.
async function start() {
  try {
    console.log("Startup: beginning");

    // Read the Google Cloud Storage bucket name from environment variables.
    const BUCKET_NAME = requireEnv("BUCKET_NAME");
    console.log("Startup: BUCKET_NAME loaded");

    // Cloud Run provides PORT automatically.
    // 8080 is used as a fallback for local/expected deployment behaviour.
    const PORT = process.env.PORT || 8080;

    // Initialise Google Cloud Storage and get a reference to the target bucket.
    const storage = new Storage();
    const bucket = storage.bucket(BUCKET_NAME);
    console.log("Startup: storage ready");

    // Initialise Firebase Admin.
    // On Cloud Run this works using the service account attached
    // to the deployed service, so no manual credentials file is required.
    admin.initializeApp();
    console.log("Startup: firebase ready");

    // Create the Express application.
    const app = express();

    // Enable Cross-Origin Resource Sharing.
    app.use(cors());

    // Parse incoming JSON request bodies.
    // The 20mb limit supports posts that include metadata for media uploads.
    app.use(express.json({ limit: "20mb" }));


    // -------------------------------------------------------------------------
    // TAG CONFIGURATION
    // -------------------------------------------------------------------------
    // The application allows a controlled set of post tags.
    // These are grouped by general tags and audio-related tags.

    // General tags valid for any post.
    const DEFAULT_TAGS = new Set([
      "Announcement",
      "Question",
      "Discussion"
    ]);

    // Tags describing the type of audio upload.
    const AUDIO_TYPE_TAGS = new Set([
      "Demo",
      "Full",
      "Loop",
      "Sample"
    ]);

    // Tags describing software/tools used to make the audio.
    const AUDIO_TOOL_TAGS = new Set([
      "Ableton",
      "FL Studio",
      "GarageBand",
      "Logic",
      "TidalCycles",
      "SuperCollider"
    ]);

    // Merge all valid tags into a single master set for validation.
    const ALL_ALLOWED_TAGS = new Set([
      ...DEFAULT_TAGS,
      ...AUDIO_TYPE_TAGS,
      ...AUDIO_TOOL_TAGS
    ]);


    // Normalises the incoming tags array.
    // This:
    // - ensures the value is actually an array,
    // - converts all values to strings,
    // - trims whitespace,
    // - removes empty values,
    // - removes duplicates.
    function normalizeTags(input) {
      if (!Array.isArray(input)) return [];

      const cleaned = input
        .map((tag) => String(tag || "").trim())
        .filter(Boolean);

      return [...new Set(cleaned)];
    }

    // Checks whether a post contains at least one audio attachment.
    // This is used because some tags are only valid if the post contains audio.
    function hasAudioAttachment(attachments) {
      if (!Array.isArray(attachments)) return false;

      return attachments.some((a) => {
        const contentType = String(a?.contentType || "");
        return contentType.startsWith("audio/");
      });
    }

    // Validates post tags against the allowed tag list.
    // Also enforces a business rule:
    // audio-specific tags may only be used when the post has an audio attachment.
    function validatePostTags(tags, attachments) {
      const normalizedTags = normalizeTags(tags);
      const audioAttached = hasAudioAttachment(attachments);

      for (const tag of normalizedTags) {
        // Reject any tag that is not part of the approved tag set.
        if (!ALL_ALLOWED_TAGS.has(tag)) {
          return { ok: false, error: `invalid tag: ${tag}` };
        }

        // Identify whether the current tag is restricted to audio posts.
        const isAudioOnlyTag =
          AUDIO_TYPE_TAGS.has(tag) || AUDIO_TOOL_TAGS.has(tag);

        // Prevent audio-only tags being used on non-audio posts.
        if (isAudioOnlyTag && !audioAttached) {
          return {
            ok: false,
            error: `tag "${tag}" requires an audio attachment`
          };
        }
      }

      // If validation succeeds, return the cleaned tag list.
      return {
        ok: true,
        tags: normalizedTags
      };
    }


    // -------------------------------------------------------------------------
    // BASIC HEALTH CHECK
    // -------------------------------------------------------------------------
    // Simple endpoint used to confirm the API is online.
    // Useful for deployment checks and debugging.
    app.get("/health", (req, res) => {
      res.json({ ok: true });
    });


    // -------------------------------------------------------------------------
    // AUTHENTICATION MIDDLEWARE
    // -------------------------------------------------------------------------
    // Middleware that protects routes by requiring a Firebase Bearer token.
    // It verifies the token and stores the Firebase UID/email on the request.
    async function requireFirebaseUser(req, res, next) {
      try {
        const header = req.headers.authorization || "";
        const match = header.match(/^Bearer (.+)$/);

        // Reject requests with no valid Bearer token.
        if (!match) {
          return res.status(401).json({ error: "Missing Bearer token" });
        }

        const idToken = match[1];

        // Verify the token with Firebase Admin.
        const decoded = await admin.auth().verifyIdToken(idToken);

        // Store useful authentication details on the request object
        // so later route handlers can access them.
        req.firebaseUid = decoded.uid;
        req.firebaseEmail = decoded.email || null;

        next();
      } catch (e) {
        console.error("Auth error:", e);
        return res.status(401).json({ error: "Invalid token" });
      }
    }


    // -------------------------------------------------------------------------
    // HELPER FUNCTIONS FOR DATABASE ACCESS
    // -------------------------------------------------------------------------

    // Finds an internal database user record using the Firebase UID.
    // This links Firebase Authentication accounts to app-specific user rows.
    async function getDbUserByFirebaseUid(firebaseUid) {
      const res = await pool.query(
        `SELECT id, username, firebase_uid
         FROM users
         WHERE firebase_uid = $1`,
        [firebaseUid]
      );

      return res.rowCount > 0 ? res.rows[0] : null;
    }

    // Retrieves either the followers or following list for a given username.
    async function getUserListByRelation(targetUsername, relation) {
      // First locate the target user.
      const targetRes = await pool.query(
        `
        SELECT id
        FROM users
        WHERE LOWER(COALESCE(username, firebase_uid)) = $1
        LIMIT 1
        `,
        [targetUsername.toLowerCase()]
      );

      if (targetRes.rowCount === 0) {
        return null;
      }

      const targetUserId = targetRes.rows[0].id;

      let query;

      // If the route asks for followers,
      // return users who follow the target user.
      if (relation === "followers") {
        query = `
          SELECT
            COALESCE(u.username, u.firebase_uid) AS username,
            COALESCE(u.username, u.firebase_uid) AS display_name
          FROM user_follows f
          JOIN users u ON u.id = f.follower_user_id
          WHERE f.followed_user_id = $1
          ORDER BY COALESCE(u.username, u.firebase_uid) ASC
        `;
      } else {
        // Otherwise return users the target user is following.
        query = `
          SELECT
            COALESCE(u.username, u.firebase_uid) AS username,
            COALESCE(u.username, u.firebase_uid) AS display_name
          FROM user_follows f
          JOIN users u ON u.id = f.followed_user_id
          WHERE f.follower_user_id = $1
          ORDER BY COALESCE(u.username, u.firebase_uid) ASC
        `;
      }

      const res = await pool.query(query, [targetUserId]);

      // Map database rows into a clean API response object.
      return res.rows.map((u) => ({
        username: u.username,
        displayName: u.display_name,
        profileImageUrl: null
      }));
    }

    // Builds a profile response object for a requested user.
    // This includes counts and relationship state relative to the viewer.
    async function getProfileDto(viewerUserId, username) {
      const res = await pool.query(
        `
        SELECT
          u.id,
          COALESCE(u.username, u.firebase_uid) AS username,
          COALESCE(u.username, u.firebase_uid) AS display_name,

          -- Count the number of posts authored by this user
          (
            SELECT COUNT(*)::int
            FROM posts p
            WHERE p.author_user_id = u.id
          ) AS posts_count,

          -- Count how many followers this user has
          (
            SELECT COUNT(*)::int
            FROM user_follows f
            WHERE f.followed_user_id = u.id
          ) AS followers_count,

          -- Count how many users this person is following
          (
            SELECT COUNT(*)::int
            FROM user_follows f
            WHERE f.follower_user_id = u.id
          ) AS following_count,

          -- Determine whether the viewer follows this user
          CASE
            WHEN $2::bigint IS NULL THEN false
            ELSE EXISTS (
              SELECT 1
              FROM user_follows f
              WHERE f.follower_user_id = $2
                AND f.followed_user_id = u.id
            )
          END AS is_following,

          -- Determine whether the requested profile belongs to the viewer
          CASE
            WHEN $2::bigint IS NULL THEN false
            ELSE u.id = $2
          END AS is_own_profile
        FROM users u
        WHERE LOWER(COALESCE(u.username, u.firebase_uid)) = $1
        LIMIT 1
        `,
        [username.toLowerCase(), viewerUserId]
      );

      if (res.rowCount === 0) return null;

      const row = res.rows[0];

      return {
        username: row.username,
        displayName: row.display_name,
        profileImageUrl: null,
        followersCount: row.followers_count,
        followingCount: row.following_count,
        postsCount: row.posts_count,
        isFollowing: row.is_following,
        isOwnProfile: row.is_own_profile
      };
    }

    // Fetches all attachment rows for a list of posts
    // and groups them by post_id for easier lookup later.
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

    // Converts raw database post rows into the final API response format.
    // For each stored attachment, a temporary signed URL is created
    // so the client can access the file securely.
    async function buildPostResponse(posts) {
      const postIds = posts.map((p) => p.id);
      const attachmentsByPost = await mapAttachmentsForPosts(postIds);

      const result = [];
      for (const p of posts) {
        const atts = attachmentsByPost[p.id] || [];
        const mapped = [];

        for (const a of atts) {
          const file = bucket.file(a.object_path);

          // Generate a time-limited signed URL for reading the file.
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
          tags: Array.isArray(p.tags) ? p.tags : [],
          replyCount: p.reply_count
        });
      }

      return result;
    }


    // -------------------------------------------------------------------------
    // USER ROUTES
    // -------------------------------------------------------------------------

    // Save or update the current user's username.
    app.post("/users/me", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const { username } = req.body || {};

      if (!username || !String(username).trim()) {
        return res.status(400).json({ error: "username required" });
      }

      // Lowercase normalisation ensures usernames are stored consistently
      // and checked case-insensitively.
      const cleanedUsername = String(username).trim().toLowerCase();

      try {
        // Check whether the chosen username is already in use by another account.
        const existing = await pool.query(
          `SELECT id, firebase_uid FROM users WHERE username = $1`,
          [cleanedUsername]
        );

        if (existing.rowCount > 0 && existing.rows[0].firebase_uid !== uid) {
          return res.status(409).json({ error: "username already taken" });
        }

        // Insert a new user row or update the username if the Firebase UID exists.
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

    // Return the authenticated user's own profile.
    app.get("/users/me", requireFirebaseUser, async (req, res) => {
      try {
        const viewer = await getDbUserByFirebaseUid(req.firebaseUid);

        if (!viewer) {
          return res.status(404).json({ error: "user not found" });
        }

        const profile = await getProfileDto(
          viewer.id,
          viewer.username || viewer.firebase_uid
        );

        if (!profile) {
          return res.status(404).json({ error: "user not found" });
        }

        res.json(profile);
      } catch (e) {
        console.error("users/me get error:", e);
        res.status(500).json({ error: "failed to load current user profile" });
      }
    });

    // Search users by partial username/display name match.
    app.get("/users/search", requireFirebaseUser, async (req, res) => {
      const q = String(req.query.q || "").trim().toLowerCase();

      try {
        const viewer = await getDbUserByFirebaseUid(req.firebaseUid);
        const viewerId = viewer ? viewer.id : null;

        const usersRes = await pool.query(
          `
          SELECT
            COALESCE(username, firebase_uid) AS username,
            COALESCE(username, firebase_uid) AS display_name
          FROM users
          WHERE COALESCE(username, firebase_uid) <> ''
            AND ($1 = '' OR LOWER(COALESCE(username, firebase_uid)) LIKE $2)
            AND ($3::bigint IS NULL OR id <> $3)
          ORDER BY COALESCE(username, firebase_uid) ASC
          LIMIT 30
          `,
          [q, `%${q}%`, viewerId]
        );

        const result = usersRes.rows.map((u) => ({
          username: u.username,
          displayName: u.display_name,
          profileImageUrl: null
        }));

        res.json(result);
      } catch (e) {
        console.error("user search error:", e);
        res.status(500).json({ error: "failed to search users" });
      }
    });

    // Return the public profile of a given username.
    app.get("/users/:username", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const viewer = await getDbUserByFirebaseUid(req.firebaseUid);
        const viewerId = viewer ? viewer.id : null;

        const profile = await getProfileDto(viewerId, username);

        if (!profile) {
          return res.status(404).json({ error: "user not found" });
        }

        res.json(profile);
      } catch (e) {
        console.error("get user profile error:", e);
        res.status(500).json({ error: "failed to load user profile" });
      }
    });

    // Return all posts made by a specific user.
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
              p.tags,
              COALESCE(u.username, u.firebase_uid) AS author_name,
              COUNT(r.id)::int AS reply_count
           FROM posts p
           JOIN users u ON u.id = p.author_user_id
           LEFT JOIN post_replies r ON r.post_id = p.id
           WHERE LOWER(COALESCE(u.username, u.firebase_uid)) = $1
           GROUP BY p.id, p.tags, u.username, u.firebase_uid
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

    // Follow a user.
    app.post("/users/:username/follow", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const viewer = await getDbUserByFirebaseUid(req.firebaseUid);

        if (!viewer) {
          return res.status(404).json({ error: "viewer not found" });
        }

        const targetRes = await pool.query(
          `
          SELECT id, COALESCE(username, firebase_uid) AS username
          FROM users
          WHERE LOWER(COALESCE(username, firebase_uid)) = $1
          LIMIT 1
          `,
          [username]
        );

        if (targetRes.rowCount === 0) {
          return res.status(404).json({ error: "user not found" });
        }

        const target = targetRes.rows[0];

        // Prevent users from following themselves.
        if (target.id === viewer.id) {
          return res.status(400).json({ error: "cannot follow yourself" });
        }

        // Insert follow relationship if it does not already exist.
        await pool.query(
          `
          INSERT INTO user_follows (follower_user_id, followed_user_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          `,
          [viewer.id, target.id]
        );

        const updatedProfile = await getProfileDto(viewer.id, username);
        res.json(updatedProfile);
      } catch (e) {
        console.error("follow user error:", e);
        res.status(500).json({ error: "failed to follow user" });
      }
    });

    // Return the followers list for a user.
    app.get("/users/:username/followers", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const result = await getUserListByRelation(username, "followers");

        if (result === null) {
          return res.status(404).json({ error: "user not found" });
        }

        res.json(result);
      } catch (e) {
        console.error("get followers error:", e);
        res.status(500).json({ error: "failed to load followers" });
      }
    });

    // Return the following list for a user.
    app.get("/users/:username/following", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const result = await getUserListByRelation(username, "following");

        if (result === null) {
          return res.status(404).json({ error: "user not found" });
        }

        res.json(result);
      } catch (e) {
        console.error("get following error:", e);
        res.status(500).json({ error: "failed to load following" });
      }
    });

    // Unfollow a user.
    app.delete("/users/:username/follow", requireFirebaseUser, async (req, res) => {
      const username = String(req.params.username || "").trim().toLowerCase();

      if (!username) {
        return res.status(400).json({ error: "username required" });
      }

      try {
        const viewer = await getDbUserByFirebaseUid(req.firebaseUid);

        if (!viewer) {
          return res.status(404).json({ error: "viewer not found" });
        }

        const targetRes = await pool.query(
          `
          SELECT id, COALESCE(username, firebase_uid) AS username
          FROM users
          WHERE LOWER(COALESCE(username, firebase_uid)) = $1
          LIMIT 1
          `,
          [username]
        );

        if (targetRes.rowCount === 0) {
          return res.status(404).json({ error: "user not found" });
        }

        const target = targetRes.rows[0];

        // Remove the follow relationship if it exists.
        await pool.query(
          `
          DELETE FROM user_follows
          WHERE follower_user_id = $1
            AND followed_user_id = $2
          `,
          [viewer.id, target.id]
        );

        const updatedProfile = await getProfileDto(viewer.id, username);
        res.json(updatedProfile);
      } catch (e) {
        console.error("unfollow user error:", e);
        res.status(500).json({ error: "failed to unfollow user" });
      }
    });


    // -------------------------------------------------------------------------
    // UPLOAD ROUTE
    // -------------------------------------------------------------------------

    // Create a signed upload URL so the client can upload directly to
    // Google Cloud Storage without sending the whole file through the backend.
    app.post("/uploads/signed-url", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const { contentType, originalName } = req.body || {};

      if (!contentType || !originalName) {
        return res.status(400).json({ error: "contentType and originalName required" });
      }

      try {
        // Sanitize the original filename for safe object storage.
        const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, "_");

        // Build a unique storage path using the user's UID and a timestamp.
        const objectPath = `uploads/${uid}/${Date.now()}-${safeName}`;
        const file = bucket.file(objectPath);

        // Generate a signed write URL valid for 10 minutes.
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


    // -------------------------------------------------------------------------
    // POST ROUTES
    // -------------------------------------------------------------------------

    // Create a new post.
    app.post("/posts", requireFirebaseUser, async (req, res) => {
      const uid = req.firebaseUid;
      const { title, body, attachments, tags } = req.body || {};

      // Basic validation for required fields.
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: "title required" });
      }

      if (!body || !String(body).trim()) {
        return res.status(400).json({ error: "body required" });
      }

      // Validate tags before inserting the post.
      const validatedTags = validatePostTags(tags, attachments);
      if (!validatedTags.ok) {
        return res.status(400).json({ error: validatedTags.error });
      }

      try {
        // Look up the app user record by Firebase UID.
        let userRes = await pool.query(
          `SELECT id FROM users WHERE firebase_uid = $1`,
          [uid]
        );

        // If the user row does not exist yet, create it.
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

        // Insert the post into the posts table.
        const postRes = await pool.query(
          `INSERT INTO posts (author_user_id, title, body, tags)
           VALUES ($1, $2, $3, $4::text[])
           RETURNING id, created_at`,
          [
            authorUserId,
            String(title).trim(),
            String(body).trim(),
            validatedTags.tags
          ]
        );

        const postId = postRes.rows[0].id;

        // Insert any uploaded attachments associated with this post.
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
          createdAt: postRes.rows[0].created_at,
          tags: validatedTags.tags
        });
      } catch (e) {
        console.error("create post error:", e);
        res.status(500).json({ error: "failed to create post" });
      }
    });

    // Create a reply on an existing post.
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

        // Confirm the target post exists before inserting the reply.
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

    // Fetch all replies for a post.
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

    // Fetch the main feed.
    // Returns the 50 most recent posts with reply counts and signed media URLs.
    app.get("/feed", requireFirebaseUser, async (req, res) => {
      try {
        const postsRes = await pool.query(
          `SELECT
              p.id,
              p.title,
              p.body,
              p.created_at,
              p.tags,
              COALESCE(u.username, u.firebase_uid) AS author_name,
              COUNT(r.id)::int AS reply_count
           FROM posts p
           JOIN users u ON u.id = p.author_user_id
           LEFT JOIN post_replies r ON r.post_id = p.id
           GROUP BY p.id, p.tags, u.username, u.firebase_uid
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


    // -------------------------------------------------------------------------
    // START SERVER
    // -------------------------------------------------------------------------
    // Bind the Express app to the Cloud Run port on all interfaces.
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Startup: API listening on port ${PORT}`);
    });
  } catch (err) {
    // If startup fails, log the issue and stop the process.
    // This is useful because Cloud Run will show the failure in logs.
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

// Run the startup function.
start();


// References:
// 1. Express.js documentation:
//    https://expressjs.com/
//
// 2. CORS middleware for Express:
//    https://www.npmjs.com/package/cors
//
// 3. Firebase Admin SDK documentation for verifying ID tokens:
//    https://firebase.google.com/docs/auth/admin/verify-id-tokens
//
// 4. Google Cloud Storage Node.js client library:
//    https://cloud.google.com/nodejs/docs/reference/storage/latest
//
// 5. Google Cloud Storage signed URL documentation:
//    https://cloud.google.com/storage/docs/access-control/signed-urls
//
// 6. node-postgres parameterised query / pool usage:
//    https://node-postgres.com/
//
// 7. General REST API design patterns, middleware structure,
//    and standard Express route handling adapted into project-specific logic.
