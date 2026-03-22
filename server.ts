import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import webpush from "web-push";
import admin from "firebase-admin";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// Initialize Firebase Admin
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(), // This might need adjustment based on environment
    projectId: firebaseConfig.projectId,
  });
}
const db = admin.firestore();

// VAPID keys should be generated once and kept secret.
// For this environment, we'll generate them if not provided.
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  const generated = webpush.generateVAPIDKeys();
  vapidKeys = generated;
  console.log("Generated VAPID Keys (Save these to your .env):");
  console.log("VAPID_PUBLIC_KEY=" + generated.publicKey);
  console.log("VAPID_PRIVATE_KEY=" + generated.privateKey);
}

webpush.setVapidDetails(
  "mailto:example@yourdomain.com",
  vapidKeys.publicKey!,
  vapidKeys.privateKey!
);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API: Get VAPID Public Key
  app.get("/api/vapid-public-key", (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  // API: Save Push Subscription
  app.post("/api/save-subscription", async (req, res) => {
    const { subscription, userId } = req.body;
    if (!subscription || !userId) {
      return res.status(400).json({ error: "Missing subscription or userId" });
    }

    try {
      await db.collection("push_subscriptions").doc(userId).set({
        subscription,
        userId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving subscription:", error);
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  // Periodic Background Check (Every 5 minutes)
  const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  setInterval(async () => {
    console.log("Running periodic background check for incomplete tasks...");
    try {
      const now = new Date();
      const today = now.toISOString().split("T")[0];
      const subscriptionsSnapshot = await db.collection("push_subscriptions").get();
      
      for (const subDoc of subscriptionsSnapshot.docs) {
        const data = subDoc.data();
        const { subscription, userId, notificationInterval, lastNotifiedAt } = data;
        
        // Default interval is 180 minutes (3 hours)
        const intervalMinutes = notificationInterval || 180;
        const intervalMs = intervalMinutes * 60 * 1000;
        
        const lastNotified = lastNotifiedAt ? lastNotifiedAt.toDate() : new Date(0);
        
        // Check if enough time has passed since the last notification
        if (now.getTime() - lastNotified.getTime() >= intervalMs) {
          // Check for incomplete tasks for this user on today's date
          const eventsSnapshot = await db.collection("events")
            .where("userId", "==", userId)
            .where("date", "==", today)
            .where("completed", "==", false)
            .get();
          
          const pendingCount = eventsSnapshot.size;
          if (pendingCount > 0) {
            const payload = JSON.stringify({
              title: "오늘의 일정을 확인하세요!",
              body: `아직 완료하지 않은 일정이 ${pendingCount}개 있습니다.`,
            });

            try {
              await webpush.sendNotification(subscription, payload);
              console.log(`Sent notification to user ${userId}`);
              
              // Update lastNotifiedAt
              await db.collection("push_subscriptions").doc(userId).update({
                lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            } catch (error) {
              console.error(`Error sending notification to user ${userId}:`, error);
              // If subscription is expired, remove it
              if ((error as any).statusCode === 410) {
                await db.collection("push_subscriptions").doc(userId).delete();
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Error in periodic check:", error);
    }
  }, CHECK_INTERVAL);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
