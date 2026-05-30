module.exports = {
  apps: [
    {
      name: 'LaevaBangumi',
      script: 'src/index.js',
      args: '--sync',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 3,
      restart_delay: 3000,
      ignore_watch: ['node_modules', 'data', 'logs'],
    },
  ],
};
