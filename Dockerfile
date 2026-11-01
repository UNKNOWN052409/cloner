# Multi-stage production image for the cloner platform (task 4.0.10).
#
# stages:
#   deps            – npm production dependencies (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,
#                     because playwright's bundled browsers are glibc-only)
#   playwright-deps – the browser layer: system (musl-native) chromium from apk,
#                     wired into playwright's browser registry at the exact
#                     revisions playwright-core/browsers.json expects. Cached
#                     separately so application-code rebuilds never touch it.
#   runtime         – final non-root image (runs as the "node" user)
#
# build:  docker build --target runtime -t cloner-platform:latest .
# run:    docker run -p 4180:4180 cloner-platform:latest   (CMD = API process)

# ---- stage 1: npm dependencies ---------------------------------------------
FROM node:24-alpine AS deps
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- stage 2: playwright browser layer --------------------------------------
FROM node:24-alpine AS playwright-deps
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apk add --no-cache chromium
COPY --from=deps /app/node_modules ./node_modules
# playwright downloads glibc-built browsers that cannot execute on musl
# (execve fails with ENOENT — missing ELF interpreter). Register the
# musl-native system chromium at the registry paths playwright expects:
# the revision comes from the installed playwright-core/browsers.json and
# BOTH known headless-shell layouts are covered (≤1.52 chrome-linux/
# headless_shell, 1.53+ chrome-headless-shell-linux64/chrome-headless-shell).
# playwright passes --headless itself, so the full binary works for both.
RUN node -e "const fs=require('fs'),path=require('path');const browsers=JSON.parse(fs.readFileSync('/app/node_modules/playwright-core/browsers.json','utf8')).browsers;const rev=n=>browsers.find(b=>b.name===n).revision;const targets=['chromium-'+rev('chromium')+'/chrome-linux/chrome','chromium_headless_shell-'+rev('chromium-headless-shell')+'/chrome-linux/headless_shell','chromium_headless_shell-'+rev('chromium-headless-shell')+'/chrome-headless-shell-linux64/chrome-headless-shell'];for(const t of targets){const full='/ms-playwright/'+t;fs.mkdirSync(path.dirname(full),{recursive:true});fs.symlinkSync('/usr/bin/chromium-browser',full);fs.writeFileSync(path.dirname(full)+'/INSTALLATION_COMPLETE','');console.log('registered '+t);}"
# build-time self-test: the browser layer is only valid if chromium launches
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node -e "const {chromium}=require('/app/node_modules/playwright');chromium.launch({headless:true}).then(async b=>{console.log('browser-layer-ok');await b.close();}).catch(e=>{console.error(e.message);process.exit(1);})"

# ---- stage 3: runtime --------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4180 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
# chromium + the fonts/libs it needs; tini for correct signal handling so
# SIGTERM reaches node and the platform drains gracefully.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont tini
COPY --from=playwright-deps /ms-playwright /ms-playwright
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY bin ./bin
COPY platform-ui ./platform-ui
# writable application state, pre-created so named volumes inherit node ownership
RUN mkdir -p artifacts platform-data && chown -R node:node /app
USER node
EXPOSE 4180
ENTRYPOINT ["/sbin/tini", "--"]
# default process = API (compose overrides command for worker/migrator);
# config validation runs FIRST and refuses to boot on invalid environment.
CMD ["sh", "-c", "node src/config-schema.js api && exec node bin/platform.js --port 4180"]
