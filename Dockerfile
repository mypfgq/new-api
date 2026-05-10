FROM soulter/astrbot:latest

WORKDIR /AstrBot

# 预装 AstrBot WebUI（避开运行时从 astrbot-registry.soulter.top 下载超时导致 502）
# 版本需与当前镜像内 AstrBot 的 webui 版本一致；如需升级，修改 WEBUI_VERSION 即可
ARG WEBUI_VERSION=v4.24.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl unzip ca-certificates wget; \
    mkdir -p /AstrBot/data; \
    curl -fsSL -o /tmp/dashboard.zip \
        "https://github.com/AstrBotDevs/AstrBot/releases/download/${WEBUI_VERSION}/AstrBot-${WEBUI_VERSION}-dashboard.zip"; \
    unzip -q /tmp/dashboard.zip -d /AstrBot/data; \
    rm -f /tmp/dashboard.zip; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

# WebUI 端口（在 apply.build 后台把此端口设为对外端口）
EXPOSE 6185

# 持久化目录（请在 apply.build 把卷挂到此路径）
VOLUME ["/AstrBot/data"]

# 健康检查：WebUI 正常响应即算健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:6185/ >/dev/null 2>&1 || exit 1

CMD ["python", "main.py"]
