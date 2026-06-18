# --- build stage ---
FROM node:24.16.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:24.16.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# Directory for exported CSV files (also declared as a volume in compose).
RUN mkdir -p /data/files
ENV FILES_DIR=/data/files

EXPOSE 3991
CMD ["node", "dist/index.js"]
