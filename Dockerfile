# Use the official Node.js 18 image
FROM node:18-slim

# Install dependencies for Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    # Required by puppeteer-extra-plugin-stealth for font fingerprint masking
    fonts-liberation \
    fonts-noto \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
# puppeteer-extra and puppeteer-extra-plugin-stealth are now in package.json
COPY package*.json ./
RUN npm install

# Print Chromium version at build time so you can verify the UA string in the scraper
# matches the actual bundled Chromium version
RUN node -e "const p = require('puppeteer'); console.log('Chromium path:', p.executablePath())" || true

# Copy the rest of the application code
COPY . .

# Expose the scraper server port
EXPOSE 3002

# Start the scraper server
CMD ["node", "scraper-server.js"]
