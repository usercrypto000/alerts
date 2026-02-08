module.exports = {
  apps: [
    {
      name: 'tickr-main',
      script: 'index.js',
      cwd: '.',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 3000
    },
    {
      name: 'tickr-contract',
      script: 'scripts/contract-transfer-monitor.js',
      cwd: '.',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 3000
    }
  ]
};
