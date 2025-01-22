import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

let envLoaded = false;

// `process.cwd()` returns the current working directory of the Node.js process.
const envPath = path.resolve(process.cwd(), '.env');

export function loadEnv() {
	if (envLoaded) {
		return;
	}

	dotenv.config({ path: envPath });
	envLoaded = true;
}

export function reloadEnv() {
	dotenv.config({ path: envPath });
	envLoaded = true;
}

export function updateEnvVariable(key: string, value: string): void {
	// Read the existing .env file
	const envFileContent = fs.readFileSync(envPath, 'utf8');

	// Split the file content into lines
	const lines = envFileContent.split('\n');

	let keyExists = false;

	// Find the line with the specified key and update its value
	const updatedLines = lines.map((line) => {
		const [currentKey, ...rest] = line.split('=');
		if (currentKey.trim() === key) {
			keyExists = true;
			if (rest.length > 0) {
				console.log(`📝 Updated .env variable: ${key} from ${rest.join('=')} to ${value}`);
			}
			// Return the updated line
			return `${key}=${value}`;
		}
		// Return the original line if the key does not match
		return line;
	});

	// If the key is not found, append a new line with the key and value
	if (!keyExists) {
		console.log(`📝 Added new .env variable: ${key}=${value}`);
		updatedLines.push(`${key}=${value}`);
	}

	// Join the lines back into a single string
	const updatedEnvFileContent = updatedLines.join('\n');

	// Write the updated content back to the .env file
	fs.writeFileSync(envPath, updatedEnvFileContent);
}

export function clearEnvVariable(key: string): void {
	updateEnvVariable(key, '');
}

// Add BigInt support for JSON serialization
(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};