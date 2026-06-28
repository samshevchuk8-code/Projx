# Portable container image — works on Fly.io, Railway, Cloud Run, a VPS, etc.
# Bring-your-own-key: no API key is baked in; visitors supply their own.
FROM node:20-alpine

WORKDIR /app

# Install production deps first so this layer is cached across code changes.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# server.js reads process.env.PORT (defaults to 3000). Hosts that inject their
# own PORT (Render, Railway, Cloud Run) will override this at runtime.
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
