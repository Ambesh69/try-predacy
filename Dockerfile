# Repo-root Dockerfile for the Predacy relayer (Railway).
#
# Builds the relayer's TypeScript and ships the snarkjs circuit artifacts
# at `/circuits/` so `USE_REAL_ZK=true` works in production. The relayer's
# `config.ts` resolves circuits at `<projectRoot>/circuits/` where
# projectRoot = path.resolve(__dirname, "../..") which evaluates to `/`
# in the container — hence circuits are copied to `/circuits/`.

FROM node:20-slim

WORKDIR /app

# 1. Install deps from package.json + lockfile only (best build cache).
COPY relayer/package.json relayer/package-lock.json* ./
RUN npm install --production=false

# 2. Bring in the relayer source.
COPY relayer/ ./

# 3. Bring in the circuits/ directory at /circuits/ where the relayer
#    code expects them. Excludes the large `pot14_*.ptau` trusted-setup
#    artifacts (only needed at ceremony time, not runtime) per .dockerignore.
COPY circuits/ /circuits/

# 4. Build TypeScript.
RUN npm run build

EXPOSE 3001

CMD ["node", "dist/index.js"]
