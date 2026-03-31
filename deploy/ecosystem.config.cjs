module.exports = {
  apps: [
    {
      name: 'afk-app',
      cwd: '/opt/afk',
      script: './node_modules/.bin/tsx',
      args: 'server.ts',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
  ],
};
