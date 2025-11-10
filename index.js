import express from "express";
import multer from "multer";
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import fs from "fs";
import archiver from "archiver";
import {fromBuffer} from "pdf2pic";


import { addEndlessForgeMetadata } from "./utils/pdfMetadata.js";
import { verifyApiKey } from "./shared/apiKeyMiddleware.js";
import { enforceLimit } from "./shared/rateLimit.js";
import { priorityMiddleware } from "./shared/priorityQueue.js";
import resetRouter from "./jobs/resetDailyLimit.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
// --------------------- MERGE PDFs ---------------------
app.post(
  "/pdf/merge",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "conversion"),
  upload.array("pdfs"),
  async (req, res) => {

  try {
    if (!req.files || req.files.length < 2)
      return res.status(400).json({ error: "Upload at least 2 PDFs" });

      const mergedPdf = await PDFDocument.create();
      for (const file of req.files) {
        const pdf = await PDFDocument.load(file.buffer);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((page) => mergedPdf.addPage(page));
      }
      
      await addEndlessForgeMetadata(mergedPdf);
      const mergedBytes = await mergedPdf.save();

      res.type("application/pdf");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="merged.pdf"`);
      res.send(Buffer.from(mergedBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- SPLIT PDF ---------------------
app.post(
  "/pdf/split",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "conversion"),
  upload.single("pdf"),
  async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const pdf = await PDFDocument.load(req.file.buffer);
    const totalPages = pdf.getPageCount();

    let parts = parseInt(req.body.parts) || 0; // total number of parts
    let pagesPerSplit = parseInt(req.body.pagesPerSplit) || 0; // pages per split
    if (!parts && !pagesPerSplit) pagesPerSplit = 1;
    if (parts > 0) pagesPerSplit = Math.ceil(totalPages / parts);

    const archive = archiver("zip", { zlib: { level: 9 } });
    const originalName = req.file.originalname.replace(/\.[^/.]+$/, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${originalName}-by-parts.zip"`);
    archive.pipe(res);

    for (let i = 0; i < totalPages; i += pagesPerSplit) {
      const newPdf = await PDFDocument.create();
      const end = Math.min(i + pagesPerSplit, totalPages);
      const pagesToCopy = Array.from({ length: end - i }, (_, idx) => i + idx);
      const copiedPages = await newPdf.copyPages(pdf, pagesToCopy);
      copiedPages.forEach((page) => newPdf.addPage(page));
      await addEndlessForgeMetadata(newPdf);
      const pdfBytes = await newPdf.save();
      archive.append(Buffer.from(pdfBytes), { name: `part_${i / pagesPerSplit + 1}.pdf` });
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- IMAGE → PDF ---------------------
app.post(
  "/pdf/image-to-pdf",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "conversion"),
  upload.array("images"),
  async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "Upload images" });

    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      let image, dims;

      if (file.mimetype.includes("png")) {
        const pngBuffer = await sharp(file.buffer).png().toBuffer();
        image = await pdfDoc.embedPng(pngBuffer);
        dims = { width: image.width, height: image.height };
      } else {
        const jpegBuffer = await sharp(file.buffer).jpeg().toBuffer();
        image = await pdfDoc.embedJpg(jpegBuffer);
        dims = { width: image.width, height: image.height };
      }

      const page = pdfDoc.addPage([dims.width, dims.height]);
      page.drawImage(image, { x: 0, y: 0, width: dims.width, height: dims.height });
    }
    await addEndlessForgeMetadata(pdfDoc);
    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="images.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- PDF → IMAGE ---------------------
app.post(
  "/pdf/pdf-to-image",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "conversion"),
  upload.single("pdf"),
  async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const format = (req.body.format || "png").toLowerCase();
    const dpi = parseInt(req.body.dpi) || 150;

    const options = {
      density: dpi,
      format: format === "jpg" ? "jpeg" : format,
      width: 0,
      height: 0,
      saveFilename: "page",
      savePath: "./output" // safer path for Windows
    };

    // Load the converter
    const converter = fromBuffer(req.file.buffer, options);

    // Get number of pages
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pageCount = pdfDoc.getPageCount();
    const results = [];

    // Generate images
    for (let i = 1; i <= pageCount; i++) {
      const result = await converter(i, { responseType: "base64" });
      results.push(result);
    }

    // Send images or ZIP
    if (results.length === 1) {
      const img = results[0];
      const base64Data = img.base64;
      res.setHeader("Content-Type", `image/${format}`);
      res.setHeader("Content-Disposition", `attachment; filename="page1.${format}"`);
      res.send(Buffer.from(base64Data, "base64"));
    } else {
      const archive = archiver("zip", { zlib: { level: 9 } });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${req.file.originalname}-pages.zip"`);
      archive.pipe(res);

      results.forEach((img, i) => {
        const base64Data = img.base64;
        archive.append(Buffer.from(base64Data, "base64"), { name: `page_${i + 1}.${format}` });
      });

      await archive.finalize();
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// --------------------- ADVANCED WATERMARK ---------------------
const uploadFields = upload.fields([
  { name: "pdf", maxCount: 1 },
  { name: "image", maxCount: 1 },
]);

app.post(
  "/pdf/watermark",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "editor"),
  uploadFields,
  async (req, res) => {
  try {
    const pdfFile = req.files?.pdf?.[0];
    const imageFile = req.files?.image?.[0];

    if (!pdfFile)
      return res.status(400).json({ error: "Upload a PDF file under field 'pdf'" });

    const {
      text,
      image, // base64 or URL (optional)
      size = 50,
      color = "#cccccc",
      position = "center", // top-left, top-right, bottom-left, bottom-right, center
      scale = 1,
      shadow = false,
      degrees = 45, // rotation angle in degrees
    } = req.body;

    if (!text && !image && !imageFile)
      return res
        .status(400)
        .json({ error: "Provide either watermark text or image" });

    const pdfDoc = await PDFDocument.load(pdfFile.buffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const rawOpacity = parseFloat(req.body.opacity);
    const opacity = isNaN(rawOpacity)
      ? 0.3
      : Math.min(Math.max(rawOpacity, 0), 1);
    const rotationAngle = parseFloat(degrees) || 0;

    // Convert hex color to rgb(0–1)
    const hexToRgb = (hex) => {
      const bigint = parseInt(hex.replace("#", ""), 16);
      const r = ((bigint >> 16) & 255) / 255;
      const g = ((bigint >> 8) & 255) / 255;
      const b = (bigint & 255) / 255;
      return rgb(r, g, b);
    };

    // Optional: embed image
    let embeddedImg = null;

    if (imageFile) {
      // Uploaded file
      const buffer = imageFile.buffer;
      if (imageFile.mimetype.includes("png"))
        embeddedImg = await pdfDoc.embedPng(buffer);
      else embeddedImg = await pdfDoc.embedJpg(buffer);
    } else if (image) {
      // Base64 or URL
      let imgBuffer;
      if (image.startsWith("data:image")) {
        const base64Data = image.split(",")[1];
        imgBuffer = Buffer.from(base64Data, "base64");
      } else if (image.startsWith("http")) {
        const response = await fetch(image);
        imgBuffer = Buffer.from(await response.arrayBuffer());
      }

      if (imgBuffer) {
        if (image.includes("png"))
          embeddedImg = await pdfDoc.embedPng(imgBuffer);
        else embeddedImg = await pdfDoc.embedJpg(imgBuffer);
      }
    }

    // Add watermark to all pages
    pages.forEach((page) => {
      const { width, height } = page.getSize();
      let x = width / 2;
      let y = height / 2;

      // Positioning logic
      const margin = 30;
      switch (position) {
        case "top-left":
          x = margin;
          y = height - margin;
          break;
        case "top-right":
          x = width - margin;
          y = height - margin;
          break;
        case "bottom-left":
          x = margin;
          y = margin;
          break;
        case "bottom-right":
          x = width - margin;
          y = margin;
          break;
        case "center":
        default:
          x = width / 2;
          y = height / 2;
      }

      // Draw text watermark
      if (text) {
        if (shadow) {
          page.drawText(text, {
            x: x - size / 2 + 2,
            y: y - size / 2 - 2,
            size: parseInt(size),
            font,
            color: rgb(0, 0, 0),
            opacity: opacity * 0.5,
            rotate: { type: "degrees", angle: rotationAngle },
          });
        }

        page.drawText(text, {
          x: x - size / 2,
          y: y - size / 2,
          size: parseInt(size),
          font,
          color: hexToRgb(color),
          rotate: { type: "degrees", angle: rotationAngle },
          opacity: parseFloat(opacity),
        });
      }

      // Draw image watermark
      if (embeddedImg) {
        const imgWidth = embeddedImg.width * scale;
        const imgHeight = embeddedImg.height * scale;
        page.drawImage(embeddedImg, {
          x: x - imgWidth / 2,
          y: y - imgHeight / 2,
          width: imgWidth,
          height: imgHeight,
          opacity: parseFloat(opacity),
          rotate: { type: "degrees", angle: rotationAngle },
        });
      }
    });

    await addEndlessForgeMetadata(pdfDoc);

    const pdfBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="watermarked.pdf"`
    );
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Watermark error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- GET METADATA (ADVANCED + SAFE) ---------------------
app.post(
  "/pdf/metadata/get",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "editor"),
  upload.single("pdf"),
  async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "Please upload a PDF file." });

    const pdfBuffer = req.file.buffer;
    const pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });

    // Safely read Info dictionary
    const trailer = pdfDoc.context.trailer;
    let infoDict = null;
    try {
      const infoRef = trailer.get(PDFName.of("Info"));
      if (infoRef) {
        const lookup = pdfDoc.context.lookup(infoRef);
        // Some PDFs return a Dict, some a Ref; verify it's usable
        if (lookup && typeof lookup.get === "function") {
          infoDict = lookup;
        }
      }
    } catch {
      infoDict = null;
    }

    const safeGet = (key) => {
      if (!infoDict || typeof infoDict.get !== "function") return null;
      const val = infoDict.get(PDFName.of(key));
      if (!val) return null;
      try {
        if (val.decodeText) return val.decodeText();
        return String(val);
      } catch {
        return String(val);
      }
    };

    // Parse PDF date format (D:YYYYMMDDHHmmSS)
    const parsePdfDate = (str) => {
      if (!str || typeof str !== "string") return null;
      const match = str.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (!match) return null;
      const [_, y, m, d, h, min, s] = match.map(Number);
      return new Date(Date.UTC(y, m - 1, d, h, min, s)).toISOString();
    };

    // Core metadata
    const metadata = {
      title: pdfDoc.getTitle() || safeGet("Title"),
      author: pdfDoc.getAuthor() || safeGet("Author"),
      subject: pdfDoc.getSubject() || safeGet("Subject"),
      keywords: pdfDoc.getKeywords() || safeGet("Keywords"),
      creator: pdfDoc.getCreator() || safeGet("Creator"),
      producer: pdfDoc.getProducer() || safeGet("Producer"),
      creationDate:
        parsePdfDate(safeGet("CreationDate")) ||
        pdfDoc.getCreationDate()?.toISOString() ||
        null,
      modificationDate:
        parsePdfDate(safeGet("ModDate")) ||
        pdfDoc.getModificationDate()?.toISOString() ||
        null,
    };

    // Custom / extra fields
    const customFields = {
      company: safeGet("Company"),
      manager: safeGet("Manager"),
      sourceModified: safeGet("SourceModified"),
      category: safeGet("Category"),
      comments: safeGet("Comments"),
    };

    // Technical info
    const pages = pdfDoc.getPages();
    const firstPage = pages[0]?.getSize();
    const technical = {
      pageCount: pages.length,
      fileSizeKB: (pdfBuffer.length / 1024).toFixed(2),
      pdfVersion: pdfDoc.context.headerVersion || "Unknown",
      pageSize: firstPage
        ? `${firstPage.width.toFixed(2)}x${firstPage.height.toFixed(2)}`
        : "Unknown",
    };

    const result = {
      metadata: Object.fromEntries(
        Object.entries(metadata).filter(([_, v]) => v)
      ),
      customFields: Object.fromEntries(
        Object.entries(customFields).filter(([_, v]) => v)
      ),
      technical,
    };

    res.json(result);
  } catch (err) {
    console.error("Metadata read error:", err);
    res.status(500).json({ error: err.message });
  }
});



// --------------------- SET / EDIT METADATA ---------------------
app.post(
  "/pdf/metadata/set",
  verifyApiKey,
  priorityMiddleware,
  (req, res, next) => enforceLimit(req, res, next, "editor"),
  upload.single("pdf"),
  async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const {
      title,
      author,
      subject,
      keywords,
      creator,
      producer,
      creationDate,
      modDate,
    } = req.body;

    // --- Apply new metadata fields if provided ---
    if (title) pdfDoc.setTitle(title);
    if (author) pdfDoc.setAuthor(author);
    if (subject) pdfDoc.setSubject(subject);
    if (keywords) pdfDoc.setKeywords(keywords.split(",").map(k => k.trim()));
    if (creator) pdfDoc.setCreator(creator);
    if (producer) pdfDoc.setProducer(producer);
    if (creationDate) pdfDoc.setCreationDate(new Date(creationDate));
    if (modDate) pdfDoc.setModificationDate(new Date(modDate));

    const pdfBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="metadata-updated.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Metadata edit error:", err);
    res.status(500).json({ error: err.message });
  }
});


// --------------------- HEALTH CHECK ---------------------
app.get("/health", (req, res) => {
  res.send({ status: "OK", uptime: process.uptime() });
});

// --------------------- START SERVER ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF API running on port ${PORT}`));
