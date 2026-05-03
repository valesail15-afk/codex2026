FROM node:22-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Install Chromium for Playwright-based scraper fallback.
RUN npx playwright install --with-deps chromium

COPY . .

RUN npm run build

EXPOSE 3001

CMD ["npm", "run", "dev"]
