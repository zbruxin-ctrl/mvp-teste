FROM node:20-slim

# Dependencias de sistema para o Chromium headless
RUN apt-get update && apt-get install -y \
  libglib2.0-0 \
  libnss3 \
  libnspr4 \
  libdbus-1-3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpango-1.0-0 \
  libcairo2 \
  libatspi2.0-0 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

# Instala o Chromium do Playwright (sem --with-deps, pois as deps ja estao acima)
RUN npx playwright install chromium

COPY . .

# Compila TypeScript E copia src/frontend → dist/frontend
RUN npm run build

EXPOSE 3000

# Apenas inicia o servidor (build ja foi feito acima)
CMD ["npm", "run", "serve"]
