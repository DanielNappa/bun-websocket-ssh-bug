#!/bin/bash

set -e

echo "=== Bun WebSocket Bug Reproduction Setup ==="
echo

# Clean up any existing keys
echo "Cleaning up existing keys..."
rm -f container-key container-key.pub

# Generate deterministic P-521 keypair on host
echo "Generating P-521 keypair on host..."
ssh-keygen -t ecdsa -b 521 -f container-key -N "" -C "bun-ws-repro"
echo "✓ Generated container-key and container-key.pub"

# Stop and remove existing container
echo "Cleaning up existing container..."
docker stop ssh-server 2>/dev/null || true
docker rm ssh-server 2>/dev/null || true

# Build the Docker image
echo "Building Docker image..."
docker build -t ssh-server  -f Dockerfile.p521 .
echo "✓ Built ssh-server image"

# Start the container
echo "Starting SSH container..."
docker run -d --name ssh-server -p 2223:2223 ssh-server
echo "Started ssh-server container on port 2223"

# Wait for container to be ready
echo "Waiting for SSH server to start..."
sleep 3

# Test direct SSH connection
echo "Testing direct SSH connection..."
if ssh -i ./container-key -p 2223 -o StrictHostKeyChecking=no -o ConnectTimeout=5 user@localhost "echo 'SSH connection successful'" 2>/dev/null; then
    echo "✅ Direct SSH connection works"
else
    echo "❌ Direct SSH connection failed"
    echo "Container logs:"
    docker logs ssh-server
    exit 1
fi

echo
echo "=== Setup Complete ==="
echo " Private key: ./container-key"
echo " Public key:  ./container-key.pub"
echo " Container:   ssh-server (running on port 2223)"
echo
echo "Next steps:"
echo "1. cd server && npm install && npx tsx src/index.ts -p 8080 (runs WebSocket server)"
echo "2. npx tsx repro-client.ts  # (should work with Node.js)"
echo "3. bun run repro-client.ts Change client to Bun and test again"
echo
echo "To test direct SSH: ssh -i ./container-key -p 2223 -o StrictHostKeyChecking=no -o ConnectTimeout=5 user@localhost"
echo "To view logs: docker logs ssh-server"
echo "To stop: docker stop ssh-server"