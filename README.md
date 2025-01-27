# Meteora Sniper

A TypeScript implementation of the Meteora Sniper for monitoring and interacting with Meteora liquidity pools on Solana.

## Setup Instructions

### 1. Initial Repository Setup
```bash
git clone <repository_url>
cd <repository_name>
```

### 2. Environment Setup
Create a `.env` file in the root directory with the following variables:
```env
DB_URL=postgresql://username:password@localhost:5432/meteora_sniper
PORT=3000
HOST=localhost
HELIUS_API_KEY=<your_helius_api_key>
```

### 3. Database Setup

#### Install PostgreSQL
```bash
# For Ubuntu/Debian
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib

# For macOS using Homebrew
brew install postgresql
```

#### Start PostgreSQL Service
```bash
# Ubuntu/Debian
sudo service postgresql start

# macOS
brew services start postgresql
```

#### Create Database and Table
1. Access PostgreSQL:
```bash
psql postgres
```

2. Create database:
```sql
CREATE DATABASE meteora_sniper;
\c meteora_sniper
```

3. Create the required table using the migration file:
```bash
psql meteora_sniper < src/migrations/20250123212232_snipe_config.sql
```

This will create the `snipe_config` table with all required fields for storing snipe configurations.

### 4. Node.js Setup
1. Install Node.js (v16 or higher recommended)
2. Install dependencies and build:
```bash
npm install
npm run build
```

### 5. Starting the Application
```bash
npm start
```

You should see logs indicating:
- Database connection success
- HTTP server starting
- WebSocket connection established

### 6. Testing the Setup

#### Add a Snipe Configuration
```bash
curl -X POST http://localhost:3000/snipe/insert \
-H "Content-Type: application/json" \
-d '{
  "main_wallet": "YOUR_SOLANA_WALLET_ADDRESS",
  "amount_sol": 0.1,
  "amount_usdc": 10,
  "token": "TOKEN_ADDRESS_TO_SNIPE",
  "jito_tip": 0.01
}'
```

#### Verify Configuration
```bash
curl http://localhost:3000/snipe/mine-snipes/YOUR_SOLANA_WALLET_ADDRESS
```

### 7. Troubleshooting

#### Database Connection Errors
- Verify PostgreSQL is running
- Check DB_URL in .env matches your local setup
- Ensure database and table exist

#### Build Errors
- Clear node_modules and package-lock.json
- Run `npm install` again
- Check for TypeScript errors

#### Runtime Errors
- Check all environment variables are set
- Verify Helius API key is valid
- Ensure port 3000 is available

## API Endpoints

### POST /snipe/insert
Creates a new snipe configuration.

Request body:
```json
{
  "main_wallet": "string",
  "amount_sol": number,
  "amount_usdc": number,
  "token": "string",
  "jito_tip": number
}
```

### GET /snipe/mine-snipes/:wallet
Retrieves all snipe configurations for a specific wallet.

## Contributing
1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
