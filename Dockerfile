FROM eceasy/cli-proxy-api:latest

# 设置工作目录
WORKDIR /CLIProxyAPI

# 暴露端口
EXPOSE 8317

# 下载配置模板并直接修改生成最终配置
ADD https://github.com/router-for-me/CLIProxyAPI/raw/refs/heads/main/config.example.yaml /tmp/config.yaml

# 修改配置并安装到目标位置（单条 RUN 避免层问题）
RUN mkdir -p /CLIProxyAPI/config && \
    mkdir -p /root/.cli-proxy-api && \
    chmod 700 /root/.cli-proxy-api && \
    # 修改配置项（allow-remote: false → true, secret-key: "" → "test1234"）
    sed -i 's/allow-remote: false/allow-remote: true/g' /tmp/config.yaml && \
    sed -i 's/secret-key: ""/secret-key: "test1234"/g' /tmp/config.yaml && \
    # 复制到最终位置
    cp /tmp/config.yaml /CLIProxyAPI/config/config.yaml && \
    # 清理临时文件
    rm -f /tmp/config.yaml

# 设置启动命令（默认使用内置配置）
CMD ["--config", "/CLIProxyAPI/config/config.yaml"]
