# bun-websocket-ssh-bug

Minimal reproduction of Bun’s WebSocket dropping or fragmenting ~564-byte SSH
handshake frames, breaking SSH-over-WebSocket tunnels. Includes Dockerized
Dropbear server, WS-TCP bridge, and Node.js/Bun clients.
