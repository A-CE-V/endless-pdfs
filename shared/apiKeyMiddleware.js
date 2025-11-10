import { db } from "./firebaseAdmin.js";

export async function verifyApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const usersRef = db.collection("users");
  const snapshot = await usersRef.where("api.key", "==", apiKey).limit(1).get();

  if (snapshot.empty) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  const userDoc = snapshot.docs[0];
  req.user = { id: userDoc.id, ...userDoc.data() };
  next();
}
