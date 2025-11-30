import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

// Configuration
const CONFIG = {
  // Add group IDs to monitor (get these from logs when bot joins)
  // Leave empty to monitor ALL groups you're admin of
  monitoredGroups: process.env.MONITORED_GROUPS?.split(",").filter(Boolean) || [],

  // Anthropic API key
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  // Whether to actually delete messages or just log (for testing)
  dryRun: process.env.DRY_RUN === "true",

  // Custom spam criteria (optional - enhances AI detection)
  customSpamKeywords: process.env.SPAM_KEYWORDS?.split(",").filter(Boolean) || [],
};

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: CONFIG.anthropicApiKey,
});

// Initialize WhatsApp client with local session storage
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./whatsapp-session",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
});

// Store for rate limiting and tracking
const messageCache = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_CHECKS_PER_MINUTE = 30;
let checksThisMinute = 0;

// Reset rate limit counter every minute
setInterval(() => {
  checksThisMinute = 0;
}, RATE_LIMIT_WINDOW);

/**
 * Detect spam using Claude Haiku
 */
async function isSpamMessage(message, senderName, groupName) {
  // Rate limiting
  if (checksThisMinute >= MAX_CHECKS_PER_MINUTE) {
    console.log("⚠️  Rate limit reached, skipping AI check");
    return { isSpam: false, reason: "Rate limited" };
  }
  checksThisMinute++;

  // Quick keyword pre-filter (saves API calls)
  const lowerMessage = message.toLowerCase();
  for (const keyword of CONFIG.customSpamKeywords) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return { isSpam: true, reason: `Contains blocked keyword: ${keyword}` };
    }
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20250929",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `You are a spam detection system for a WhatsApp group. Analyze this message and determine if it's spam.

SPAM indicators:
- Unsolicited promotions, ads, or marketing
- Crypto/forex/investment scams
- "Get rich quick" schemes
- Phishing or suspicious links
- Repeated/flooding messages
- Adult content promotions
- Fake giveaways or prizes
- Requests for personal/financial info
- Pyramid schemes or MLM recruitment

NOT spam:
- Normal conversations
- Questions and answers
- Sharing relevant links
- Announcements from admins
- Friendly banter

Group: ${groupName}
Sender: ${senderName}
Message: "${message}"

Respond with ONLY a JSON object (no markdown):
{"isSpam": true/false, "confidence": 0-100, "reason": "brief explanation"}`,
        },
      ],
    });

    const content = response.content[0].text.trim();

    // Parse JSON response
    try {
      const result = JSON.parse(content);
      return {
        isSpam: result.isSpam && result.confidence >= 70,
        reason: result.reason,
        confidence: result.confidence,
      };
    } catch {
      console.error("Failed to parse AI response:", content);
      return { isSpam: false, reason: "Parse error" };
    }
  } catch (error) {
    console.error("AI detection error:", error.message);
    return { isSpam: false, reason: "API error" };
  }
}

/**
 * Check if bot is admin in the group
 */
async function isBotAdmin(chat) {
  try {
    const participants = await chat.participants;
    const botNumber = client.info.wid._serialized;
    const botParticipant = participants.find(
      (p) => p.id._serialized === botNumber
    );
    return botParticipant?.isAdmin || botParticipant?.isSuperAdmin || false;
  } catch {
    return false;
  }
}

/**
 * Handle incoming messages
 */
async function handleMessage(message) {
  try {
    // Only process group messages
    const chat = await message.getChat();
    if (!chat.isGroup) return;

    // Check if we should monitor this group
    if (
      CONFIG.monitoredGroups.length > 0 &&
      !CONFIG.monitoredGroups.includes(chat.id._serialized)
    ) {
      return;
    }

    // Skip messages from self
    if (message.fromMe) return;

    // Skip non-text messages for now
    if (!message.body || message.body.trim() === "") return;

    // Get sender info (using message properties to avoid getContact() compatibility issues)
    const senderId = message.author || message.from;
    const senderName = message._data?.notifyName || senderId?.split("@")[0] || "Unknown";

    console.log(`\n📨 [${chat.name}] ${senderName}: ${message.body.substring(0, 50)}...`);

    // Check for spam
    const spamCheck = await isSpamMessage(message.body, senderName, chat.name);

    if (spamCheck.isSpam) {
      console.log(`🚨 SPAM DETECTED (${spamCheck.confidence}%): ${spamCheck.reason}`);

      // Verify we're admin before attempting delete
      const isAdmin = await isBotAdmin(chat);

      if (!isAdmin) {
        console.log("⚠️  Cannot delete: Bot is not admin in this group");
        return;
      }

      if (CONFIG.dryRun) {
        console.log("🔸 DRY RUN: Would delete this message");
      } else {
        try {
          await message.delete(true); // true = delete for everyone
          console.log("✅ Message deleted for everyone");

          // Optional: Send notification to group
          // await chat.sendMessage(`⚠️ Spam message from ${senderName} was removed.`);
        } catch (deleteError) {
          console.error("❌ Failed to delete:", deleteError.message);
        }
      }
    } else {
      console.log(`✅ OK: ${spamCheck.reason}`);
    }
  } catch (error) {
    console.error("Error handling message:", error);
  }
}

// Event handlers
client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code with WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("✅ Authenticated successfully");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
});

client.on("ready", async () => {
  console.log("\n🚀 WhatsApp Spam Guard is ready!");
  console.log(`📋 Mode: ${CONFIG.dryRun ? "DRY RUN (no deletions)" : "LIVE (will delete spam)"}`);
  console.log(`🔑 Bot number: ${client.info.wid.user}`);

  // List all groups
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);

  console.log(`\n📊 Found ${groups.length} groups:`);
  for (const group of groups) {
    const isAdmin = await isBotAdmin(group);
    const monitoring = CONFIG.monitoredGroups.length === 0 ||
                       CONFIG.monitoredGroups.includes(group.id._serialized);
    console.log(`  ${monitoring ? "👁️" : "  "} ${isAdmin ? "👑" : "  "} ${group.name} (${group.id._serialized})`);
  }
  console.log("\n👁️ = Monitoring | 👑 = Admin\n");
});

client.on("message_create", handleMessage);

client.on("disconnected", (reason) => {
  console.log("❌ Client disconnected:", reason);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down...");
  await client.destroy();
  process.exit(0);
});

// Start the client
console.log("🔄 Initializing WhatsApp Spam Guard...");
client.initialize();
