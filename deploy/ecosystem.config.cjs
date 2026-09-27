/**
 * PM2 进程守护（生产）
 * 安装：npm i -g pm2
 * 启动：pm2 start deploy/ecosystem.config.cjs
 * 开机：pm2 save && pm2 startup
 *
 * 抖音代理请写在项目根目录 .env：
 *   DOUYIN_PROXY=http://user:pass@host:port
 * 或 socks5://user:pass@host:port
 */
module.exports = {
  apps: [
    {
      name: 'douyin-frames',
      cwd: __dirname + '/..',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3780,
        // 关闭/换任务后 10 分钟清理；兜底 24h
        CLEANUP_AFTER_RELEASE_MIN: 10,
        CLEANUP_TTL_HOURS: 24,
        CLEANUP_MAX_MB: 4096,
        // 改成你的实际域名
        ALLOWED_ORIGINS: 'https://frames.example.com,https://www.example.com,https://example.com',
      },
    },
  ],
};
