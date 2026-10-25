# n8n Integration Guide

This guide shows how to connect n8n to your personal Telegram account using the `telegram-mcp` MCP server.

**Important:** This is **not** an official n8n node. n8n does not have a built-in MCP client yet. The integration patterns below use community workarounds.

## Option 1: n8n + MCP via custom node (community)

There are community-maintained MCP client nodes for n8n. Search the n8n community nodes for "MCP" or "Model Context Protocol".

Example workflow:
1. Install an MCP client node from the community
2. Configure it to spawn `npx -y @dikacode/telegram-mcp`
3. Pass credentials via the node's environment configuration

## Option 2: n8n Execute Command node (local development)

For local development, you can use the Execute Command node to run the MCP server as a subprocess and communicate via stdin/stdout.

**Note:** This is a workaround for development only. The MCP protocol requires persistent stdio communication, which Execute Command doesn't natively support.

```json
{
  "command": "npx",
  "args": ["-y", "@dikacode/telegram-mcp"],
  "env": {
    "TELEGRAM_API_ID": "1234567",
    "TELEGRAM_API_HASH": "0123456789abcdef0123456789abcdef"
  }
}
```

## Option 3: HTTP bridge (recommended for production)

Run a local HTTP-to-stdio bridge that exposes the MCP server over HTTP, then call it from n8n's HTTP Request node.

### Using mcp-proxy (community tool)

```bash
# Install a community MCP proxy
npm install -g mcp-proxy

# Run the proxy pointing to telegram-mcp
mcp-proxy --port 3000 -- npx -y @dikacode/telegram-mcp
```

Then in n8n:
1. Add an HTTP Request node
2. URL: `http://localhost:3000/mcp`
3. Method: POST
4. Body: JSON-RPC 2.0 requests

### Using a custom bridge

Create a simple Node.js bridge:

```javascript
// mcp-bridge.js
import { spawn } from 'node:child_process';
import express from 'express';

const app = express();
app.use(express.json());

const mcp = spawn('npx', ['-y', '@dikacode/telegram-mcp'], {
  env: {
    ...process.env,
    TELEGRAM_API_ID: '1234567',
    TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef'
  },
  stdio: ['pipe', 'pipe', 'pipe']
});

mcp.stderr.on('data', d => console.error('[MCP]', d.toString()));

app.post('/mcp', (req, res) => {
  const request = JSON.stringify(req.body) + '\n';
  mcp.stdin.write(request);
  
  // Wait for response (simplified - real impl needs request matching)
  const chunks = [];
  mcp.stdout.once('data', chunk => {
    chunks.push(chunk);
    try {
      res.json(JSON.parse(chunks.join('')));
    } catch {
      res.status(500).send('Invalid JSON-RPC response');
    }
  });
});

app.listen(3000, () => console.log('MCP bridge on :3000'));
```

Run: `node mcp-bridge.js`

## Credentials

Never hardcode credentials in n8n workflows. Use n8n's credential system:

1. Create a credential of type "Environment Variables" (or custom)
2. Reference it in the Execute Command / HTTP Request nodes

## Security considerations

- The MCP server holds your Telegram session — treat it like a password
- Run the bridge on localhost only (`127.0.0.1`)
- Use n8n's built-in credential encryption
- Enable `TELEGRAM_APPROVAL_MODE=destructive` for an extra safety gate
- Run `telegram-mcp dashboard` to monitor activity

## Limitations

- n8n doesn't natively support MCP stdio transport
- Community MCP nodes for n8n are unofficial and may lag behind spec updates
- For production use, consider a dedicated HTTP gateway (not yet shipped with telegram-mcp)

## Feature requests

If you need better n8n integration, please open a feature request at:
https://github.com/dikaglorya/telegram-mcp/issues/new/choose

An official MCP-to-HTTP gateway is on the roadmap (post-1.x) which would enable first-class n8n support.