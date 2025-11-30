# WhatsApp Spam Filter

An intelligent spam detection and auto-moderation bot for WhatsApp groups, powered by Claude AI.

## Overview

This application connects to WhatsApp Web and monitors group messages in real-time. When a message is detected as spam using Claude Haiku's AI analysis, the bot automatically deletes it (if the bot account is a group admin).

### Key Features

- **AI-Powered Detection**: Supports Claude (Anthropic) or Gemini (Google) for intelligent spam classification
- **Rule-Based Detection**: Works without API key - catches trading/crypto/training group invites
- **Real-time Monitoring**: Listens to all group messages via WhatsApp Web
- **Auto-deletion**: Removes spam messages for everyone (requires admin privileges)
- **Keyword Pre-filtering**: Fast detection for known spam terms (saves API costs)
- **Rate Limiting**: Prevents excessive API calls (30 checks/minute default)
- **Dry Run Mode**: Test the system without actually deleting messages
- **Session Persistence**: Scan QR code once, stays authenticated

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WhatsApp Spam Filter                         │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         index.js (Main App)                         │
│  ┌───────────────┐  ┌──────────────────┐  ┌─────────────────────┐  │
│  │ WhatsApp      │  │ Message Handler  │  │ Spam Detection      │  │
│  │ Client        │  │                  │  │ Engine              │  │
│  │ (wwebjs)      │──│ • Filter groups  │──│ • Keyword filter    │  │
│  │               │  │ • Check admin    │  │ • Claude AI check   │  │
│  │ • QR Auth     │  │ • Route messages │  │ • Confidence score  │  │
│  │ • Session     │  │                  │  │                     │  │
│  └───────────────┘  └──────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
         │                      │                       │
         ▼                      ▼                       ▼
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────┐
│  WhatsApp Web   │  │  Local Storage   │  │    Anthropic API        │
│  (Puppeteer)    │  │  (Session Data)  │  │    (Claude Haiku)       │
│                 │  │                  │  │                         │
│  • Headless     │  │  ./whatsapp-     │  │  • Spam classification  │
│    Chrome       │  │    session/      │  │  • Confidence scoring   │
│  • WebSocket    │  │                  │  │  • Reason explanation   │
└─────────────────┘  └──────────────────┘  └─────────────────────────┘
```

### Data Flow

```
┌──────────┐    ┌──────────────┐    ┌─────────────┐    ┌────────────┐
│ WhatsApp │───▶│ Message      │───▶│ Spam Check  │───▶│ Delete if  │
│ Group    │    │ Received     │    │ (AI/Keyword)│    │ Spam       │
└──────────┘    └──────────────┘    └─────────────┘    └────────────┘
                       │                   │
                       ▼                   ▼
                ┌──────────────┐    ┌─────────────┐
                │ Skip if:     │    │ Claude      │
                │ • Own msg    │    │ Haiku API   │
                │ • Not group  │    │             │
                │ • Not admin  │    │ Returns:    │
                └──────────────┘    │ • isSpam    │
                                    │ • confidence│
                                    │ • reason    │
                                    └─────────────┘
```

### Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp Client | whatsapp-web.js | Connects to WhatsApp via Puppeteer |
| AI Engine | Claude Haiku 4.5 | Intelligent spam classification |
| Session Storage | LocalAuth | Persists login between restarts |
| QR Display | qrcode-terminal | Shows QR code for authentication |

## Prerequisites

- Node.js 18 or higher
- Anthropic API key ([get one here](https://console.anthropic.com/))
- WhatsApp account with admin access to target groups

## Installation

### Local Setup

```bash
# Clone the repository
git clone https://github.com/alinaqi/whatsapp-spam-filter.git
cd whatsapp-spam-filter

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | - | Anthropic API key for Claude AI |
| `GEMINI_API_KEY` | No | - | Google API key for Gemini AI ([free tier](https://ai.google.dev/)) |
| `AI_PROVIDER` | No | `auto` | AI provider: `anthropic`, `gemini`, or `auto` |
| `DRY_RUN` | No | `true` | Set to `false` to enable message deletion |
| `USE_AI` | No | `true` | Set to `false` to use only rule-based detection |
| `MONITORED_GROUPS` | No | (all) | Comma-separated group IDs to monitor |
| `SPAM_KEYWORDS` | No | (preset) | Comma-separated keywords for quick detection |

## Usage

### Starting the Bot

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### First Run

1. A QR code will appear in your terminal
2. Open WhatsApp on your phone
3. Go to **Settings > Linked Devices > Link a Device**
4. Scan the QR code
5. The bot will list all your groups and indicate:
   - Which groups are being monitored
   - Which groups you have admin rights in

### Console Output

```
🔄 Initializing WhatsApp Spam Guard...
📱 Scan this QR code with WhatsApp:
[QR CODE HERE]

✅ Authenticated successfully
🚀 WhatsApp Spam Guard is ready!
📋 Mode: DRY RUN (no deletions)
🔑 Bot number: 1234567890

📊 Found 5 groups:
  👁️ 👑 My Community Group (120363xxx@g.us)
  👁️    Another Group (120363yyy@g.us)
       Old Group (120363zzz@g.us)

👁️ = Monitoring | 👑 = Admin

📨 [My Community Group] John: Check out this crypto investment...
🚨 SPAM DETECTED (92%): Crypto investment promotion
✅ Message deleted for everyone
```

## Spam Detection

### Detection Modes

**Rule-Based Detection** (works without API key):
- Detects WhatsApp group invite links with spam keywords
- Catches trading/forex, crypto, training/course scams
- Identifies MLM/pyramid schemes, gambling, adult content
- High-confidence spam phrases trigger instant detection

**AI Detection** (requires API key):
- **Claude** (Anthropic): Uses Claude Haiku 4.5 for intelligent classification
- **Gemini** (Google): Uses Gemini 2.0 Flash - has free tier!
- Analyzes context and nuance
- Better at edge cases and new spam patterns

Use `AI_PROVIDER=auto` to automatically select available provider (Anthropic preferred).

### What's Detected as Spam

- Unsolicited promotions and advertisements
- Crypto/forex/investment scams
- "Get rich quick" schemes
- Phishing or suspicious links
- Adult content promotions
- Fake giveaways or prizes
- Pyramid schemes / MLM recruitment
- Requests for personal/financial information
- **Group invites** for trading, crypto, training courses

### What's NOT Spam

- Normal conversations
- Questions and answers
- Relevant link sharing
- Admin announcements
- Friendly group banter

### Confidence Threshold

Messages are only deleted if:
- Rule-based: confidence >= 75%
- AI-based: confidence >= 70%

This prevents false positives on borderline messages.

## Deployment

### Render (Recommended)

1. Create a new **Background Worker** on [Render](https://render.com)
2. Connect your GitHub repository
3. Set environment variables in Render dashboard
4. Add a **Disk** for session persistence:
   - Mount path: `/opt/render/project/src/whatsapp-session`
   - Size: 1 GB

### Docker

```dockerfile
FROM node:18-slim

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["npm", "start"]
```

### Important Notes for Cloud Deployment

- **Persistent Storage**: The `whatsapp-session/` directory must persist between restarts
- **Single Instance**: Only run ONE instance to avoid session conflicts
- **Re-authentication**: If session expires, you'll need to scan QR again

## Limitations

- **Admin Required**: Bot must be a group admin to delete messages
- **2-Day Window**: WhatsApp only allows deletion within 2 days of message being sent
- **Unofficial API**: Uses WhatsApp Web automation (not official Business API)
- **Ban Risk**: Excessive automation may trigger WhatsApp's anti-bot measures

## Cost Estimation

| Usage | Claude Haiku Calls | Est. Monthly Cost |
|-------|-------------------|-------------------|
| Light (100 msgs/day) | ~3,000/month | ~$0.50 |
| Medium (500 msgs/day) | ~15,000/month | ~$2.50 |
| Heavy (2000 msgs/day) | ~60,000/month | ~$10.00 |

*Based on Claude Haiku pricing of ~$0.25/1M input tokens*

## License

MIT

## Disclaimer

This tool uses unofficial WhatsApp Web automation. Use at your own risk. The developers are not responsible for any WhatsApp account restrictions that may result from using this software.
