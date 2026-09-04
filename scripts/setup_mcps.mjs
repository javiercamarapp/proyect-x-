import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const homeDir = os.homedir();
const configDir = path.join(homeDir, '.gemini', 'config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

const mcpConfigFile = path.join(configDir, 'mcp_config.json');

// 1. GitHub Token
let ghToken = '';
try {
  ghToken = execSync('gh auth token', { encoding: 'utf8' }).trim();
} catch (e) {
  console.warn('Could not get gh auth token:', e.message);
}

// 2. Vercel Token
let vercelToken = '';
try {
  const vercelAuthPath = path.join(homeDir, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json');
  if (fs.existsSync(vercelAuthPath)) {
    const vercelAuth = JSON.parse(fs.readFileSync(vercelAuthPath, 'utf8'));
    vercelToken = vercelAuth.token || '';
  }
} catch (e) {
  console.warn('Could not get vercel auth token:', e.message);
}

// 3. Supabase URL and Key
let supabaseUrl = 'https://gngoqsvrxdguxvsizpbw.supabase.co';
let supabaseKey = '';
try {
  const envLocalPath = '/Users/javiercamaraportepetit/likida/.env.local';
  if (fs.existsSync(envLocalPath)) {
    const envContent = fs.readFileSync(envLocalPath, 'utf8');
    for (const line of envContent.split('\n')) {
      if (line.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) {
        supabaseKey = line.split('=')[1].trim().replace(/^["']|["']$/g, '');
      } else if (line.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) {
        supabaseUrl = line.split('=')[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (e) {
  console.warn('Could not parse .env.local:', e.message);
}

const config = {
  mcpServers: {
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: ghToken
      }
    },
    vercel: {
      command: 'npx',
      args: ['-y', '@mistertk/vercel-mcp'],
      env: {
        VERCEL_API_TOKEN: vercelToken
      }
    },
    supabase: {
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-postgrest'],
      env: {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_KEY: supabaseKey
      }
    }
  }
};

fs.writeFileSync(mcpConfigFile, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(mcpConfigFile, 0o600);
console.log('MCP config saved successfully at:', mcpConfigFile);
