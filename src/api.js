const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./config");
const { db, audit } = require("./db");

function createApi(client) {
  fs.mkdirSync(path.resolve(config.uploadDir), { recursive: true });
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: "100kb" }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

  const requireKey = (req, res, next) => {
    if (!config.apiKey || req.get("x-api-key") !== config.apiKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.resolve(config.uploadDir)),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 12)}`)
  });
  const upload = multer({
    storage,
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 }
  });

  app.get("/health", (_req, res) => res.json({
    ok: true, service: "elite-services-api", bot: client.isReady(),
    database: db.open ? "connected" : "disconnected",
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  }));
  app.get("/api/health", requireKey, (_req, res) => res.json({
    ok: true, bot: client.isReady(), guilds: client.guilds.cache.size,
    database: db.open ? "connected" : "disconnected",
    uptime_seconds: Math.floor(process.uptime()),
    memory: process.memoryUsage()
  }));
  app.get("/api/files", requireKey, (_req, res) => {
    const rows = db.prepare("SELECT id, original_name, mime_type, size_bytes, created_at FROM cdn_files ORDER BY id DESC LIMIT 100").all();
    res.json(rows.map(row => ({ ...row, url: `${config.publicCdnBaseUrl}/${db.prepare("SELECT stored_name FROM cdn_files WHERE id = ?").get(row.id).stored_name}` })));
  });
  app.post("/api/files", requireKey, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Multipart field 'file' is required" });
    const result = db.prepare("INSERT INTO cdn_files (stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?)")
      .run(req.file.filename, path.basename(req.file.originalname), req.file.mimetype, req.file.size);
    audit(null, "api", "cdn.upload", { fileId: result.lastInsertRowid, name: req.file.originalname });
    res.status(201).json({
      id: result.lastInsertRowid, name: path.basename(req.file.originalname),
      url: `${config.publicCdnBaseUrl}/${req.file.filename}`
    });
  });
  app.delete("/api/files/:id", requireKey, (req, res) => {
    const row = db.prepare("SELECT * FROM cdn_files WHERE id = ?").get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "File not found" });
    const filePath = path.join(path.resolve(config.uploadDir), row.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare("DELETE FROM cdn_files WHERE id = ?").run(row.id);
    audit(null, "api", "cdn.delete", { fileId: row.id });
    res.json({ ok: true });
  });
  app.get("/files/:storedName", (req, res) => {
    const row = db.prepare("SELECT * FROM cdn_files WHERE stored_name = ?").get(req.params.storedName);
    if (!row) return res.status(404).end();
    res.type(row.mime_type);
    res.sendFile(path.join(path.resolve(config.uploadDir), row.stored_name));
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    console.error("API error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
module.exports = createApi;
