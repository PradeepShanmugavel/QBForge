# QBForge — single-container deployment (Express API + built React frontend,
# one process, one origin — see server/index.js's static-serving block).
#
# Debian-based (not alpine): the local code-execution feature needs real
# gcc/g++/python3/javac on the image, and Debian's apt has straightforward,
# well-tested packages for all of them — alpine's musl-based toolchains are
# more prone to subtle compile/runtime differences from what a student's
# actual judge environment would produce.
FROM node:20-bookworm

# ── Compiler toolchains for the local code-execution engine (server/routes/execute.js) ──
# build-essential: gcc/g++ (C/C++)
# python3 + python-is-python3: Python (also aliases `python` -> `python3`,
#   since execute.js's Linux branch calls `python3` directly anyway, but this
#   keeps `python` on PATH too for the Dockerfile's own tooling/scripts)
# default-jdk: javac/java (Java)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      python-is-python3 \
      default-jdk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install dependencies first (better Docker layer caching — only re-runs
# npm install when a package.json actually changes, not on every code edit) ──
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
COPY client/package.json client/package-lock.json ./client/
RUN npm install --omit=dev && \
    cd server && npm install --omit=dev && \
    cd ../client && npm install

# ── Copy source and build the frontend ──────────────────────────────────────
COPY . .
RUN npm run build

# Render (and most hosts) inject PORT at runtime — server/index.js already
# reads process.env.PORT, defaulting to 3001 only for local/no-env runs.
EXPOSE 3001

CMD ["npm", "start"]
