const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const generateRandomString = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

const envPath = path.join(__dirname, '..', '.env');

if (!fs.existsSync(envPath)) {
  const random = generateRandomString(16);
  const envContent = `# Database connection string
# To transfer this DB to your Neon account follow the link http://localhost:30000/mit?role=neon_owner&mit=mit-${random}
DATABASE_URL="postgresql://neondb_owner:${random}@mit-${random}.localtest.me:4432/neondb?sslmode=require"
`;

  fs.writeFileSync(envPath, envContent);
  console.log('Created .env file with random credentials');
} else {
  console.log('.env file already exists, skipping creation');
} 