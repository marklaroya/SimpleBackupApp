const express = require("express");

//call the API
const cors = require("cors");
// for file uploads
const multer = require("multer");

// for the path folder
const path = require("path");
const fs = require("fs");

require("dotenv").config();


const app = express();
app.use(cors());

//for what path it should go
const UPLOAD_DIR = process.env.UPLOAD_DIR; // file system path kung san pupunta yung uploaded files sa disk ng server
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/files", express.static(UPLOAD_DIR));


const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, ""); // para ma remove ang char ex: file upload name: LS Ad to LSAD
    cb(null, `${Date.now()}-${safe}`); // para ma log yung time kung kaylan na upload
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2gb max upload lang
});

// now for routes uploading Multi file
app.post("/upload", upload.array("Files", 3), (req, res) => {
  try {
    if (!req.file || req.files.length === 0 ) {
      return res.status(400).json({ message: "No file inserted" });
    }

    const files = req.files.map((f) => ({
        filename: f.filename,
        originalname: f.originalname,
        size: f.size,
        url: `/files/${f.filename}`, // 
    }));

    res.status(200).json({
      message: "File uploaded successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});
