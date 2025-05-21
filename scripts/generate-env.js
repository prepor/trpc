import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function generateRandomString(length = 32) {
  return randomBytes(length).toString('hex');
}

function generateEnvFile() {
  const envPath = join(process.cwd(), '.env');
  
  // If .env exists, read it to preserve other variables
  let existingEnv = '';
  if (existsSync(envPath)) {
    existingEnv = readFileSync(envPath, 'utf-8');
  }

  // Generate random credentials
  const randomPassword = generateRandomString(16);
  const randomHost = generateRandomString(8);

  // Create new env content
  const newEnvContent = `# Database
DATABASE_URL="postgresql://postgres:${randomPassword}@localhost:5432/trpc?schema=public"

# Next Auth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="${generateRandomString(32)}"

# tRPC
TRPC_HOST="${randomHost}"
TRPC_PASSWORD="${randomPassword}"

# Other environment variables from existing .env
${existingEnv.split('\n')
  .filter(line => !line.startsWith('DATABASE_URL=') && 
                 !line.startsWith('TRPC_HOST=') && 
                 !line.startsWith('TRPC_PASSWORD=') &&
                 !line.startsWith('NEXTAUTH_SECRET='))
  .join('\n')}`;

  // Write the new .env file
  writeFileSync(envPath, newEnvContent.trim() + '\n');
  console.log('✅ .env file has been generated/updated with random credentials');
}

generateEnvFile(); 