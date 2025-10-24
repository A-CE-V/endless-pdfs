import express from "express";
import multer from "multer";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import fs from "fs";
import archiver from "archiver";
import { fromBuffer } from "pdf2pic";


const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// --------------------- MERGE PDFs ---------------------
app.post("/pdf/merge", upload.array("pdfs"), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2)
      return res.status(400).json({ error: "Upload at least 2 PDFs" });

    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdf = await PDFDocument.load(file.buffer);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(mergedBytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------- SPLIT PDF ---------------------
app.post("/pdf/split", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const pdf = await PDFDocument.load(req.file.buffer);
    const totalPages = pdf.getPageCount();

    // Parameter to split: either number of parts OR pages per part
    let parts = parseInt(req.body.parts) || 0; // total number of parts
    let pagesPerSplit = parseInt(req.body.pagesPerSplit) || 0; // pages per split

    if (!parts && !pagesPerSplit) pagesPerSplit = 1; // default: one page per split

    if (parts > 0) pagesPerSplit = Math.ceil(totalPages / parts);

    // Create zip archive in memory
    const archive = archiver("zip", { zlib: { level: 9 } });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="split.pdf.zip"`);

    archive.pipe(res);

    for (let i = 0; i < totalPages; i += pagesPerSplit) {
      const newPdf = await PDFDocument.create();
      const end = Math.min(i + pagesPerSplit, totalPages);
      const pagesToCopy = Array.from({ length: end - i }, (_, idx) => i + idx);
      const copiedPages = await newPdf.copyPages(pdf, pagesToCopy);
      copiedPages.forEach((page) => newPdf.addPage(page));

      const pdfBytes = await newPdf.save();
      archive.append(Buffer.from(pdfBytes), { name: `part_${i / pagesPerSplit + 1}.pdf` });
    }

    await archive.finalize(); // Finish zip
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- IMAGE → PDF ---------------------
app.post("/pdf/image-to-pdf", upload.array("images"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "Upload images" });

    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      const imgBuffer = await sharp(file.buffer).png().toBuffer();
      const image = await pdfDoc.embedPng(imgBuffer);
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------- PDF → IMAGE ---------------------
app.post("/pdf/pdf-to-image", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const format = (req.body.format || "png").toLowerCase(); // "png" or "jpeg"
    const dpi = parseInt(req.body.dpi) || 150; // optional resolution

    const options = {
      density: dpi,
      saveFilename: "page", // name template, not used
      savePath: "/tmp",      // required but we won’t save to disk
      format: format === "jpg" ? "jpeg" : format,
      width: 0,              // 0 = maintain original page width
      height: 0
    };

    const convert = fromBuffer(req.file.buffer, options);

    // Convert all pages
    const totalPages = 1; // You can extend to loop all pages
    const results = [];
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pageCount = pdfDoc.getPageCount();

    for (let i = 1; i <= pageCount; i++) {
      const pageResult = await convert(i);
      results.push(pageResult);
    }

    // If single page, return directly
    if (results.length === 1) {
      res.setHeader("Content-Type", `image/${format}`);
      res.send(results[0].base64 ? Buffer.from(results[0].base64, "base64") : results[0].path);
    } else {
      // Multiple pages → zip
      const archive = archiver("zip", { zlib: { level: 9 } });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="pdf-images.zip"`);
      archive.pipe(res);

      results.forEach((r, idx) => {
        const buffer = r.base64 ? Buffer.from(r.base64, "base64") : fs.readFileSync(r.path);
        archive.append(buffer, { name: `page_${idx + 1}.${format}` });
      });

      await archive.finalize();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- WATERMARK ---------------------
app.post("/pdf/watermark", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Provide watermark text" });

    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    pages.forEach((page) => {
      page.drawText(text, {
        x: 50,
        y: 50,
        size: 50,
        font,
        color: rgb(0.75, 0.75, 0.75),
        rotate: { type: "degrees", angle: 45 },
        opacity: 0.3,
      });
    });

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------- METADATA ---------------------
app.post("/pdf/metadata", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const { title, author, subject } = req.body;

    if (title) pdfDoc.setTitle(title);
    if (author) pdfDoc.setAuthor(author);
    if (subject) pdfDoc.setSubject(subject);

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
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
