import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import dotenv from "dotenv";

dotenv.config();

// Determine which AI provider to use
const AI_PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "auto";
const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
const hasGeminiKey = !!process.env.GEMINI_API_KEY;

// Auto-detect provider if not specified
function getActiveProvider() {
  if (AI_PROVIDER === "anthropic" && hasAnthropicKey) return "anthropic";
  if (AI_PROVIDER === "gemini" && hasGeminiKey) return "gemini";
  if (AI_PROVIDER === "auto") {
    if (hasAnthropicKey) return "anthropic";
    if (hasGeminiKey) return "gemini";
  }
  return null;
}

const activeProvider = getActiveProvider();

// Configuration
const CONFIG = {
  // Add group IDs to monitor (get these from logs when bot joins)
  // Leave empty to monitor ALL groups you're admin of
  monitoredGroups: process.env.MONITORED_GROUPS?.split(",").filter(Boolean) || [],

  // API keys (optional - enables AI detection)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,

  // Active AI provider
  aiProvider: activeProvider,

  // Whether to actually delete messages or just log (for testing)
  dryRun: process.env.DRY_RUN === "true",

  // Custom spam criteria (optional - enhances detection)
  customSpamKeywords: process.env.SPAM_KEYWORDS?.split(",").filter(Boolean) || [],

  // Enable/disable AI detection (auto-disabled if no API key)
  useAI: process.env.USE_AI !== "false" && !!activeProvider,
};

// Initialize AI clients based on provider
let anthropic = null;
let gemini = null;

if (CONFIG.aiProvider === "anthropic" && CONFIG.anthropicApiKey) {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  anthropic = new Anthropic({
    apiKey: CONFIG.anthropicApiKey,
  });
}

if (CONFIG.aiProvider === "gemini" && CONFIG.geminiApiKey) {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  gemini = new GoogleGenerativeAI(CONFIG.geminiApiKey);
}

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

// Spam patterns for rule-based detection (works without AI)
const SPAM_PATTERNS = {
  // WhatsApp group invite link pattern
  groupInviteRegex: /chat\.whatsapp\.com\/[A-Za-z0-9]{20,}/gi,

  // Suspicious keywords that indicate spam group invites
  spamGroupKeywords: [
    // Trading/Forex
    "trading", "forex", "fx signal", "trade signal", "pip", "lot size",
    "forex vip", "trading vip", "profit signal", "free signal",
    // Crypto
    "crypto", "bitcoin", "btc", "eth", "binance", "coinbase", "nft",
    "token", "airdrop", "pump", "moonshot", "100x", "1000x",
    "crypto vip", "bitcoin signal", "crypto signal",
    // Investment scams
    "investment", "invest now", "guaranteed profit", "daily profit",
    "passive income", "financial freedom", "get rich", "make money",
    "earn money", "income opportunity", "profit guaranteed",
    // Training/Course scams
    "training", "course", "masterclass", "webinar", "free class",
    "learn trading", "trading course", "forex course", "crypto course",
    "mentorship", "coaching", "academy",
    // MLM/Pyramid
    "mlm", "network marketing", "referral bonus", "join my team",
    "business opportunity", "work from home", "be your own boss",
    // Gambling
    "betting", "casino", "gambling", "slot", "jackpot", "lucky draw",
    // Adult/Dating
    "dating", "singles", "hookup", "adult", "18+",
  ],

  // High-confidence spam phrases (instant delete)
  highConfidenceSpam: [
    "join my trading group",
    "join my crypto group",
    "join my forex group",
    "vip signal group",
    "free trading signals",
    "guaranteed returns",
    "double your money",
    "100% profit",
    "join and earn",
    "click link to join",
  ],
};

/**
 * Rule-based spam detection for group invite links
 * Works without AI - detects trading/crypto/training group invites
 */
function detectSpamGroupInvite(message) {
  const lowerMessage = message.toLowerCase();

  // Check if message contains a WhatsApp group invite link
  const hasGroupInvite = SPAM_PATTERNS.groupInviteRegex.test(message);
  // Reset regex lastIndex
  SPAM_PATTERNS.groupInviteRegex.lastIndex = 0;

  // Check for high-confidence spam phrases first
  for (const phrase of SPAM_PATTERNS.highConfidenceSpam) {
    if (lowerMessage.includes(phrase)) {
      return {
        isSpam: true,
        confidence: 95,
        reason: `High-confidence spam phrase: "${phrase}"`,
      };
    }
  }

  // If there's a group invite link, check for suspicious keywords
  if (hasGroupInvite) {
    const matchedKeywords = SPAM_PATTERNS.spamGroupKeywords.filter(
      keyword => lowerMessage.includes(keyword.toLowerCase())
    );

    if (matchedKeywords.length >= 2) {
      return {
        isSpam: true,
        confidence: 90,
        reason: `Group invite with spam keywords: ${matchedKeywords.slice(0, 3).join(", ")}`,
      };
    }

    if (matchedKeywords.length === 1) {
      return {
        isSpam: true,
        confidence: 75,
        reason: `Group invite with suspicious keyword: ${matchedKeywords[0]}`,
      };
    }
  }

  // Check for suspicious keyword combinations even without group link
  const matchedKeywords = SPAM_PATTERNS.spamGroupKeywords.filter(
    keyword => lowerMessage.includes(keyword.toLowerCase())
  );

  if (matchedKeywords.length >= 3) {
    return {
      isSpam: true,
      confidence: 80,
      reason: `Multiple spam indicators: ${matchedKeywords.slice(0, 3).join(", ")}`,
    };
  }

  return { isSpam: false, confidence: 0, reason: "No spam patterns detected" };
}

// Shared spam detection prompt
const SPAM_DETECTION_PROMPT = (groupName, senderName, message) => `You are a spam detection system for a WhatsApp group. Analyze this message and determine if it's spam.

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
{"isSpam": true/false, "confidence": 0-100, "reason": "brief explanation"}`;

/**
 * AI spam detection using Anthropic Claude
 */
async function detectWithAnthropic(message, senderName, groupName) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20250929",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: SPAM_DETECTION_PROMPT(groupName, senderName, message),
      },
    ],
  });
  return response.content[0].text.trim();
}

/**
 * AI spam detection using Google Gemini
 */
async function detectWithGemini(message, senderName, groupName) {
  const model = gemini.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(SPAM_DETECTION_PROMPT(groupName, senderName, message));
  return result.response.text().trim();
}

/**
 * Main spam detection function
 * Uses rule-based detection first, then AI if available
 */
async function isSpamMessage(message, senderName, groupName) {
  const lowerMessage = message.toLowerCase();

  // 1. Check custom keywords first (fastest)
  for (const keyword of CONFIG.customSpamKeywords) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return { isSpam: true, confidence: 100, reason: `Contains blocked keyword: ${keyword}` };
    }
  }

  // 2. Rule-based detection for group invites (works without AI)
  const ruleBasedResult = detectSpamGroupInvite(message);
  if (ruleBasedResult.isSpam) {
    return ruleBasedResult;
  }

  // 3. If AI is not available, return rule-based result
  if (!CONFIG.useAI || (!anthropic && !gemini)) {
    return ruleBasedResult;
  }

  // 4. AI-powered detection (if API key available)
  // Rate limiting for AI calls
  if (checksThisMinute >= MAX_CHECKS_PER_MINUTE) {
    console.log("⚠️  Rate limit reached, skipping AI check");
    return { isSpam: false, confidence: 0, reason: "Rate limited - using rule-based only" };
  }
  checksThisMinute++;

  try {
    let content;

    // Use the configured AI provider
    if (CONFIG.aiProvider === "anthropic" && anthropic) {
      content = await detectWithAnthropic(message, senderName, groupName);
    } else if (CONFIG.aiProvider === "gemini" && gemini) {
      content = await detectWithGemini(message, senderName, groupName);
    } else {
      return ruleBasedResult;
    }

    // Parse JSON response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Failed to find JSON in AI response:", content);
      return { isSpam: false, confidence: 0, reason: "Parse error" };
    }

    try {
      const result = JSON.parse(jsonMatch[0]);
      return {
        isSpam: result.isSpam && result.confidence >= 70,
        reason: result.reason,
        confidence: result.confidence,
      };
    } catch {
      console.error("Failed to parse AI response:", content);
      return { isSpam: false, confidence: 0, reason: "Parse error" };
    }
  } catch (error) {
    console.error("AI detection error:", error.message);
    return { isSpam: false, confidence: 0, reason: "API error" };
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
      console.log(`🚨 SPAM DETECTED${spamCheck.confidence ? ` (${spamCheck.confidence}%)` : ""}: ${spamCheck.reason}`);

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

  // Show detection mode with provider name
  let detectionMode = "Rule-based only (no API key)";
  if (CONFIG.useAI && CONFIG.aiProvider) {
    const providerNames = { anthropic: "Claude", gemini: "Gemini" };
    detectionMode = `${providerNames[CONFIG.aiProvider] || CONFIG.aiProvider} AI + Rule-based`;
  }
  console.log(`🤖 Detection: ${detectionMode}`);
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
