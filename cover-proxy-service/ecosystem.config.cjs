module.exports = {
  apps: [
    {
      name: 'LaevaCoverProxy',
      script: 'src/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 3010,
        COVER_PROXY_SECRET: process.env.COVER_PROXY_SECRET || '',
        COVER_UPSTREAM_PROXY_URL: process.env.COVER_UPSTREAM_PROXY_URL || '',
        COVER_CACHE_DIR: process.env.COVER_CACHE_DIR || '/var/cache/laeva-covers',
        COVER_ALLOWED_HOSTS: process.env.COVER_ALLOWED_HOSTS || 'lain.bgm.tv,bgm.tv,bangumi.tv,chii.in',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      max_memory_restart: '256M',
      min_uptime: '10s',
      max_restarts: 5,
      restart_delay: 3000,
      ignore_watch: ['node_modules', 'logs'],
    },
  ],
};
