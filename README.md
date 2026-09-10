# 🧩 QBForge — Examly Add-Solutions Automation

Give a test name or QB name from the Examly / iamneo portal, and for every
question that already has a solution, generate one in a language you pick
(C, C++, Python, Java, Java17, Java21) — verified against the question's own
real test cases via a local code-execution engine, then reviewed and pushed
back to the portal.

---

## ⚡ Quick Start (local dev)

```bash
# 1. Install all dependencies
npm run install:all

# 2. Setup environment
cp server/.env.example server/.env
# Open server/.env and add your GROQ_API_KEY

# 3. Install the compiler toolchains the local execution engine needs
#    (Python, GCC/G++, a JDK) — see server/routes/execute.js for exactly
#    what it shells out to. On Windows this project's own dev machine used
#    winget; on Linux, see the Dockerfile below for the apt package names.

# 4. Run the app (starts both backend + frontend)
npm run dev
```

Then open **http://localhost:5173** in your browser, and log in with a JWT
token from your Examly portal session (DevTools → Application → Local
Storage → `token`/`accessToken`).

---

## 🔧 Environment Variables (`server/.env`)

| Variable | Description | Example |
|---|---|---|
| `GROQ_API_KEY` | Your Groq API key | `gsk_xxxxxxxxxxxx` |
| `EXAMLY_BASE_URL` | The Examly API base URL | `https://api.examly.io` |
| `SCHOOL_ID` | Your Examly school/tenant id (optional — sent as a header if set) | `041909ab-...` |
| `PORT` | Backend server port | `3001` |

Get a Groq API key at → https://console.groq.com

---

## 🗂️ Project Structure

```
QBForge/
├── server/                      # Node.js + Express backend
│   ├── routes/
│   │   ├── examly.js            # Examly portal API proxy (search, push solutions)
│   │   ├── groq.js              # AI translation/fix routes (Groq)
│   │   └── execute.js           # Local code-execution engine (compile + run test cases)
│   ├── index.js                 # Express entry — also serves the built
│   │                             frontend in production (see Deployment below)
│   ├── .env                     # Your secrets (gitignored)
│   └── .env.example             # Template
│
└── client/                      # React + Vite frontend
    └── src/
        ├── steps/                # Step1Login, Step6AddSolutions (the app's two screens)
        ├── components/           # Shared UI components
        ├── api/                  # API service functions
        ├── utils/                # JWT decoder
        └── store/                # Global state (React Context)
```

---

## 🔄 Workflow

1. **Log in** — paste your Examly JWT (decoded locally, never sent anywhere but your own portal).
2. **Find** — give a test name or QB name. Multiple matches show a picker; you choose the exact one.
3. **Generate** — pick a target language per question (or bulk-select several); a solution is
   translated via Groq, then verified against the question's own real sample/hidden test cases by
   actually compiling and running it locally — not a guess.
4. **Review & push** — inspect the generated code (and, when present, header/footer/code-stub —
   carried forward or translated to match, never invented for a question that didn't have them),
   then push it to the portal.

---

## 🚀 Deployment

The local code-execution engine needs real compiler toolchains (gcc, g++,
python3, javac) installed **on the server** — this rules out serverless
platforms (Vercel/Netlify Functions can't have system packages installed).
Use a host that runs a persistent Docker container instead.

A `Dockerfile` is included — it builds a single container that installs the
toolchains, builds the React frontend, and serves everything (API + static
frontend) from one Express process on one origin.

### Render

1. Push this repo to GitHub (already done if you're reading this on GitHub).
2. On [render.com](https://render.com): **New → Web Service** → connect this repo.
3. **Runtime**: Docker (Render auto-detects the `Dockerfile`).
4. **Environment variables**: add `GROQ_API_KEY` (and `EXAMLY_BASE_URL`/`SCHOOL_ID` if you want
   different defaults than `server/.env.example`'s). Render sets `PORT` itself — no need to set it.
5. Deploy. Render builds the Docker image (installs the toolchains + `npm run build`) and starts
   it with `npm start`.

Any other Docker-friendly host (Railway, Fly.io, a VPS with Docker) works the same way — build
the image from the included `Dockerfile` and run it with `GROQ_API_KEY` set in the environment.

---

## 📡 API Endpoints (Backend)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/examly/tests/search?name=X` | Fuzzy-search tests by name (every match) |
| `GET` | `/api/examly/tests/:name/questions` | Resolve a test name to its full question list |
| `GET` | `/api/examly/questionbanks/search?names=X` | Fuzzy-search QBs by name |
| `GET` | `/api/examly/questionbanks/:id/questions` | Get a QB's full question list |
| `POST` | `/api/examly/questions/:id/solution` | Push a generated solution to a question |
| `POST` | `/api/groq/translate-solution` | AI: translate a solution into another language |
| `POST` | `/api/groq/translate-fragment` | AI: translate a header/footer |
| `POST` | `/api/groq/translate-stub` | AI: translate a code stub (keeps its intentional bug) |
| `POST` | `/api/groq/fix-solution` | AI: fix code using a real local test-execution failure |
| `POST` | `/api/execute/run-tests` | Compile + run code locally against real test cases |
| `GET` | `/health` | Health check |

---

## ⚠️ Notes

- Your JWT token expires — paste a fresh one if you see auth errors.
- `server/token.txt` (used by the two `server/*.js` debug scripts, not the app itself) is
  gitignored on purpose — it holds a real portal token for local experimentation. Never commit it.
