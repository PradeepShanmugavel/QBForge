# 📦 TestPack — Examly Test Automation Tool

Automate question selection and test creation on the Examly / iamneo portal using Groq AI.

---

## ⚡ Quick Start

```bash
# 1. Install all dependencies
npm run install:all

# 2. Setup environment
cp server/.env.example server/.env
# Open server/.env and add your GROQ_API_KEY

# 3. Run the app (starts both backend + frontend)
npm run dev
```

Then open **http://localhost:5173** in your browser.

---

## 🔧 Environment Variables (`server/.env`)

| Variable | Description | Example |
|---|---|---|
| `GROQ_API_KEY` | Your Groq API key | `gsk_xxxxxxxxxxxx` |
| `EXAMLY_BASE_URL` | Your Examly portal base URL | `https://admin.neostark872.examly.io` |
| `PORT` | Backend server port | `3001` |

Get your Groq API key at → https://console.groq.com

---

## 🗂️ Project Structure

```
testpack/
├── server/                    # Node.js + Express backend
│   ├── routes/
│   │   ├── examly.js          # Examly API proxy (bypasses CORS)
│   │   └── groq.js            # Groq AI routes
│   ├── index.js               # Express server entry
│   ├── .env                   # Your secrets (gitignored)
│   └── .env.example           # Template
│
└── client/                    # React + Vite frontend
    └── src/
        ├── steps/             # 5-step wizard components
        ├── components/        # Shared UI components
        ├── api/               # API service functions
        ├── utils/             # JWT decoder, Excel parser
        └── store/             # Global state (React Context)
```

---

## 🔄 Workflow

| Step | What happens |
|---|---|
| **1. Login** | Paste your Examly JWT token — decoded locally |
| **2. Configure** | Add topics + set MCQ / COD / DEBUG counts |
| **3. QB List** | Upload Excel with QB names — parsed in browser |
| **4. Match** | Groq AI matches your topics to relevant QBs, fetches questions |
| **5. Pack & Push** | Review questions → create test in your portal |

---

## 📡 API Endpoints (Backend)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/examly/questionbanks` | List all QBs (proxied to Examly) |
| `GET` | `/api/examly/questionbanks/:id/questions` | Get QB questions |
| `POST` | `/api/examly/tests` | Create a test in portal |
| `POST` | `/api/groq/match-qbs` | AI: match topics to QB names |
| `POST` | `/api/groq/select-questions` | AI: select best questions |
| `GET` | `/health` | Health check |

---

## ⚠️ Notes

- The Examly API endpoints in `server/routes/examly.js` use placeholder paths.
  Update them once confirmed from your portal's Network tab.
- Your JWT token expires — paste a fresh one if you see auth errors.
- Excel file: QB names must be in the **first column** of the sheet.
