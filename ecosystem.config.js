module.exports = {
  apps: [{
    name: "truk-backend",
    script: "server.js",
    instances: 1,
    watch: false,
    env: {
      NODE_ENV: "production",
      PORT: 8088
    }
  }]
}
