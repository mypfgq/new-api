FROM soulter/astrbot:latest

WORKDIR /AstrBot

# AstrBot WebUI 端口（在 apply.build 后台把此端口设为对外端口）
EXPOSE 6185

# 数据目录：请在 apply.build 把持久化卷挂载到此路径
VOLUME ["/AstrBot/data"]

# 健康检查：WebUI 正常响应即算健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:6185/ >/dev/null 2>&1 || exit 1

CMD ["python", "main.py"]
