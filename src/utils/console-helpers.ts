import * as readline from 'readline';

export async function confirmFromUser(question: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(question + ' (y/n) ', (answer) => {
            rl.close();
            if (answer.toLowerCase() === 'y') {
                resolve();
            } else if (answer.toLowerCase() === 'n') {
                reject("User declined");
            } else {
                reject("Invalid input");
            }
        });
    });
}

export async function getNumericInput(question: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(question + ' ', (answer) => {
            rl.close();
            const num = Number(answer);
            if (isNaN(num)) {
                reject("Invalid input");
            } else {
                resolve(num);
            }
        });
    });
}


export async function getNumericInputWithDefault(question: string, defaultValue: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(question + ` (default: ${defaultValue}): `, (answer) => {
            rl.close();
            if (answer.trim() === "") {
                resolve(defaultValue);
            } else {
                const num = Number(answer);
                if (isNaN(num)) {
                    resolve(defaultValue);
                } else {
                    resolve(num);
                }
            }
        });
    });
}

export async function getEnumInput(question: string, options: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(question + ' ', (answer) => {
            rl.close();
            const option = options.find(o => o === answer);
            if (!option) {
                reject("Invalid input");
            } else {
                resolve(option);
            }
        });
    });
}

export async function getStringInput(question: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(question + ' ', (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}