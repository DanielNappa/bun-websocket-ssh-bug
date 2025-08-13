import * as http from 'http';
import { server as WebSocketServer } from 'websocket';
import {
  SshSessionConfiguration,
  SshAlgorithms,
  SshProtocolExtensionNames,
  SshServerSession,
} from '@microsoft/dev-tunnels-ssh';
import { 
  PortForwardingService,
  PortForwardRequestMessage,
} from '@microsoft/dev-tunnels-ssh-tcp';
import { importKey } from '@microsoft/dev-tunnels-ssh-keys';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WebSocketServerStream } from './websocket-stream.js';

const DEFAULT_PORT = 33765;

/**
 * 
 * This server:
 * 1. Creates an HTTP server with WebSocket upgrade support
 * 2. Handles SSH sessions over WebSocket connections
 * 3. Provides port forwarding capabilities
 * 4. Uses P-521 ECDSA cryptography for SSH key exchange
 */

/**
 * Main entry point - parses command line arguments and starts the SSH server
 */
async function main(): Promise<number> {
  try {
    const argv = await yargs(hideBin(process.argv))
      .option('port', {
        alias: 'p',
        type: 'number',
        description: 'Port number to listen on',
        default: DEFAULT_PORT,
      })
      .help()
      .argv;

    const port = argv.port || DEFAULT_PORT;
    console.log(`Starting SSH over WebSocket server on port ${port}`);
    
    await startSshServer(port);
    return 0;
  } catch (error) {
    console.error('Failed to start server:', error);
    return 1;
  }
}

async function startSshServer(port: number): Promise<void> {
  // Configure SSH session with P-521 algorithms (matching SAP Dev Space)
  const config = new SshSessionConfiguration();
  
  // Use P-521 key exchange algorithm (this is what triggers the bug in Bun)
  config.keyExchangeAlgorithms.push(SshAlgorithms.keyExchange.ecdhNistp521Sha512!);
  
  // Support both P-521 and RSA public keys
  config.publicKeyAlgorithms.push(SshAlgorithms.publicKey.ecdsaSha2Nistp521!);
  config.publicKeyAlgorithms.push(SshAlgorithms.publicKey.rsa2048!);
  
  // Use AES-256-GCM encryption
  config.encryptionAlgorithms.splice(0, 0, SshAlgorithms.encryption.aes256Gcm!);
  
  // Enable protocol extensions
  config.protocolExtensions.push(SshProtocolExtensionNames.sessionReconnect);
  config.protocolExtensions.push(SshProtocolExtensionNames.sessionLatency);
  
  // Add port forwarding service
  config.addService(PortForwardingService);

  // Create HTTP server (for WebSocket upgrade)
  const httpServer = http.createServer((request, response) => {
    console.log(`HTTP request: ${request.method} ${request.url}`);
    response.writeHead(404);
    response.end();
  });

  // Start HTTP server
  httpServer.listen(port, () => {
    console.log(`WebSocket server listening on port ${port}`);
  });

  // Create WebSocket server
  const wsServer = new WebSocketServer({
    httpServer: httpServer,
    autoAcceptConnections: false,
  });

  const hostKeys: any[] = [];
  
  // Import P-521 ECDSA private key (dummy key for server initialization)
  const dummyP521Key = `-----BEGIN PRIVATE KEY-----
MIHuAgEAMBAGByqGSM49AgEGBSuBBAAjBIHWMIHTAgEBBEIB56+BQ3cM/5hQaxzL
FntsC8Dyy2Z1ZNBJ5cTrpEKus4e1SUQlEsEJ/Qv0Vrj04j8CJz/uNSjtZsV36Ro6
fWGYAmShgYkDgYYABAHP2h/fkPRft1J6+aHNPCldK+TI6s0ZN0wgtaflPXTT6p6Z
xRnWqiseNWRmgIAQ5DC3gB+/l80V6B6gkYRVOZMaqQD2P6LGxAV6g+kl+Yyipn4h
Ix+aAiD03fS0XkNx37YFb0PUpvDC8MPZKlOOa5nwkzseH25YRZnCN9RPUgyE5z6R
hA==
-----END PRIVATE KEY-----`;

  hostKeys.push(await importKey(dummyP521Key));

  const reconnectableSessions: SshServerSession[] = [];

  // Handle WebSocket connections
  return new Promise<void>((resolve, reject) => {
    wsServer.on('request', (request) => {
      console.log(`WebSocket connection request from: ${request.origin}`);
      
      // Accept WebSocket connection with SSH protocol
      const webSocket = request.accept('ssh');
      console.log('Accepted WebSocket connection with SSH protocol');

      // Create SSH stream wrapper for WebSocket
      const stream = new WebSocketServerStream(webSocket);
      
      // Create SSH server session
      const session = new SshServerSession(config, reconnectableSessions);
      
      // Set host keys (required for server initialization)
      session.credentials.publicKeys = hostKeys;

      // Handle SSH authentication (always allow for port forwarding)
      session.onAuthenticating((e) => {
        console.log('SSH authentication request - automatically approving');
        e.authenticationPromise = Promise.resolve({});
      });

      // Handle SSH requests (approve port forwarding requests)
      session.onRequest((e) => {
        if (e.request instanceof PortForwardRequestMessage) {
          console.log(`Port forward request: ${(e.request as any).host}:${e.request.port}`);
          e.isAuthorized = !!e.principal;
        }
      });

      // Connect SSH session to WebSocket stream
      session
        .connect(stream)
        .then(() => {
          console.log('SSH session connected successfully');
        })
        .catch((error) => {
          console.error(`Failed to connect SSH session: ${error}`);
        });

      // Handle session cleanup
      webSocket.on('close', () => {
        console.log('WebSocket connection closed - cleaning up SSH session');
        session.dispose();
      });
    });
  });
}

// Start the server
main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });