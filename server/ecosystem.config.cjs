// PM2-Konfiguration für das Video-Cutter-Backend.
// Start:   pm2 start ecosystem.config.cjs
// Neustart: pm2 reload video-cutter-api
module.exports = {
  apps: [
    {
      name: 'video-cutter-api',
      cwd: __dirname,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      // Zeit, damit laufende ffmpeg-Prozesse sauber beendet werden (SIGTERM-Handler).
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
