
const sharp = require("sharp");
const rateLimit = require("express-rate-limit");

module.exports = function (app, db, requireAuth) {
    const columns = db.prepare(
        "PRAGMA table_info(users)"
    ).all();

    const fields = {
        display_name: "TEXT DEFAULT ''",
        bio: "TEXT DEFAULT ''",
        avatar: "BLOB DEFAULT NULL"
    };

    for (const [name, definition] of Object.entries(fields)) {
        if (!columns.some(column => column.name === name)) {
            db.exec(
                `ALTER TABLE users ADD COLUMN ${name} ${definition}`
            );
        }
    }

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 30,
        standardHeaders: true,
        legacyHeaders: false
    });

    // View a user's public profile.
    app.get(
        "/api/profiles/:username",
        requireAuth,
        (req, res) => {
            const profile = db.prepare(`
                SELECT id, username, display_name,
                       bio, created_at,
                       avatar IS NOT NULL AS has_avatar
                FROM users
                WHERE username = ?
                AND account_status = 'active'
            `).get(
                String(req.params.username)
                    .trim()
                    .toLowerCase()
            );

            if (!profile) {
                return res.status(404).json({
                    error: "Profile not found."
                });
            }

            res.json({ profile });
        }
    );

    // Display profile picture.
    app.get(
        "/api/avatars/:username",
        requireAuth,
        (req, res) => {
            const account = db.prepare(`
                SELECT avatar
                FROM users
                WHERE username = ?
                AND account_status = 'active'
            `).get(
                String(req.params.username)
                    .trim()
                    .toLowerCase()
            );

            res.set("Cache-Control", "private, no-store");

            if (!account || !account.avatar) {
                return res.sendStatus(404);
            }

            res.type("image/webp");
            res.send(account.avatar);
        }
    );

    // Update your own display name and bio.
    app.post(
        "/api/profile/update",
        requireAuth,
        limiter,
        (req, res) => {
            const { displayName, bio } = req.body || {};

            if (
                typeof displayName !== "string" ||
                typeof bio !== "string" ||
                displayName.trim().length > 40 ||
                bio.trim().length > 160
            ) {
                return res.status(400).json({
                    error: "Invalid profile information."
                });
            }

            db.prepare(`
                UPDATE users
                SET display_name = ?, bio = ?
                WHERE id = ?
            `).run(
                displayName.trim(),
                bio.trim(),
                req.user.id
            );

            res.json({ success: true });
        }
    );

    // Upload and process a profile picture.
    app.post(
        "/api/profile/avatar",
        requireAuth,
        limiter,
        async (req, res) => {
            try {
                const image = req.body?.image;

                if (
                    typeof image !== "string" ||
                    image.length > 900000
                ) {
                    return res.status(400).json({
                        error: "Invalid image or image too large."
                    });
                }

                const match = image.match(
                    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/
                );

                if (!match) {
                    return res.status(400).json({
                        error: "Choose a JPEG, PNG or WebP image."
                    });
                }

                const buffer = Buffer.from(
                    match[1],
                    "base64"
                );

                const picture = await sharp(buffer, {
                    limitInputPixels: 16000000
                })
                    .rotate()
                    .resize(384, 384, {
                        fit: "cover",
                        position: "centre"
                    })
                    .webp({ quality: 85 })
                    .toBuffer();

                db.prepare(`
                    UPDATE users
                    SET avatar = ?
                    WHERE id = ?
                `).run(picture, req.user.id);

                res.json({ success: true });

            } catch (error) {
                res.status(400).json({
                    error: "Unable to process this picture."
                });
            }
        }
    );

    // Remove your own profile picture.
    app.delete(
        "/api/profile/avatar",
        requireAuth,
        limiter,
        (req, res) => {
            db.prepare(`
                UPDATE users
                SET avatar = NULL
                WHERE id = ?
            `).run(req.user.id);

            res.json({ success: true });
        }
    );

    console.log("DIJ CHAT social profiles enabled.");
};
