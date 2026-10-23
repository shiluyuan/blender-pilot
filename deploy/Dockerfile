# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.19.0
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /opt/pilot
COPY package.json package-lock.json ./
RUN npm ci
COPY apps ./apps
COPY packages ./packages
COPY tsconfig*.json vite.config.ts ./
RUN npm run build && npm prune --omit=dev
RUN npm install --prefix /opt/codex --omit=dev --no-audit --no-fund @openai/codex@0.164.0

FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production PILOT_DATA=/data PORT=8090
WORKDIR /opt/pilot
COPY --from=build /opt/pilot/package.json ./
COPY --from=build /opt/pilot/node_modules ./node_modules
COPY --from=build /opt/pilot/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8090
CMD ["node", "dist/server/apps/server/index.js"]

FROM ubuntu:24.04 AS studio
ARG BLENDER_VERSION=5.2.3
ARG BLENDER_SHA256=78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production PILOT_DATA=/data \
    DISPLAY=:99 HOME=/home/pilot XDG_RUNTIME_DIR=/tmp/pilot-runtime \
    PATH=/opt/mcp/bin:/opt/codex/node_modules/.bin:/opt/blender:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISABLE_TELEMETRY=true PILOT_ADDON_PATH=/opt/pilot/addon.py
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils python3 python3-venv xvfb x11vnc openbox \
    libgl1 libegl1 libopengl0 libgl1-mesa-dri mesa-utils libxrender1 libxi6 \
    libxfixes3 libxkbcommon0 libsm6 libice6 libxxf86vm1 libxrandr2 libxcursor1 \
    libxinerama1 libdbus-1-3 libglib2.0-0 libfontconfig1 libfreetype6 libasound2t64 \
    fonts-dejavu-core fonts-noto-cjk tini gosu && rm -rf /var/lib/apt/lists/*
RUN test "$(uname -m)" = x86_64 && \
    curl -fL --retry 3 "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" -o /tmp/blender.tar.xz && \
    echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - && \
    mkdir /opt/blender && tar -xJf /tmp/blender.tar.xz --strip-components=1 -C /opt/blender && rm /tmp/blender.tar.xz
COPY deploy/requirements.lock /tmp/requirements.lock
RUN python3 -m venv /opt/mcp && /opt/mcp/bin/pip install --no-cache-dir -r /tmp/requirements.lock
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /opt/codex /opt/codex
WORKDIR /opt/pilot
COPY --from=build /opt/pilot/package.json ./
COPY --from=build /opt/pilot/node_modules ./node_modules
COPY --from=build /opt/pilot/dist/server ./dist/server
COPY deploy/bootstrap.py deploy/studio-entrypoint.sh deploy/studio-session.sh ./
RUN /opt/mcp/bin/python -c "from importlib.resources import files; import shutil; shutil.copyfile(str(files('blender_mcp') / 'bundled' / 'addon.py'), '/opt/pilot/addon.py')" && \
    (getent passwd 1000 >/dev/null && userdel $(getent passwd 1000 | cut -d: -f1) || true) && \
    (getent group 1000 >/dev/null || groupadd -g 1000 pilot) && \
    useradd -m -u 1000 -g 1000 -s /bin/bash pilot && mkdir /data && \
    chown pilot:1000 /data && chmod +x studio-entrypoint.sh studio-session.sh
EXPOSE 8091
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/pilot/studio-entrypoint.sh"]
